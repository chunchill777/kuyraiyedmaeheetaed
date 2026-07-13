import assert from "node:assert/strict";
import test from "node:test";

import { validateArticleCandidate } from "../src/articleQuality";
import { extractArticleDataFromHtml } from "../src/crawlArticles";

const paragraphs = [
  "Researchers released a detailed energy assessment after collecting measurements across several regions. The publication compares current capacity, investment, prices, and reliability with a decade of historical evidence.",
  "Independent reviewers examined the methodology and confirmed that the central conclusion was supported by the available observations. They also documented uncertainty around rural infrastructure and smaller industrial users.",
  "Policy makers said the findings would inform a new public consultation on grid planning. The proposal includes consumer protections, competitive procurement, workforce training, and clearer performance reporting.",
  "Manufacturers are increasing production while trying to reduce supply delays. Executives cautioned that interest rates, commodity prices, and permitting timelines could still change deployment schedules.",
  "Community groups welcomed the additional investment but requested stronger safeguards for low-income households. Regulators will publish distributional estimates before making a final decision later this year.",
  "The authors made their input data available for replication by universities and civil-society organizations. Follow-up reports will track emissions, employment, service quality, and technology costs."
];

test("extracts structured article title/date and removes navigation/script clutter", () => {
  const html = `<!doctype html><html><head>
    <title>Archives</title>
    <meta property="og:title" content="Fallback social title">
    <script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      headline: "Structured headline wins over a generic page heading",
      datePublished: "2026-06-20T08:00:00Z",
      dateModified: "2026-07-01T08:00:00Z"
    })}</script>
    <script>window.__APP__ = { navigation: true };</script>
    <link rel="canonical" href="https://www.example.com/story/?utm_source=test">
  </head><body>
    <nav>Home About Contact Privacy Terms</nav>
    <h1>Archives</h1>
    <article>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}</article>
    <footer>Accept all cookies</footer>
  </body></html>`;

  const extracted = extractArticleDataFromHtml(
    html,
    "https://example.com/story/?utm_source=test"
  );

  assert.equal(
    extracted.title,
    "Structured headline wins over a generic page heading"
  );
  assert.equal(extracted.publishedDate?.toISOString(), "2026-06-20T08:00:00.000Z");
  assert.equal(extracted.publishedDateSource, "jsonld:datePublished");
  assert.equal(extracted.canonicalUrl, "https://example.com/story");
  assert.doesNotMatch(extracted.text, /window\.__APP__|Accept all cookies|Home About/);

  const quality = validateArticleCandidate(
    {
      url: extracted.canonicalUrl!,
      title: extracted.title,
      publishedDate: extracted.publishedDate,
      text: extracted.text
    },
    { now: "2026-07-13T12:00:00Z", minTextLength: 700, minWordCount: 100 }
  );
  assert.equal(quality.accepted, true, quality.rejectionCodes.join(", "));
});

test("does not substitute dateModified for a publication date", () => {
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      headline: "An old page changed recently",
      dateModified: "2026-07-01T08:00:00Z"
    })}</script>
  </head><body><article><h1>An old page changed recently</h1>
    ${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
  </article></body></html>`;

  const extracted = extractArticleDataFromHtml(html, "https://example.com/old");
  assert.equal(extracted.publishedDate, null);

  const quality = validateArticleCandidate(
    {
      url: extracted.finalUrl,
      title: extracted.title,
      publishedDate: extracted.publishedDate,
      text: extracted.text
    },
    { now: "2026-07-13T12:00:00Z" }
  );
  assert.ok(quality.rejectionCodes.includes("MISSING_PUBLISHED_DATE"));
});

test("does not trust a generic listing-card time as publication metadata", () => {
  const html = `<html><head><title>Latest updates</title></head><body><main>
    <time datetime="2026-07-10T08:00:00Z">July 10</time>
    ${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
  </main></body></html>`;

  const extracted = extractArticleDataFromHtml(html, "https://example.com/updates");
  assert.equal(extracted.publishedDate, null);
  assert.equal(extracted.isArticleDocument, false);
});
