import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeUrl,
  hashNormalizedContent,
  normalizeContentForHash,
  validateArticleCandidate
} from "../src/articleQuality";

const NOW = new Date("2026-07-13T12:00:00.000Z");

function prose(paragraphCount = 8): string {
  const paragraphs = [
    "Researchers published a detailed assessment of the energy system this week. The report compares new measurements with earlier evidence and explains why the results matter for households and industry.",
    "Independent specialists reviewed the methodology and identified several limitations. They also proposed practical experiments that could distinguish temporary effects from durable changes.",
    "Government data shows that investment accelerated across three regions during the first half of the year. Rural projects grew more slowly because grid connections and financing remained scarce.",
    "Manufacturers responded by redesigning equipment, training technicians, and negotiating longer supply agreements. Those choices reduced delays but increased near-term capital costs.",
    "Consumer groups welcomed the reliability improvements while asking regulators to protect low-income customers. The commission plans public hearings before it approves the new tariff structure.",
    "Analysts expect the transition to continue, although interest rates and commodity prices could change the schedule. Their forecast includes conservative, central, and rapid-deployment scenarios.",
    "The authors released the underlying measurements and documented how missing observations were estimated. A separate university team will attempt to reproduce the results later this year.",
    "Taken together, the evidence suggests a meaningful structural shift rather than a short-lived headline. Future reports will track prices, capacity, emissions, employment, and service quality."
  ];

  return paragraphs.slice(0, paragraphCount).join("\n\n");
}

function validCandidate(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/research/clean-energy-update",
    title: "New evidence changes the outlook for clean energy",
    publishedDate: "2026-06-20T08:00:00.000Z",
    text: prose(),
    ...overrides
  };
}

test("accepts a dated, article-shaped prose document", () => {
  const result = validateArticleCandidate(validCandidate(), { now: NOW });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.rejectionCodes, []);
  assert.equal(result.qualityScore, 100);
  assert.equal(result.publishedDate, "2026-06-20T08:00:00.000Z");
  assert.ok(result.cleanedText.length >= 500);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
});

test("rejects an archive page title", () => {
  const result = validateArticleCandidate(validCandidate({ title: "Archives" }), { now: NOW });

  assert.equal(result.accepted, false);
  assert.ok(result.rejectionCodes.includes("GENERIC_OR_ERROR_TITLE"));
});

test("requires a known, valid publication date", () => {
  const missing = validateArticleCandidate(validCandidate({ publishedDate: null }), { now: NOW });
  const invalid = validateArticleCandidate(validCandidate({ publishedDate: "not-a-date" }), { now: NOW });

  assert.ok(missing.rejectionCodes.includes("MISSING_PUBLISHED_DATE"));
  assert.ok(invalid.rejectionCodes.includes("INVALID_PUBLISHED_DATE"));
});

test("rejects timezone-less publication timestamps deterministically", () => {
  const result = validateArticleCandidate(
    validCandidate({ publishedDate: "2026-06-20T08:00:00" }),
    { now: NOW }
  );

  assert.ok(result.rejectionCodes.includes("INVALID_PUBLISHED_DATE"));
});

test("rejects dates older than 365 days", () => {
  const result = validateArticleCandidate(validCandidate({ publishedDate: "2025-07-12T11:59:59.000Z" }), {
    now: NOW
  });

  assert.equal(result.accepted, false);
  assert.ok(result.rejectionCodes.includes("PUBLISHED_DATE_TOO_OLD"));
});

test("allows a small clock skew but rejects a future date", () => {
  const tolerated = validateArticleCandidate(validCandidate({ publishedDate: "2026-07-13T12:10:00.000Z" }), {
    now: NOW
  });
  const future = validateArticleCandidate(validCandidate({ publishedDate: "2026-07-13T12:16:00.000Z" }), {
    now: NOW
  });

  assert.equal(tolerated.accepted, true);
  assert.ok(future.rejectionCodes.includes("PUBLISHED_DATE_IN_FUTURE"));
});

test("rejects JavaScript and CSS payloads instead of treating them as prose", () => {
  const javascript = `var webpackJsonp = {}; function bootstrapApp() { window.document.body.innerHTML = "ready"; }; ${
    "const moduleValue = window.document.querySelector('main'); moduleValue.classList.add('ready'); ".repeat(30)
  }`;
  const css = `.layout { display: grid; color: #222; margin: 0; }\n${
    "@media screen { .content { display: block; padding: 10px; } }\n".repeat(30)
  }`;

  const jsResult = validateArticleCandidate(validCandidate({ text: javascript }), { now: NOW });
  const cssResult = validateArticleCandidate(validCandidate({ text: css }), { now: NOW });

  assert.ok(jsResult.rejectionCodes.includes("JAVASCRIPT_OR_CSS_SHELL"));
  assert.ok(cssResult.rejectionCodes.includes("JAVASCRIPT_OR_CSS_SHELL"));
});

test("rejects cookie and consent screens", () => {
  const cookieWall = `${
    "We use cookies to personalise content and measure traffic. Accept all cookies or manage consent preferences. ".repeat(12)
  } Cookie preferences Privacy policy`;
  const result = validateArticleCandidate(validCandidate({ text: cookieWall }), { now: NOW });

  assert.equal(result.accepted, false);
  assert.ok(result.rejectionCodes.includes("COOKIE_OR_CONSENT_NOISE"));
});

test("canonicalizes URLs by dropping trackers and sorting retained parameters", () => {
  const actual = canonicalizeUrl(
    "HTTPS://Example.COM:443/news/item///?utm_source=newsletter&b=2&fbclid=secret&a=3&a=1#comments"
  );

  assert.equal(actual, "https://example.com/news/item?a=1&a=3&b=2");
  assert.equal(canonicalizeUrl("ftp://example.com/file"), null);
});

test("normalizes superficial formatting differences to the same duplicate hash", () => {
  const first = "  The Future—Is HERE!\n\nIt’s already changing.  ";
  const second = "the future - is here it&apos;s already changing";

  assert.equal(normalizeContentForHash(first), normalizeContentForHash(second));
  assert.equal(hashNormalizedContent(first), hashNormalizedContent(second));
});
