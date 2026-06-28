import { PlaywrightCrawler } from "crawlee";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import crypto from "crypto";
import {
  openDb,
  ensureArticleTables,
  getPendingUrls,
  getPendingUrlsForDomains,
  markUrlStatus,
  insertArticle,
  getArticleStats
} from "./db";

const CRAWL_LIMIT = Number(process.env.CRAWL_LIMIT || 100);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2);
const TEST_SOURCE_NAME = process.env.TEST_SOURCE_NAME || "";
const USE_PRIORITY_QUEUE = process.env.USE_PRIORITY_QUEUE !== "false";

const MIN_TEXT_LENGTH = Number(process.env.MIN_TEXT_LENGTH || 500);
const PRIORITY_DOMAINS = [
  "nextbigfuture.com",
  "scitechdaily.com",
  "venturebeat.com",
  "quantumrun.com",
  "futurity.org",
  "pewresearch.org",
  "trendwatching.com",
  "ourworldindata.org",
  "worldbank.org",
  "brookings.edu",
  "piie.com",
  "project-syndicate.org",
  "cepr.org",
  "techcrunch.com",
  "spectrum.ieee.org",
  "restofworld.org",
  "iea.org",
  "resilience.org",
  "wired.com"
];
const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet"
]);
const ARTICLE_BLOCKED_PARTS = [
  "/sponsor/",
  "/sponsored/",
  "/press-release/",
  "/tag/",
  "/category/",
  "/author/",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
  "/login",
  "/signup",
  "/subscribe",
  "/newsletter",
  "/video",
  "/podcast",
  "?s="
];
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
  ".js"
];
const ERROR_PAGE_TITLE_PARTS = [
  "404",
  "page not found",
  "not found",
  "access denied",
  "forbidden",
  "service unavailable",
  "bad gateway"
];
const ERROR_PAGE_TEXT_PARTS = [
  "404 - page not found",
  "404 page not found",
  "the page you requested could not be found",
  "the page you are looking for could not be found",
  "sorry, the page you are looking for does not exist",
  "this page could not be found",
  "access denied",
  "403 forbidden",
  "service unavailable",
  "bad gateway"
];

function cleanText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

