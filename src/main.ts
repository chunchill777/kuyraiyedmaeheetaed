import fs from "fs/promises";
import { Source, DiscoveredUrl } from "./types";
import { openDb, insertUrls, getUrlStats } from "./db";
import {
  discoverFromSitemaps,
  buildArchiveUrls,
  buildSearchListingUrls,
  discoverFromListingPages,
  getBaseUrl,
  getFromDate
} from "./discover";
import type Database from "better-sqlite3";
import { canonicalizeUrl } from "./articleQuality";

const STORAGE_PATH = "./src/storage.json";

const TEST_SOURCE_NAME = process.env.TEST_SOURCE_NAME || "";
const TEST_SOURCE_INDEX = Number(process.env.TEST_SOURCE_INDEX || 0);
const DAYS_BACK = Number(process.env.DAYS_BACK || 365);

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

export async function discoverSource(
  source: Source,
  options: {
    daysBack?: number;
    db?: Database.Database;
    sourceId?: number;
    sourceJobId?: number;
  } = {}
) {
  const daysBack = options.daysBack ?? DAYS_BACK;
  const ownsDb = !options.db;
  const db = options.db || openDb();
  const baseUrl = getBaseUrl(source);
  const fromDate = getFromDate(daysBack);

  console.log("Starting Phase 1: URL Discovery");
  console.log(`Source: ${source.name}`);
  console.log(`Category: ${source.category || "unknown"}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Days Back: ${daysBack}`);
  console.log(`From Date: ${fromDate.toISOString()}`);

  let inserted = 0;
  let duplicated = 0;

  const saveDiscoveredUrls = (items: DiscoveredUrl[]) => {
    const result = insertUrls(
      db,
      items.map((item) => ({
        ...item,
        sourceId: options.sourceId,
        sourceJobId: options.sourceJobId,
        canonicalUrl: canonicalizeUrl(item.url)
      }))
    );
    inserted += result.inserted;
    duplicated += result.duplicated;
  };

  try {
    console.log("\n[1/3] Discovering from sitemaps...");
    const sitemapUrls = await discoverFromSitemaps(source, daysBack);
    console.log(`Sitemap URLs discovered: ${sitemapUrls.length}`);
    saveDiscoveredUrls(sitemapUrls);

    console.log("\n[2/3] Building monthly archive URLs...");
    const archiveListingUrls = buildArchiveUrls(source, daysBack);
    const searchListingUrls = buildSearchListingUrls(source, daysBack);
    console.log(`Archive listing URLs generated: ${archiveListingUrls.length}`);
    console.log(`Search listing URLs generated: ${searchListingUrls.length}`);

    // Archive URLs are discovery inputs, never article candidates themselves.
    console.log("\n[3/3] Discovering links from startUrls/archive pages...");
    const configuredStartUrls = source.startUrls?.length
      ? source.startUrls
      : [source.homepageUrl || source.baseUrl || source.feedUrl].filter(
          (value): value is string => Boolean(value)
        );
    const listingUrls = [
      ...configuredStartUrls,
      ...archiveListingUrls.map((x) => x.url),
      ...searchListingUrls
    ];

    const listingDiscovered = await discoverFromListingPages({
      source,
      listingUrls
    });

    console.log(`Listing page links discovered: ${listingDiscovered.length}`);
    saveDiscoveredUrls(listingDiscovered);

    const stats = getUrlStats(db);
    console.log("\nDone Phase 1.");
    console.log(`Inserted URLs: ${inserted}`);
    console.log(`Duplicate URLs skipped: ${duplicated}`);
    console.log(`Total URLs in DB: ${stats.total}`);
    console.log(`Pending URLs: ${stats.pending}`);

    return { inserted, duplicated, discovered: inserted + duplicated };
  } finally {
    if (ownsDb) db.close();
  }
}

export async function main() {
  const rawSources = await fs.readFile(STORAGE_PATH, "utf-8");
  const sources: Source[] = JSON.parse(rawSources);

  const source = selectSource(sources);
  await discoverSource(source, { daysBack: DAYS_BACK });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  });
}
