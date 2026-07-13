import { PlaywrightCrawler } from "crawlee";
import { gunzipSync } from "node:zlib";
import { Source, DiscoveredUrl } from "./types";
import {
  isPrivateOrLocalHostname,
  isResolvedPublicHttpUrl
} from "./urlSafety";
import { createEphemeralCrawlerConfiguration } from "./crawlerConfiguration";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const MAX_SITEMAP_URLS = positiveIntegerEnv("MAX_SITEMAP_URLS", 50000);
const MAX_SITEMAP_FILES = positiveIntegerEnv("MAX_SITEMAP_FILES", 1000);
const MAX_SITEMAP_DEPTH = positiveIntegerEnv("MAX_SITEMAP_DEPTH", 8);
const MAX_SITEMAP_DOWNLOAD_BYTES = positiveIntegerEnv(
  "MAX_SITEMAP_DOWNLOAD_BYTES",
  50 * 1024 * 1024
);
const MAX_SITEMAP_UNCOMPRESSED_BYTES = positiveIntegerEnv(
  "MAX_SITEMAP_UNCOMPRESSED_BYTES",
  100 * 1024 * 1024
);
const MAX_LISTING_REQUESTS = positiveIntegerEnv("MAX_LISTING_REQUESTS", 500);
const MAX_CONCURRENCY = positiveIntegerEnv("MAX_CONCURRENCY", 2);
const DEFAULT_DISCOVERY_DAYS_BACK = 365;
const MAX_PAGINATION_LINKS_PER_PAGE = positiveIntegerEnv(
  "MAX_PAGINATION_LINKS_PER_PAGE",
  10
);
const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet"
]);
const BLOCKED_PATH_SEGMENTS = new Set([
  "login",
  "signin",
  "signup",
  "subscribe",
  "subscription",
  "privacy",
  "terms",
  "about",
  "contact",
  "advertise",
  "newsletter",
  "author",
  "authors",
  "tag",
  "tags",
  "video",
  "videos",
  "podcast",
  "podcasts",
  "events",
  "event",
  "careers",
  "jobs",
  "shop",
  "cart",
  "account",
  "search"
]);
const BLOCKED_URL_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
  ".zip",
  ".mp4",
  ".mp3",
  ".avi",
  ".mov",
  ".css",
  ".js",
  ".ico"
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateParts(date: Date) {
  const yyyy = String(date.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = pad2(date.getMonth() + 1);
  const m = String(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const d = String(date.getDate());

  return {
    yyyy,
    yy,
    mm,
    m,
    dd,
    d,
    date: `${yyyy}-${mm}-${dd}`
  };
}

function renderTemplate(template: string, date: Date): string {
  const parts = formatDateParts(date);

  return template
    .replaceAll("{yyyy}", parts.yyyy)
    .replaceAll("{yy}", parts.yy)
    .replaceAll("{mm}", parts.mm)
    .replaceAll("{m}", parts.m)
    .replaceAll("{dd}", parts.dd)
    .replaceAll("{d}", parts.d)
    .replaceAll("{date}", parts.date);
}

export type SitemapEntry = {
  loc: string;
  lastmod: string | null;
};

/** Decode the small XML entity surface that can occur inside sitemap tags. */
export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|quot|apos|lt|gt);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        const codePoint = Number.parseInt(decimal, 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }

      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }

      const named: Record<string, string> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">"
      };

      return named[entity.toLowerCase()] ?? entity;
    }
  );
}

function cleanXmlText(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i);
  return decodeXmlEntities((cdata?.[1] ?? value).trim());
}

function extractTagValue(xml: string, tag: string): string | null {
  const match = xml.match(
    new RegExp(
      `<(?:[a-z_][\\w.-]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z_][\\w.-]*:)?${tag}\\s*>`,
      "i"
    )
  );

  return match?.[1] !== undefined ? cleanXmlText(match[1]) : null;
}

/**
 * Parse <url> or <sitemap> entries, including namespace-prefixed XML. Keeping
 * lastmod paired with loc is important: extracting all tags independently can
 * apply the date from one URL to a different URL in a partially malformed file.
 */