function parseDate(raw?: string | null): Date | null {
  if (!raw) return null;

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function extractArticleTextFromDocument(document: Document): string {
  const reader = new Readability(document.cloneNode(true) as Document);
  const article = reader.parse();

  return cleanText(article?.textContent || "");
}

function extractJsonLdDate(jsonLdTexts: string[]): string | null {
  for (const jsonText of jsonLdTexts) {
    try {
      const parsed = JSON.parse(jsonText);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        const graph = Array.isArray(item["@graph"]) ? item["@graph"] : [];
        const candidates = [item, ...graph];

        for (const candidate of candidates) {
          const date =
            candidate.datePublished ||
            candidate.dateCreated ||
            candidate.dateModified;

          if (date) {
            return date;
          }
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }

  return null;
}

async function extractPageData(page: any, url: string) {
  const html = await page.content();

  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  const getMeta = (selector: string): string | null => {
    return document.querySelector(selector)?.getAttribute("content") || null;
  };

  const title = cleanText(
    document.querySelector("h1")?.textContent?.trim() ||
      document.title ||
      ""
  );

  const timeDatetime =
    document.querySelector("time")?.getAttribute("datetime") || null;

  const jsonLdTexts = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  ).map((script) => script.textContent || "");

  const jsonLdDate = extractJsonLdDate(jsonLdTexts);

  const publishedRaw =
    getMeta('meta[property="article:published_time"]') ||
    getMeta('meta[name="date"]') ||
    getMeta('meta[name="pubdate"]') ||
    getMeta('meta[name="publish-date"]') ||
    timeDatetime ||
    jsonLdDate;

  const articleText = extractArticleTextFromDocument(document);
  const fallbackText = cleanText(document.body?.textContent || "");
  const finalText = articleText.length > 300 ? articleText : fallbackText;

  return {
    title,
    publishedDate: parseDate(publishedRaw),
    text: finalText
  };
}

function isObviousErrorPage(title: string, text: string): boolean {
  const normalizedTitle = cleanText(title).toLowerCase();
  const normalizedTextStart = cleanText(text).toLowerCase().slice(0, 1000);

  if (
    ERROR_PAGE_TITLE_PARTS.some((part) => normalizedTitle.includes(part)) &&
    normalizedTitle.length <= 80
  ) {
    return true;
  }

  return ERROR_PAGE_TEXT_PARTS.some((part) =>
    normalizedTextStart.includes(part)
  );
}

async function main() {
  const db = openDb();
  ensureArticleTables(db);

  const pendingUrls = USE_PRIORITY_QUEUE
    ? getPendingUrlsForDomains(
        db,
        CRAWL_LIMIT,
        PRIORITY_DOMAINS,
        TEST_SOURCE_NAME || undefined
      )
    : getPendingUrls(db, CRAWL_LIMIT, TEST_SOURCE_NAME || undefined);

  console.log("Starting Phase 2: Crawl Articles");
  console.log(`Pending selected: ${pendingUrls.length}`);
  console.log(`Crawl limit: ${CRAWL_LIMIT}`);
  console.log(`Max concurrency: ${MAX_CONCURRENCY}`);
  console.log(`Source filter: ${TEST_SOURCE_NAME || "all"}`);
  console.log(`Priority queue only: ${USE_PRIORITY_QUEUE}`);

  if (pendingUrls.length === 0) {
    console.log("No pending URLs to crawl.");
    return;
  }

  const requests = pendingUrls.map((item) => ({
    url: item.url,
    uniqueKey: `article|${item.id}|${item.url}`,
    userData: {
      id: item.id,
      sourceName: item.source_name,
      sourceCategory: item.source_category
    }
  }));

  let crawled = 0;
  let skipped = 0;
  let failed = 0;
  let inserted = 0;

  const crawler = new PlaywrightCrawler({
    maxConcurrency: MAX_CONCURRENCY,
    maxRequestsPerCrawl: CRAWL_LIMIT,

    launchContext: {
      launchOptions: {
        headless: true
      }
    },

    preNavigationHooks: [
      async ({ page }) => {
        await page.route("**/*", (route) => {
          const resourceType = route.request().resourceType();

          if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
            return route.abort();
          }

          return route.continue();
        });
      }
    ],

    async requestHandler({ page, request, log }) {
      const id = request.userData.id as number;
      const sourceName = request.userData.sourceName as string;
      const sourceCategory = request.userData.sourceCategory as string | null;

      if (shouldSkipArticleUrl(request.url)) {
        skipped++;
        markUrlStatus(db, id, "skipped", "Skipped non-article URL");
        return;
      }

      log.info(`[ARTICLE] ${request.url}`);

      try {
        const pageData = await extractPageData(page, request.url);

        if (isObviousErrorPage(pageData.title, pageData.text)) {
          skipped++;
          markUrlStatus(
            db,
            id,
            "skipped",
            `Skipped obvious error page: ${pageData.title || "Untitled"}`
          );
          return;
        }

        if (!pageData.title || pageData.text.length < MIN_TEXT_LENGTH) {
          skipped++;
          markUrlStatus(
            db,
            id,
            "skipped",
            `Text too short or missing title. Text length: ${pageData.text.length}`
          );
          return;
        }

        const contentHash = hashText(pageData.text);

        const ok = insertArticle(db, {
          url: request.url,
          sourceName,
          sourceCategory,
          title: pageData.title,
          publishedDate: pageData.publishedDate
            ? pageData.publishedDate.toISOString()
            : null,
          text: pageData.text,
          contentHash
        });

        if (ok) inserted++;

        crawled++;
        markUrlStatus(db, id, "crawled");

        log.info(`[SAVED] ${pageData.title}`);
      } catch (err: any) {
        const message = err?.stack || err?.message || String(err);

        failed++;
        markUrlStatus(db, id, "failed", message);
        log.warning(`[FAILED ARTICLE] ${request.url}`);
        log.warning(message);
      }
    },

    failedRequestHandler({ request, log }) {
      const id = request.userData.id as number;
      failed++;
      markUrlStatus(db, id, "failed", "Crawlee failed request");
      log.warning(`[FAILED REQUEST] ${request.url}`);
    }
  });

  await crawler.run(requests);

  const stats = getArticleStats(db);

  console.log("\nDone Phase 2.");
  console.log(`Crawled: ${crawled}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Inserted articles: ${inserted}`);
  console.log(`Total articles in DB: ${stats.total}`);

  console.log("Articles by source:");
  for (const row of stats.bySource) {
    console.log(`- ${row.source_name}: ${row.count}`);
  }

  console.log("\nSaved DB: ./data/crawler.db");
}

function shouldSkipArticleUrl(url: string): boolean {
  const u = url.toLowerCase();

  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    const lastThree = parts.slice(-3).join("/");

    if (/^20\d{2}\/\d{2}\/\d{2}$/.test(lastThree)) {
      return true;
    }
  } catch {
    return true;
  }

  if (ARTICLE_BLOCKED_PARTS.some((part) => u.includes(part))) {
    return true;
  }

  if (ARTICLE_BLOCKED_EXTENSIONS.some((ext) => u.endsWith(ext))) {
    return true;
  }

  return false;
}

main().catch((err) => {
  console.error("Fatal error:", err);
});
