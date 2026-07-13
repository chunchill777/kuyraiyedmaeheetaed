import { PlaywrightCrawler } from "crawlee";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type Database from "better-sqlite3";

import {
  ensureArticleTables,
  findArticleIdByIdentity,
  getArticleStats,
  getPendingUrls,
  insertArticle,
  insertRejectedPage,
  linkSourceJobUrlArticle,
  markUrlStatus,
  openDb
} from "./db";
import {
  canonicalizeUrl,
  hashNormalizedContent,
  parseDeterministicDate,
  validateArticleCandidate
} from "./articleQuality";
import { isLikelyListingPageUrl, isSameDomain } from "./discover";
import {
  isPrivateOrLocalHostname,
  isResolvedPublicHttpUrl
} from "./urlSafety";
import { createEphemeralCrawlerConfiguration } from "./crawlerConfiguration";

const DEFAULT_CRAWL_LIMIT = Number(
  process.env.CRAWL_BATCH_SIZE || process.env.CRAWL_LIMIT || 100
);
const DEFAULT_MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2);
const DEFAULT_DAYS_BACK = Number(process.env.DAYS_BACK || 365);
const MIN_TEXT_LENGTH = Number(process.env.MIN_TEXT_LENGTH || 700);
const MIN_WORD_COUNT = Number(process.env.MIN_WORD_COUNT || 100);

const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet"
]);

const ARTICLE_BLOCKED_SEGMENTS = new Set([
  "sponsor",
  "sponsored",
  "press-release",
  "tag",
  "tags",
  "category",
  "categories",
  "author",
  "authors",
  "about",
  "contact",
  "privacy",
  "terms",
  "login",
  "signin",
  "signup",
  "subscribe",
  "newsletter",
  "video",
  "podcast",
  "search"
]);

const ARTICLE_BLOCKED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",
  ".pdf",
  ".zip",
  ".mp4",
  ".mp3",
  ".css",
  ".js",
  ".xml",
  ".rss"
];

const CLUTTER_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "nav",
  "aside",
  "footer",
  "form",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[aria-hidden='true']",
  ".newsletter",
  ".related-posts",
  ".recommended",
  ".social-share",
  ".share-tools"
].join(",");

const ARTICLE_JSON_LD_TYPES = new Set([
  "article",
  "newsarticle",
  "analysisnewsarticle",
  "blogposting",
  "report",
  "scholarlyarticle",
  "techarticle"
]);

type JsonLdArticle = {
  headline: string | null;
  datePublished: string | null;
  matched: boolean;
};

export type PageData = {
  title: string;
  publishedDate: Date | null;
  publishedDateSource: string | null;
  text: string;
  canonicalUrl: string | null;
  finalUrl: string;
  extractionMethod: "readability";
  isArticleDocument: boolean;
};

export type CrawlArticlesOptions = {
  db?: Database.Database;
  limit?: number;
  maxConcurrency?: number;
  sourceName?: string;
  sourceId?: number;
  sourceJobId?: number;
  daysBack?: number;
};

export type CrawlRunStats = {
  selected: number;
  crawled: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  failed: number;
  pendingAfter: number;
};

function cleanInlineText(text: string | null | undefined): string {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(raw?: string | null): Date | null {
  return parseDeterministicDate(raw);
}

function getMeta(document: Document, selector: string): string | null {
  return document.querySelector(selector)?.getAttribute("content")?.trim() || null;
}

function jsonLdNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  if (!value || typeof value !== "object") return [];

  const item = value as Record<string, unknown>;
  const graph = Array.isArray(item["@graph"])
    ? item["@graph"].flatMap(jsonLdNodes)
    : [];
  return [item, ...graph];
}

function isArticleJsonLdNode(node: Record<string, unknown>): boolean {
  const rawTypes = Array.isArray(node["@type"])
    ? node["@type"]
    : [node["@type"]];

  return rawTypes.some(
    (value) =>
      typeof value === "string" && ARTICLE_JSON_LD_TYPES.has(value.toLowerCase())
  );
}