export function extractSitemapEntries(
  xml: string,
  entryTag: "url" | "sitemap" = "url"
): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const blockPattern = new RegExp(
    `<(?:[a-z_][\\w.-]*:)?${entryTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z_][\\w.-]*:)?${entryTag}\\s*>`,
    "gi"
  );

  for (const match of xml.matchAll(blockPattern)) {
    const block = match[1];
    if (block === undefined) continue;

    const loc = extractTagValue(block, "loc");
    if (!loc) continue;

    entries.push({
      loc,
      lastmod: extractTagValue(block, "lastmod")
    });
  }

  return entries;
}

export function getBaseUrl(source: Source): string {
  const raw =
    source.baseUrl ||
    source.homepageUrl ||
    source.startUrls?.[0] ||
    source.sitemapUrls?.[0] ||
    source.feedUrl;

  if (!raw) {
    throw new Error(
      `Missing baseUrl/homepageUrl/startUrls/sitemapUrls for ${source.name}`
    );
  }

  const url = new URL(raw);
  return `${url.protocol}//${url.hostname}`;
}

export function getFromDate(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d;
}

export function getDiscoveryCutoff(
  daysBack = DEFAULT_DISCOVERY_DAYS_BACK,
  now = new Date()
): Date {
  const safeDaysBack = Number.isFinite(daysBack)
    ? Math.max(0, Math.floor(daysBack))
    : DEFAULT_DISCOVERY_DAYS_BACK;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - safeDaysBack);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

function getMonthDatesBack(daysBack: number): Date[] {
  const fromDate = getFromDate(daysBack);
  const now = new Date();

  const months: Date[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);

  while (cursor >= end) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() - 1);
  }

  return months;
}

function getDayDatesBack(daysBack: number): Date[] {
  const dates: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const end = getFromDate(daysBack);
  end.setHours(0, 0, 0, 0);

  while (cursor >= end) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }

  return dates;
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    const targetHostname = normalizeHostname(target.hostname);
    const baseHostname = normalizeHostname(base.hostname);

    return (
      targetHostname === baseHostname ||
      targetHostname.endsWith(`.${baseHostname}`)
    );
  } catch {
    return false;
  }
}

export function shouldSkipUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    const path = parsed.pathname.toLowerCase();
    const segments = path.split("/").filter(Boolean);
    if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) return true;
    if (parsed.searchParams.has("s")) return true;
    if (BLOCKED_URL_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  } catch {
    return true;
  }

  return false;
}

export function normalizeDiscoveredUrl(url: string, relativeTo?: string): string | null {
  try {
    const normalized = new URL(url, relativeTo);
    if (!/^https?:$/.test(normalized.protocol)) return null;

    normalized.hash = "";

    for (const key of [...normalized.searchParams.keys()]) {
      if (
        /^(?:utm_(?:source|medium|campaign|term|content|id)|fbclid|gclid|mc_cid|mc_eid)$/i.test(
          key
        )
      ) {
        normalized.searchParams.delete(key);
      }
    }

    return normalized.toString();
  } catch {
    return null;
  }
}

/** Reject obvious collection/pagination URLs before they enter the article queue. */
export function isLikelyListingPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const lowerPath = path.toLowerCase();

    if (path === "/") return true;
    if (/\/(?:page|paged)\/\d+$/.test(lowerPath)) return true;
    if (/\/(?:archives?|archive-list|sitemap)(?:\/|$)/.test(lowerPath)) return true;
    if (/(?:^|\/)20\d{2}(?:\/\d{1,2})?(?:\/\d{1,2})?$/.test(lowerPath)) {
      return true;
    }
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:news|newsroom|articles?|stories|latest|updates|insights|resources|publications|category|categories|topics?|blog|press|press-releases?)$/.test(lowerPath)) {
      return true;
    }

    for (const key of ["page", "paged"]) {
      if (/^\d+$/.test(parsed.searchParams.get(key) || "")) return true;
    }

    return false;
  } catch {
    return true;
  }
}

