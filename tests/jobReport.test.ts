import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  ensureSchema,
  findArticleIdByIdentity,
  getPendingUrls,
  insertArticle,
  insertRejectedPage,
  insertUrl,
  linkSourceJobUrlArticle,
  markUrlStatus
} from "../src/db";
import {
  buildCoverageReport,
  evaluateCoverageCompletion
} from "../src/processSourceQueue";
import { claimNextSourceJob, enqueueSource } from "../src/sourceQueue";

test("builds coverage from per-job URL/article associations", () => {
  const db = new Database(":memory:");
  ensureSchema(db);

  try {
    const queued = enqueueSource(db, {
      name: "Report source",
      baseUrl: "https://report.example",
      minCoverageMonths: 1
    });
    const job = claimNextSourceJob(db, "report-worker");
    assert.ok(job);

    insertUrl(db, {
      url: "https://report.example/story",
      canonicalUrl: "https://report.example/story",
      sourceName: "Report source",
      sourceCategory: null,
      discoveryMethod: "sitemap",
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });
    const pending = getPendingUrls(db, 10, "Report source", {
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });
    assert.equal(pending.length, 1);

    const publishedDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const contentHash = "job-report-content-hash";
    insertArticle(db, {
      url: pending[0]!.url,
      canonicalUrl: "https://report.example/story",
      sourceName: "Report source",
      sourceCategory: null,
      sourceId: queued.source.id,
      sourceJobId: queued.job.id,
      title: "Coverage report article",
      publishedDate,
      text: "Detailed reporting with evidence and complete sentences. ".repeat(20),
      contentHash,
      qualityScore: 100
    });
    const articleId = findArticleIdByIdentity(db, {
      url: pending[0]!.url,
      canonicalUrl: "https://report.example/story",
      contentHash
    });
    assert.ok(articleId);
    linkSourceJobUrlArticle(db, queued.job.id, pending[0]!.id, articleId);
    markUrlStatus(db, pending[0]!.id, "crawled", undefined, queued.job.id);

    insertUrl(db, {
      url: "https://report.example/archive-shell",
      canonicalUrl: "https://report.example/archive-shell",
      sourceName: "Report source",
      sourceCategory: null,
      discoveryMethod: "archive",
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });
    const rejectedUrl = getPendingUrls(db, 10, "Report source", {
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    }).find((row) => row.url.endsWith("/archive-shell"));
    assert.ok(rejectedUrl);
    markUrlStatus(
      db,
      rejectedUrl.id,
      "skipped",
      "GENERIC_OR_ERROR_TITLE",
      queued.job.id
    );
    insertRejectedPage(db, {
      sourceJobId: queued.job.id,
      sourceId: queued.source.id,
      url: "https://report.example/archive-shell",
      stage: "article_quality",
      reasonCode: "GENERIC_OR_ERROR_TITLE",
      publishedDate: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
    });

    const report = buildCoverageReport(db as any, job);
    assert.equal(report.accepted.count, 1);
    assert.equal(report.observedMonths.length, 1);
    assert.equal(report.urlStatuses[0]?.status, "crawled");

    const gate = evaluateCoverageCompletion(report, {
      minimumCoverageMonths: 1,
      minimumAcceptedArticles: 2,
      minimumAcceptanceRate: 0.75
    });
    assert.equal(gate.passed, false);
    assert.ok(gate.failureCodes.includes("INSUFFICIENT_ACCEPTED_ARTICLES"));
    assert.ok(gate.failureCodes.includes("LOW_ACCEPTANCE_RATE"));
    assert.equal(gate.acceptanceRate, 0.5);
  } finally {
    db.close();
  }
});

test("counts a malformed non-null linked legacy date and blocks completion", () => {
  const db = new Database(":memory:");
  ensureSchema(db);

  try {
    const queued = enqueueSource(db, {
      name: "Malformed date source",
      baseUrl: "https://malformed.example",
      minCoverageMonths: 1
    });
    const job = claimNextSourceJob(db, "malformed-worker");
    assert.ok(job);

    insertUrl(db, {
      url: "https://malformed.example/story",
      canonicalUrl: "https://malformed.example/story",
      sourceName: "Malformed date source",
      sourceCategory: null,
      discoveryMethod: "sitemap",
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });
    const pending = getPendingUrls(db, 1, "Malformed date source", {
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });

    assert.equal(
      insertArticle(db, {
        url: pending[0]!.url,
        canonicalUrl: pending[0]!.url,
        sourceName: "Malformed date source",
        sourceCategory: null,
        sourceId: queued.source.id,
        title: "Malformed publication timestamp",
        publishedDate: "not-a-date",
        text: "Detailed evidence and reporting in complete prose sentences. ".repeat(20),
        contentHash: "malformed-date-content",
        qualityScore: 100
      }),
      true
    );
    const articleId = findArticleIdByIdentity(db, {
      url: pending[0]!.url,
      canonicalUrl: pending[0]!.url,
      contentHash: "malformed-date-content"
    });
    assert.ok(articleId);
    linkSourceJobUrlArticle(db, queued.job.id, pending[0]!.id, articleId);
    markUrlStatus(db, pending[0]!.id, "crawled", undefined, queued.job.id);

    const report = buildCoverageReport(db as any, job);
    assert.equal(report.accepted.count, 1);
    assert.equal(report.accepted.invalid_dates, 1);
    assert.equal(report.accepted.unknown_dates, 0);
    assert.equal(report.observedMonths.length, 0);

    const gate = evaluateCoverageCompletion(report, {
      minimumCoverageMonths: 1,
      minimumAcceptedArticles: 1,
      minimumAcceptanceRate: 0.05
    });
    assert.equal(gate.passed, false);
    assert.ok(gate.failureCodes.includes("INVALID_ACCEPTED_DATES"));
    assert.ok(gate.failureCodes.includes("INSUFFICIENT_COVERAGE_MONTHS"));
  } finally {
    db.close();
  }
});

test("completion gate rejects source jobs with pending or failed URLs", () => {
  const db = new Database(":memory:");
  ensureSchema(db);

  try {
    const queued = enqueueSource(db, {
      name: "Incomplete source",
      baseUrl: "https://incomplete.example",
      minCoverageMonths: 1
    });
    const job = claimNextSourceJob(db, "incomplete-worker");
    assert.ok(job);

    for (const slug of ["pending", "failed"]) {
      insertUrl(db, {
        url: `https://incomplete.example/${slug}`,
        canonicalUrl: `https://incomplete.example/${slug}`,
        sourceName: "Incomplete source",
        sourceCategory: null,
        discoveryMethod: "sitemap",
        sourceId: queued.source.id,
        sourceJobId: queued.job.id
      });
    }
    const pending = getPendingUrls(db, 10, "Incomplete source", {
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });
    const failed = pending.find((row) => row.url.endsWith("/failed"));
    assert.ok(failed);
    markUrlStatus(db, failed.id, "failed", "permanent failure", queued.job.id);

    const report = buildCoverageReport(db as any, job);
    const gate = evaluateCoverageCompletion(report, {
      minimumCoverageMonths: 1,
      minimumAcceptedArticles: 1,
      minimumAcceptanceRate: 0.05
    });

    assert.equal(gate.pendingUrlCount, 1);
    assert.equal(gate.failedUrlCount, 1);
    assert.ok(gate.failureCodes.includes("INCOMPLETE_URLS"));
    assert.equal(gate.passed, false);
  } finally {
    db.close();
  }
});