function extractJsonLdArticle(document: Document): JsonLdArticle {
  let headlineFallback: string | null = null;

  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  )) {
    try {
      const parsed = JSON.parse(script.textContent || "");

      for (const node of jsonLdNodes(parsed)) {
        if (!isArticleJsonLdNode(node)) continue;

        const headline =
          typeof node.headline === "string" ? cleanInlineText(node.headline) : null;
        // dateModified is intentionally excluded: it cannot prove a page was
        // published inside the requested backfill window.
        const datePublished =
          typeof node.datePublished === "string"
            ? node.datePublished
            : null;

        if (headline && !headlineFallback) headlineFallback = headline;
        if (datePublished) {
          return {
            headline: headline || headlineFallback,
            datePublished,
            matched: true
          };
        }
      }
    } catch {
      // Invalid JSON-LD is ignored; deterministic validation will quarantine a
      // page that has no other trustworthy publication date.
    }
  }

  return {
    headline: headlineFallback,
    datePublished: null,
    matched: Boolean(headlineFallback)
  };
}

function removeDocumentClutter(document: Document) {
  for (const element of Array.from(document.querySelectorAll(CLUTTER_SELECTORS))) {
    element.remove();
  }
}

export function extractArticleDataFromHtml(
  html: string,
  finalUrl: string,
  requestedUrl = finalUrl
): PageData {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  const jsonLd = extractJsonLdArticle(document);

  const publishedCandidates: Array<[string, string | null]> = [
    ["meta:article:published_time", getMeta(document, 'meta[property="article:published_time"]')],
    ["meta:datePublished", getMeta(document, 'meta[itemprop="datePublished"]')],
    ["meta:pubdate", getMeta(document, 'meta[name="pubdate"]')],
    ["meta:publish-date", getMeta(document, 'meta[name="publish-date"]')],
    ["jsonld:datePublished", jsonLd.datePublished]
  ];

  const published = publishedCandidates.find(([, raw]) => Boolean(parseDate(raw)));
  removeDocumentClutter(document);

  const reader = new Readability(document.cloneNode(true) as Document);
  const readable = reader.parse();
  const text = readable?.textContent?.trim() || "";
  const title = cleanInlineText(
    jsonLd.headline ||
      getMeta(document, 'meta[property="og:title"]') ||
      getMeta(document, 'meta[name="twitter:title"]') ||
      readable?.title ||
      document.querySelector("article h1, main h1, h1")?.textContent ||
      document.title
  );

  const canonicalRaw =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") || finalUrl;
  let canonicalUrl = canonicalizeUrl(new URL(canonicalRaw, finalUrl).toString());
  if (canonicalUrl && !isSameDomain(canonicalUrl, requestedUrl)) canonicalUrl = null;

  return {
    title,
    publishedDate: parseDate(published?.[1]),
    publishedDateSource: published?.[0] || null,
    text,
    canonicalUrl: canonicalUrl || canonicalizeUrl(finalUrl),
    finalUrl,
    extractionMethod: "readability",
    isArticleDocument:
      jsonLd.matched ||
      /^(?:article|newsarticle|blogposting)$/i.test(
        getMeta(document, 'meta[property="og:type"]') || ""
      )
  };
}

async function extractPageData(page: any, requestedUrl: string): Promise<PageData> {
  const html = await page.content();
  const finalUrl = page.url() || requestedUrl;
  return extractArticleDataFromHtml(html, finalUrl, requestedUrl);
}

export function shouldSkipArticleUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const segments = path.toLowerCase().split("/").filter(Boolean);
  const suffix = path.split("/").filter(Boolean).slice(-3).join("/");

  if (/^20\d{2}\/\d{1,2}\/\d{1,2}$/.test(suffix)) return true;
  if (isLikelyListingPageUrl(url)) return true;
  if (segments.some((segment) => ARTICLE_BLOCKED_SEGMENTS.has(segment))) return true;
  if (parsed.searchParams.has("s")) return true;
  if (ARTICLE_BLOCKED_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
    return true;
  }

  return false;
}

function pendingCount(
  db: Database.Database,
  options: Pick<CrawlArticlesOptions, "sourceName" | "sourceId" | "sourceJobId">
): number {
  if (options.sourceJobId !== undefined) {
    const row = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM source_job_urls
        WHERE source_job_id = ? AND status = 'pending'
      `)
      .get(options.sourceJobId) as { count: number };
    return row.count;
  }

  const where = ["status = 'pending'"];
  const params: Array<string | number> = [];

  if (options.sourceName) {
    where.push("source_name LIKE ?");
    params.push(`%${options.sourceName}%`);
  }
  if (options.sourceId !== undefined) {
    where.push("source_id = ?");
    params.push(options.sourceId);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM urls WHERE ${where.join(" AND ")}`)
    .get(...params) as { count: number };
  return row.count;
}