export function isPaginationLink(params: {
  url: string;
  rel?: string;
  text?: string;
}): boolean {
  const rel = (params.rel || "").toLowerCase().split(/\s+/);
  if (rel.includes("next") || rel.includes("prev")) return true;

  const text = (params.text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (/^(?:next|previous|prev|older|newer)(?:\s+(?:page|posts?|articles?))?\s*[›»→]?$/i.test(text)) {
    return true;
  }
  if (/^(?:›|»|→|‹|«|←)$/.test(text)) return true;

  return isLikelyListingPageUrl(params.url) && (
    /\/(?:page|paged)\/\d+\/?(?:[?#].*)?$/i.test(params.url) ||
    /[?&](?:page|paged)=\d+(?:&|$)/i.test(params.url)
  );
}

async function readResponseBytes(response: Response, limit: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error(`Sitemap response exceeds ${limit} bytes`);
  }
  if (!response.body) throw new Error("Sitemap response has no body");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("Sitemap response too large");
        throw new Error(`Sitemap response exceeds ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchText(url: string): Promise<string> {
  let currentUrl = url;

  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!(await isResolvedPublicHttpUrl(currentUrl))) {
      throw new Error(`Blocked unsafe sitemap URL: ${currentUrl}`);
    }

    const res = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": "Mozilla/5.0 URLDiscoveryBot/1.0",
        Accept: "application/xml,text/xml,text/html,*/*"
      }
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect missing Location: ${currentUrl}`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status}: ${currentUrl}`);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (
      contentType &&
      !/(?:xml|text\/plain|text\/html|octet-stream|gzip)/.test(contentType)
    ) {
      throw new Error(`Unexpected sitemap content type ${contentType}: ${currentUrl}`);
    }

    const bytes = await readResponseBytes(res, MAX_SITEMAP_DOWNLOAD_BYTES);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return gunzipSync(bytes, {
        maxOutputLength: MAX_SITEMAP_UNCOMPRESSED_BYTES
      }).toString("utf8");
    }
    if (bytes.length > MAX_SITEMAP_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Uncompressed sitemap exceeds ${MAX_SITEMAP_UNCOMPRESSED_BYTES} bytes`
      );
    }
    return bytes.toString("utf8");
  }

  throw new Error(`Too many sitemap redirects: ${url}`);
}

function isSitemapUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".xml") || path.endsWith(".xml.gz") || path.includes("sitemap");
  } catch {
    return false;
  }
}

function shouldKeepSitemapEntry(entry: SitemapEntry, cutoff: Date): boolean {
  if (!entry.lastmod) return true;

  const timestamp = Date.parse(entry.lastmod);
  // Unknown or malformed lastmod values are deliberately retained. The article
  // extraction stage can quarantine them after inspecting the page metadata.
  return !Number.isFinite(timestamp) || timestamp >= cutoff.getTime();
}

export async function discoverFromSitemaps(
  source: Source,
  daysBack = DEFAULT_DISCOVERY_DAYS_BACK
): Promise<DiscoveredUrl[]> {
  const baseUrl = getBaseUrl(source);
  const sitemapUrls = source.sitemapUrls || [];
  const cutoff = getDiscoveryCutoff(daysBack);

  const output: DiscoveredUrl[] = [];
  const queue: Array<{ url: string; depth: number }> = sitemapUrls.map((url) => ({
    url,
    depth: 0
  }));
  const scheduledSitemaps = new Set(sitemapUrls);
  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();
  const sitemapErrors: string[] = [];

  while (queue.length > 0 && output.length < MAX_SITEMAP_URLS) {
    const { url: sitemapUrl, depth } = queue.shift()!;

    if (seenSitemaps.has(sitemapUrl)) continue;
    if (seenSitemaps.size >= MAX_SITEMAP_FILES) {
      throw new Error(
        `${source.name} reached MAX_SITEMAP_FILES=${MAX_SITEMAP_FILES}; sitemap index is too large`
      );
    }
    seenSitemaps.add(sitemapUrl);

    try {
      const xml = await fetchText(sitemapUrl);
      const sitemapEntries = extractSitemapEntries(xml, "sitemap");
      const urlEntries = extractSitemapEntries(xml, "url");

      // A few non-conforming sitemaps omit url/sitemap wrappers. Retain a
      // conservative loc-only fallback rather than silently losing candidates.
      const fallbackEntries: SitemapEntry[] = [];
      if (sitemapEntries.length === 0 && urlEntries.length === 0) {
        const matches = xml.matchAll(
          /<(?:[a-z_][\w.-]*:)?loc\b[^>]*>([\s\S]*?)<\/(?:[a-z_][\w.-]*:)?loc\s*>/gi
        );
        for (const match of matches) {
          if (match[1] !== undefined) {
            fallbackEntries.push({ loc: cleanXmlText(match[1]), lastmod: null });
          }
        }
      }

      for (const entry of [...sitemapEntries, ...urlEntries, ...fallbackEntries]) {
        if (output.length >= MAX_SITEMAP_URLS) break;
        if (!shouldKeepSitemapEntry(entry, cutoff)) continue;

        const loc = normalizeDiscoveredUrl(entry.loc, sitemapUrl);
        if (!loc) continue;
        if (!isSameDomain(loc, baseUrl)) continue;

        if (isSitemapUrl(loc) || sitemapEntries.includes(entry)) {
          if (scheduledSitemaps.has(loc)) continue;
          if (depth >= MAX_SITEMAP_DEPTH) {
            throw new Error(
              `${source.name} exceeded MAX_SITEMAP_DEPTH=${MAX_SITEMAP_DEPTH} at ${loc}`
            );
          }
          scheduledSitemaps.add(loc);
          queue.push({ url: loc, depth: depth + 1 });
          continue;
        }

        if (shouldSkipUrl(loc)) continue;
        if (isLikelyListingPageUrl(loc)) continue;
        if (seenUrls.has(loc)) continue;

        seenUrls.add(loc);

        output.push({
          url: loc,
          sourceName: source.name,
          sourceCategory: source.category || null,
          discoveryMethod: "sitemap"
        });
      }
    } catch (error) {
      const message = `[SITEMAP FAILED] ${sitemapUrl}: ${String(error)}`;
      sitemapErrors.push(message);
      console.warn(message);
    }
  }

  if (sitemapErrors.length > 0) {
    throw new Error(
      `${source.name} sitemap discovery was incomplete:\n${sitemapErrors.join("\n")}`
    );
  }

  if (output.length >= MAX_SITEMAP_URLS) {
    throw new Error(
      `${source.name} reached MAX_SITEMAP_URLS=${MAX_SITEMAP_URLS}; raise the cap rather than accepting a partial backfill`
    );
  }

  return output;
}

