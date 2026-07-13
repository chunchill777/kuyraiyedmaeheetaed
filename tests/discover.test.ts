import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeXmlEntities,
  extractSitemapEntries,
  getBaseUrl,
  getDiscoveryCutoff,
  isLikelyListingPageUrl,
  isPaginationLink,
  isSameDomain,
  shouldSkipUrl
} from "../src/discover";

test("keeps sitemap loc and lastmod paired and decodes entities", () => {
  const xml = `
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>https://example.com/story?a=1&amp;b=2</loc>
        <lastmod>2026-06-20T10:00:00Z</lastmod>
      </url>
      <url>
        <loc><![CDATA[https://example.com/second]]></loc>
        <lastmod>2026-05-01</lastmod>
      </url>
    </urlset>`;

  assert.deepEqual(extractSitemapEntries(xml), [
    {
      loc: "https://example.com/story?a=1&b=2",
      lastmod: "2026-06-20T10:00:00Z"
    },
    { loc: "https://example.com/second", lastmod: "2026-05-01" }
  ]);
  assert.equal(decodeXmlEntities("a&amp;b&#x2f;c"), "a&b/c");
});

test("calculates a UTC discovery cutoff", () => {
  assert.equal(
    getDiscoveryCutoff(365, new Date("2026-07-13T20:45:00Z")).toISOString(),
    "2025-07-13T00:00:00.000Z"
  );
});

test("treats www/apex as the same source domain", () => {
  assert.equal(isSameDomain("https://example.com/a", "https://www.example.com"), true);
  assert.equal(isSameDomain("https://news.example.com/a", "https://example.com"), true);
  assert.equal(isSameDomain("https://example.net/a", "https://example.com"), false);
});

test("derives a base URL for sitemap-only source configs", () => {
  assert.equal(
    getBaseUrl({
      name: "Sitemap only",
      sitemapUrls: ["https://news.example.com/sitemap.xml"]
    }),
    "https://news.example.com"
  );
});

test("recognizes collection and pagination links", () => {
  assert.equal(isLikelyListingPageUrl("https://example.com/2026/07"), true);
  assert.equal(isLikelyListingPageUrl("https://example.com/page/3"), true);
  assert.equal(isLikelyListingPageUrl("https://example.com/newsroom"), true);
  assert.equal(isLikelyListingPageUrl("https://example.com/en/insights"), true);
  assert.equal(isLikelyListingPageUrl("https://example.com/publications"), true);
  assert.equal(
    isLikelyListingPageUrl("https://example.com/insights/real-story"),
    false
  );
  assert.equal(
    isLikelyListingPageUrl("https://example.com/2026/07/13/real-story"),
    false
  );
  assert.equal(
    isPaginationLink({
      url: "https://example.com/articles?page=2",
      rel: "next",
      text: "Next"
    }),
    true
  );
});

test("URL exclusions match path segments instead of article substrings", () => {
  assert.equal(shouldSkipUrl("https://example.com/contact"), true);
  assert.equal(
    shouldSkipUrl("https://example.com/contact-tracing-breakthrough"),
    false
  );
  assert.equal(shouldSkipUrl("https://example.com/event-horizon-discovery"), false);
  assert.equal(shouldSkipUrl("https://example.com/search?q=energy"), true);
});