export async function crawlArticles(
  options: CrawlArticlesOptions = {}
): Promise<CrawlRunStats> {
  const ownsDb = !options.db;
  const db = options.db || openDb();
  const limit = options.limit ?? DEFAULT_CRAWL_LIMIT;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const daysBack = options.daysBack ?? DEFAULT_DAYS_BACK;

  for (const [name, value] of [
    ["crawl limit", limit],
    ["max concurrency", maxConcurrency],
    ["days back", daysBack]
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (!Number.isInteger(MIN_TEXT_LENGTH) || MIN_TEXT_LENGTH < 500) {
    throw new Error("MIN_TEXT_LENGTH must be an integer of at least 500");
  }
  if (!Number.isInteger(MIN_WORD_COUNT) || MIN_WORD_COUNT < 50) {
    throw new Error("MIN_WORD_COUNT must be an integer of at least 50");
  }

  ensureArticleTables(db);

  try {
    const pendingUrls = getPendingUrls(db, limit, options.sourceName, {
      sourceId: options.sourceId,
      sourceJobId: options.sourceJobId
    });

    const stats: CrawlRunStats = {
      selected: pendingUrls.length,
      crawled: 0,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      failed: 0,
      pendingAfter: 0
    };

    console.log("Starting Phase 2: Crawl + deterministic quality gate");
    console.log(`Pending selected: ${pendingUrls.length}`);
    console.log(`Source: ${options.sourceName || "all"}`);
    console.log(`Source job: ${options.sourceJobId ?? "none"}`);
    console.log(`Days back: ${daysBack}`);

    if (pendingUrls.length === 0) {
      stats.pendingAfter = pendingCount(db, options);
      return stats;
    }

    const requests = pendingUrls.map((item) => ({
      url: item.url,
      uniqueKey: `article|${item.id}|${item.url}`,
      userData: {
        id: item.id,
        sourceName: item.source_name,
        sourceCategory: item.source_category,
        sourceId: item.source_id ?? options.sourceId ?? null,
        sourceJobId: item.source_job_id ?? options.sourceJobId ?? null
      }
    }));

    const crawler = new PlaywrightCrawler({
      maxConcurrency,
      maxRequestsPerCrawl: limit,
      maxRequestRetries: 2,
      launchContext: { launchOptions: { headless: true } },
      preNavigationHooks: [
        async ({ page }) => {
          await page.route("**/*", async (route) => {
            if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
              return route.abort();
            }
            if (!(await isResolvedPublicHttpUrl(route.request().url()))) {
              return route.abort();
            }
            return route.continue();
          });
        }
      ],

      async requestHandler(context) {
        const { page, request, log } = context;
        const id = request.userData.id as number;
        const sourceName = request.userData.sourceName as string;
        const sourceCategory = request.userData.sourceCategory as string | null;
        const sourceId = request.userData.sourceId as number | null;
        const sourceJobId = request.userData.sourceJobId as number | null;

        const reject = (
          reasonCode: string,
          details: unknown,
          pageData?: Partial<PageData>
        ) => {
          stats.rejected++;
          insertRejectedPage(db, {
            urlId: id,
            sourceId,
            sourceJobId,
            url: pageData?.finalUrl || request.url,
            stage: "article_quality",
            reasonCode,
            reasonDetails:
              typeof details === "string" ? details : JSON.stringify(details),
            title: pageData?.title || null,
            publishedDate: pageData?.publishedDate?.toISOString() || null,
            textLength: pageData?.text?.length || 0,
            contentHash: pageData?.text
              ? hashNormalizedContent(pageData.text)
              : null
          });
          markUrlStatus(
            db,
            id,
            "skipped",
            `${reasonCode}: ${JSON.stringify(details)}`,
            sourceJobId ?? undefined
          );
        };

        if (shouldSkipArticleUrl(request.url)) {
          reject("NON_ARTICLE_URL", { url: request.url });
          return;
        }

        log.info(`[ARTICLE] ${request.url}`);

        try {
          const response = (context as any).response;
          if (!response) {
            reject("MISSING_HTTP_RESPONSE", { url: request.url });
            return;
          }
          const status = response.status();
          const headers = await response.headers();
          const contentType = String(headers["content-type"] || "").toLowerCase();
          const serverAddress = await response.serverAddr();

          if (status < 200 || status >= 400) {
            reject("HTTP_STATUS", { status });
            return;
          }
          if (!contentType || !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
            reject("NON_HTML_RESPONSE", { contentType: contentType || "missing" });
            return;
          }
          if (
            !serverAddress ||
            isPrivateOrLocalHostname(serverAddress.ipAddress)
          ) {
            reject("NON_PUBLIC_RESPONSE_ADDRESS", {
              address: serverAddress?.ipAddress || "missing"
            });
            return;
          }

          const pageData = await extractPageData(page, request.url);
          if (!isSameDomain(pageData.finalUrl, request.url)) {
            reject(
              "CROSS_DOMAIN_REDIRECT",
              { requestedUrl: request.url, finalUrl: pageData.finalUrl },
              pageData
            );
            return;
          }
          if (shouldSkipArticleUrl(pageData.finalUrl)) {
            reject("NON_ARTICLE_FINAL_URL", { finalUrl: pageData.finalUrl }, pageData);
            return;
          }
          if (!pageData.isArticleDocument) {
            reject(
              "MISSING_ARTICLE_DOCUMENT_SIGNAL",
              { required: "Article JSON-LD or og:type=article" },
              pageData
            );
            return;
          }
          const quality = validateArticleCandidate(
            {
              url: pageData.canonicalUrl || pageData.finalUrl,
              title: pageData.title,
              publishedDate: pageData.publishedDate,
              text: pageData.text
            },
            {
              daysBack,
              minTextLength: MIN_TEXT_LENGTH,
              minWordCount: MIN_WORD_COUNT
            }
          );

          if (!quality.accepted) {
            reject(
              quality.rejectionCodes[0] || "QUALITY_REJECTED",
              {
                allCodes: quality.rejectionCodes,
                qualityScore: quality.qualityScore,
                metrics: quality.metrics,
                publishedDateSource: pageData.publishedDateSource,
                extractionMethod: pageData.extractionMethod
              },
              pageData
            );
            return;
          }

          const inserted = insertArticle(db, {
            url: pageData.finalUrl,
            canonicalUrl: quality.canonicalUrl,
            sourceName,
            sourceCategory,
            sourceId,
            sourceJobId,
            title: pageData.title,
            publishedDate: quality.publishedDate,
            text: quality.cleanedText,
            contentHash: quality.contentHash,
            qualityScore: quality.qualityScore
          });

          if (inserted) stats.inserted++;
          else stats.duplicates++;

          if (sourceJobId !== null) {
            const articleId = findArticleIdByIdentity(db, {
              url: pageData.finalUrl,
              canonicalUrl: quality.canonicalUrl,
              contentHash: quality.contentHash
            });
            if (!articleId || !linkSourceJobUrlArticle(db, sourceJobId, id, articleId)) {
              throw new Error("Accepted article could not be linked to its source job URL");
            }
          }

          stats.crawled++;
          markUrlStatus(
            db,
            id,
            "crawled",
            inserted ? undefined : "Duplicate canonical URL or content hash",
            sourceJobId ?? undefined
          );
          log.info(`[ACCEPTED] ${pageData.title}`);
        } catch (error: any) {
          const message = error?.stack || error?.message || String(error);
          stats.failed++;
          markUrlStatus(db, id, "failed", message, sourceJobId ?? undefined);
          log.warning(`[FAILED ARTICLE] ${request.url}: ${message}`);
        }
      },

      failedRequestHandler({ request, log }) {
        const id = request.userData.id as number;
        const sourceJobId = request.userData.sourceJobId as number | null;
        stats.failed++;
        markUrlStatus(
          db,
          id,
          "failed",
          "Crawlee failed after retries",
          sourceJobId ?? undefined
        );
        log.warning(`[FAILED REQUEST] ${request.url}`);
      }
    }, createEphemeralCrawlerConfiguration());

    await crawler.run(requests);
    stats.pendingAfter = pendingCount(db, options);

    const articleStats = getArticleStats(db);
    console.log("\nDone Phase 2.");
    console.log(JSON.stringify(stats, null, 2));
    console.log(`Total accepted articles: ${articleStats.total}`);
    return stats;
  } finally {
    if (ownsDb) db.close();
  }
}

export async function main() {
  await crawlArticles({
    limit: DEFAULT_CRAWL_LIMIT,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    sourceName: process.env.TEST_SOURCE_NAME || undefined,
    sourceId: process.env.SOURCE_ID ? Number(process.env.SOURCE_ID) : undefined,
    sourceJobId: process.env.SOURCE_JOB_ID
      ? Number(process.env.SOURCE_JOB_ID)
      : undefined,
    daysBack: DEFAULT_DAYS_BACK
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  });
}
