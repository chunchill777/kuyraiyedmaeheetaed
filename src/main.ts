import fs from "fs/promises";
import { Source, DiscoveredUrl } from "./types";
import { openDb, insertUrl, getUrlStats } from "./db";
import {
  discoverFromSitemaps,
  buildArchiveUrls,
  discoverFromListingPages,
  getBaseUrl,
  getFromDate
} from "./discover";

const STORAGE_PATH = "./src/storage.json";

const TEST_SOURCE_NAME = process.env.TEST_SOURCE_NAME || "";
const TEST_SOURCE_INDEX = Number(process.env.TEST_SOURCE_INDEX || 0);
const DAYS_BACK = Number(process.env.DAYS_BACK || 180);

function selectSource(sources: Source[]): Source {
  if (TEST_SOURCE_NAME) {
    const found = sources.find((s) =>
      s.name.toLowerCase().includes(TEST_SOURCE_NAME.toLowerCase())
    );

    if (!found) {
      throw new Error(`Source not found: ${TEST_SOURCE_NAME}`);
    }

    return found;
  }

  const source = sources[TEST_SOURCE_INDEX];

  if (!source) {
    throw new Error(`Source index not found: ${TEST_SOURCE_INDEX}`);
  }

  return source;
}

async function main() {
  const rawSources = await fs.readFile(STORAGE_PATH, "utf-8");
  const sources: Source[] = JSON.parse(rawSources);

  const source = selectSource(sources);
  const baseUrl = getBaseUrl(source);
  const fromDate = getFromDate(DAYS_BACK);

  const db = openDb();

  console.log("Starting Phase 1: URL Discovery");
  console.log(`Source: ${source.name}`);
  console.log(`Category: ${source.category || "unknown"}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Days Back: ${DAYS_BACK}`);
  console.log(`From Date: ${fromDate.toISOString()}`);

  let inserted = 0;
  let duplicated = 0;

  // 1. Sitemap discovery
  console.log("\n[1/3] Discovering from sitemaps...");
  const sitemapUrls = await discoverFromSitemaps(source);
  console.log(`Sitemap URLs discovered: ${sitemapUrls.length}`);

  for (const item of sitemapUrls) {
    const ok = insertUrl(db, item);
    if (ok) inserted++;
    else duplicated++;
  }

  // 2. Monthly archive URLs
  console.log("\n[2/3] Building monthly archive URLs...");
  const archiveListingUrls = buildArchiveUrls(source, DAYS_BACK);
  console.log(`Archive listing URLs generated: ${archiveListingUrls.length}`);

  for (const item of archiveListingUrls) {
    const ok = insertUrl(db, item);
    if (ok) inserted++;
    else duplicated++;
  }

  // 3. Discover article links from startUrls + archive listing pages
  console.log("\n[3/3] Discovering links from startUrls/archive pages...");

  const listingUrls = [
    ...(source.startUrls || []),
    ...archiveListingUrls.map((x) => x.url)
  ];

  const listingDiscovered: DiscoveredUrl[] = await discoverFromListingPages({
    source,
    listingUrls
  });

  console.log(`Listing page links discovered: ${listingDiscovered.length}`);

  for (const item of listingDiscovered) {
    const ok = insertUrl(db, item);
    if (ok) inserted++;
    else duplicated++;
  }

  const stats = getUrlStats(db);

  console.log("\nDone Phase 1.");
  console.log(`Inserted URLs: ${inserted}`);
  console.log(`Duplicate URLs skipped: ${duplicated}`);
  console.log(`Total URLs in DB: ${stats.total}`);
  console.log(`Pending URLs: ${stats.pending}`);
  console.log("By method:");

  for (const row of stats.byMethod) {
    console.log(`- ${row.discovery_method}: ${row.count}`);
  }

  console.log("\nSaved DB: ./data/crawler.db");
}

main().catch((err) => {
  console.error("Fatal error:", err);
});