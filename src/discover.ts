import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { Source, DiscoveredUrl } from "./types";

const MAX_SITEMAP_URLS = Number(process.env.MAX_SITEMAP_URLS || 3000);
const MAX_LISTING_REQUESTS = Number(process.env.MAX_LISTING_REQUESTS || 100);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2);

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

export function getBaseUrl(source: Source): string {
  const raw =
    source.baseUrl ||
    source.homepageUrl ||
    source.startUrls?.[0] ||
    source.feedUrl;

  if (!raw) {
    throw new Error(`Missing baseUrl/startUrls/feedUrl for ${source.name}`);
  }

  const url = new URL(raw);
  return `${url.protocol}//${url.hostname}`;
}

export function getFromDate(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d;
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

function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);

    return (
      target.hostname === base.hostname ||
      target.hostname.endsWith(`.${base.hostname}`)
    );
  } catch {
    return false;
  }
}

function shouldSkipUrl(url: string): boolean {
  const u = url.toLowerCase();

  const blockedParts = [
    "/login",
    "/signin",
    "/signup",
    "/subscribe",
    "/subscription",
    "/privacy",
    "/terms",
    "/about",
    "/contact",
    "/advertise",
    "/newsletter",
    "/author",
    "/authors",
    "/tag/",
    "/tags/",
    "/video",
    "/videos",
    "/podcast",
    "/podcasts",
    "/events",
    "/event",
    "/careers",
    "/jobs",
    "/shop",
    "/cart",
    "/account",
    "/search",
    "?s=",
    "/?s="
  ];

  const blockedExtensions = [
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

  if (blockedParts.some((part) => u.includes(part))) return true;
  if (blockedExtensions.some((ext) => u.endsWith(ext))) return true;
  if (u.includes("#")) return true;
  if (u.startsWith("mailto:")) return true;
  if (u.startsWith("tel:")) return true;

  return false;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 URLDiscoveryBot/1.0",
      Accept: "application/xml,text/xml,text/html,*/*"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${url}`);
  }

  return await res.text();
}

function extractLocsFromXml(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi);
  return Array.from(matches).map((m) => m[1].trim());
}

export async function discoverFromSitemaps(source: Source): Promise<DiscoveredUrl[]> {
  const baseUrl = getBaseUrl(source);
  const sitemapUrls = source.sitemapUrls || [];

  const output: DiscoveredUrl[] = [];
  const queue = [...sitemapUrls];
  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();

  while (queue.length > 0 && output.length < MAX_SITEMAP_URLS) {
    const sitemapUrl = queue.shift()!;

    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const xml = await fetchText(sitemapUrl);
      const locs = extractLocsFromXml(xml);

      for (const loc of locs) {
        if (output.length >= MAX_SITEMAP_URLS) break;
        if (!isSameDomain(loc, baseUrl)) continue;

        if (loc.endsWith(".xml") || loc.includes("sitemap")) {
          queue.push(loc);
          continue;
        }

        if (shouldSkipUrl(loc)) continue;
        if (seenUrls.has(loc)) continue;

        seenUrls.add(loc);

        output.push({
          url: loc,
          sourceName: source.name,
          sourceCategory: source.category || null,
          discoveryMethod: "sitemap"
        });
      }
    } catch {
      // Some sitemap URLs fail. Skip them safely.
    }
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

export async function discoverFromListingPages(params: {
  source: Source;
  listingUrls: string[];
}): Promise<DiscoveredUrl[]> {
  const { source, listingUrls } = params;
  const baseUrl = getBaseUrl(source);

  const requestQueue = await RequestQueue.open(`discover-${Date.now()}`);
  const output: DiscoveredUrl[] = [];
  const seenUrls = new Set<string>();

  for (const url of listingUrls) {
    await requestQueue.addRequest({
      url,
      uniqueKey: `listing|${url}`
    });
  }

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: MAX_CONCURRENCY,
    maxRequestsPerCrawl: MAX_LISTING_REQUESTS,

    async requestHandler({ page, request, log }) {
      log.info(`[DISCOVER LISTING] ${request.url}`);

      const links = await page.$$eval("a[href]", (anchors) =>
        anchors.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
      );

      for (const link of links) {
        try {
          const normalized = new URL(link, request.url).toString();

          if (!isSameDomain(normalized, baseUrl)) continue;
          if (shouldSkipUrl(normalized)) continue;
          if (seenUrls.has(normalized)) continue;

          seenUrls.add(normalized);

          output.push({
            url: normalized,
            sourceName: source.name,
            sourceCategory: source.category || null,
            discoveryMethod: request.url.includes(new URL(baseUrl).hostname)
              ? "startUrl"
              : "archive"
          });
        } catch {
          // ignore invalid urls
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.warning(`[FAILED LISTING] ${request.url}`);
    }
  });

  await crawler.run();

  return output;
}