export function buildArchiveUrls(source: Source, daysBack: number): DiscoveredUrl[] {
  const templates = source.archiveUrlTemplates || [];
  const months = getMonthDatesBack(daysBack);

  const output: DiscoveredUrl[] = [];

  for (const template of templates) {
    for (const month of months) {
      const url = renderTemplate(template, month);

      output.push({
        url,
        sourceName: source.name,
        sourceCategory: source.category || null,
        discoveryMethod: "archive"
      });
    }
  }

  return output;
}

/** Build configured search/listing inputs without placing them in the article queue. */
export function buildSearchListingUrls(source: Source, daysBack: number): string[] {
  const output = new Set<string>();

  for (const template of source.dailySearchUrlTemplates || []) {
    for (const date of getDayDatesBack(daysBack)) {
      output.add(renderTemplate(template, date));
    }
  }

  for (const template of source.searchUrlTemplates || []) {
    for (const month of getMonthDatesBack(daysBack)) {
      output.add(renderTemplate(template, month));
    }
  }

  return [...output];
}

export async function discoverFromListingPages(params: {
  source: Source;
  listingUrls: string[];
}): Promise<DiscoveredUrl[]> {
  const { source, listingUrls } = params;
  const baseUrl = getBaseUrl(source);

  const output: DiscoveredUrl[] = [];
  const seenUrls = new Set<string>();
  const seenListingUrls = new Set<string>();
  const configuredStartUrls = source.startUrls?.length
    ? source.startUrls
    : [source.homepageUrl || source.baseUrl || source.feedUrl].filter(
        (url): url is string => Boolean(url)
      );
  const startUrls = new Set(
    configuredStartUrls
      .map((url) => normalizeDiscoveredUrl(url))
      .filter((url): url is string => Boolean(url))
  );
  const requests: Array<{
    url: string;
    uniqueKey: string;
    userData: { discoveryMethod: "startUrl" | "archive" };
  }> = [];
  let handledListingPages = 0;
  let paginationWasTruncated = false;
  const listingErrors: string[] = [];

  for (const rawUrl of listingUrls) {
    const url = normalizeDiscoveredUrl(rawUrl);
    if (!url || !isSameDomain(url, baseUrl) || seenListingUrls.has(url)) continue;
    seenListingUrls.add(url);

    requests.push({
      url,
      uniqueKey: `listing|${url}`,
      userData: {
        discoveryMethod: startUrls.has(url) ? "startUrl" : "archive"
      }
    });
  }

  const crawler = new PlaywrightCrawler({
    maxConcurrency: MAX_CONCURRENCY,
    maxRequestsPerCrawl: MAX_LISTING_REQUESTS,

    preNavigationHooks: [
      async ({ page }) => {
        await page.route("**/*", async (route) => {
          const resourceType = route.request().resourceType();

          if (
            BLOCKED_RESOURCE_TYPES.has(resourceType) ||
            !(await isResolvedPublicHttpUrl(route.request().url()))
          ) {
            return route.abort();
          }

          return route.continue();
        });
      }
    ],

    async requestHandler(context) {
      const { page, request, log } = context;
      handledListingPages++;
      log.info(`[DISCOVER LISTING] ${request.url}`);

      const response = (context as any).response;
      if (!response) throw new Error(`Listing navigation has no HTTP response: ${request.url}`);
      const status = response.status();
      const headers = await response.headers();
      const contentType = String(headers["content-type"] || "").toLowerCase();
      const serverAddress = await response.serverAddr();
      const finalUrl = page.url() || request.url;
      if (status < 200 || status >= 400) {
        throw new Error(`Listing returned HTTP ${status}: ${request.url}`);
      }
      if (!contentType || !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
        throw new Error(`Listing returned non-HTML content: ${contentType || "missing"}`);
      }
      if (!isSameDomain(finalUrl, baseUrl)) {
        throw new Error(`Listing redirected outside source domain: ${finalUrl}`);
      }
      if (!serverAddress || isPrivateOrLocalHostname(serverAddress.ipAddress)) {
        throw new Error(
          `Listing resolved to a non-public address: ${serverAddress?.ipAddress || "missing"}`
        );
      }
      const pageTitle = (await page.title()).trim();
      if (/^(?:just a moment|access denied|attention required|captcha|verify you are human)/i.test(pageTitle)) {
        throw new Error(`Listing returned a challenge page: ${pageTitle}`);
      }

      const links = await page.$$eval("a[href]", (anchors) =>
        anchors
          .map((a) => ({
            href: (a as HTMLAnchorElement).href,
            rel: (a as HTMLAnchorElement).rel,
            text: (a.textContent || "").trim()
          }))
          .filter((item) => Boolean(item.href))
      );

      const paginationRequests: Array<{
        url: string;
        uniqueKey: string;
        userData: { discoveryMethod: "startUrl" | "archive" };
      }> = [];
      const discoveryMethod: "startUrl" | "archive" =
        request.userData.discoveryMethod === "archive" ? "archive" : "startUrl";

      for (const link of links) {
        const normalized = normalizeDiscoveredUrl(link.href, request.url);
        if (!normalized || !isSameDomain(normalized, baseUrl)) continue;
        if (shouldSkipUrl(normalized)) continue;

        if (isPaginationLink({ url: normalized, rel: link.rel, text: link.text })) {
          if (
            paginationRequests.length < MAX_PAGINATION_LINKS_PER_PAGE &&
            !seenListingUrls.has(normalized)
          ) {
            seenListingUrls.add(normalized);
            paginationRequests.push({
              url: normalized,
              uniqueKey: `listing|${normalized}`,
              userData: { discoveryMethod }
            });
          } else if (!seenListingUrls.has(normalized)) {
            paginationWasTruncated = true;
          }
          continue;
        }

        if (isLikelyListingPageUrl(normalized)) continue;
        if (seenUrls.has(normalized)) continue;

        seenUrls.add(normalized);

        output.push({
          url: normalized,
          sourceName: source.name,
          sourceCategory: source.category || null,
          discoveryMethod
        });
      }

      if (paginationRequests.length > 0) {
        await crawler.addRequests(paginationRequests);
      }
    },

    failedRequestHandler({ request, log }) {
      const message = `[FAILED LISTING] ${request.url}`;
      listingErrors.push(message);
      log.warning(message);
    }
  }, createEphemeralCrawlerConfiguration());

  await crawler.run(requests);

  if (listingErrors.length > 0) {
    throw new Error(
      `${source.name} listing discovery was incomplete:\n${listingErrors.join("\n")}`
    );
  }

  if (
    paginationWasTruncated ||
    (handledListingPages >= MAX_LISTING_REQUESTS &&
      seenListingUrls.size > handledListingPages)
  ) {
    throw new Error(
      `${source.name} listing pagination hit its safety cap; raise MAX_LISTING_REQUESTS or MAX_PAGINATION_LINKS_PER_PAGE`
    );
  }

  return output;
}
