import os from "node:os";

import { crawlArticles, CrawlRunStats } from "./crawlArticles";
import { openDb } from "./db";
import { discoverSource } from "./main";
import {
  claimNextSourceJob,
  completeSourceJob,
  failSourceJob,
  getSourceQueueStats,
  heartbeatSourceJob,
  requeueStaleSourceJobs,
  SourceJobRecord
} from "./sourceQueue";

type AggregateCrawlStats = Omit<CrawlRunStats, "pendingAfter"> & {
  batches: number;
  pendingAfter: number;
};

class NonRetryableJobError extends Error {
  constructor(message: string, readonly stats?: unknown) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function emptyCrawlStats(): AggregateCrawlStats {
  return {
    batches: 0,
    selected: 0,
    crawled: 0,
    inserted: 0,
    duplicates: 0,
    rejected: 0,
    failed: 0,
    pendingAfter: 0
  };
}

function mergeCrawlStats(target: AggregateCrawlStats, batch: CrawlRunStats) {
  target.batches++;
  target.selected += batch.selected;
  target.crawled += batch.crawled;
  target.inserted += batch.inserted;
  target.duplicates += batch.duplicates;
  target.rejected += batch.rejected;
  target.failed += batch.failed;
  target.pendingAfter = batch.pendingAfter;
}

export function buildCoverageReport(
  db: ReturnType<typeof openDb>,
  job: SourceJobRecord
) {
  const urlStatuses = db
    .prepare(`
      SELECT status, COUNT(*) AS count
      FROM source_job_urls
      WHERE source_job_id = ?
      GROUP BY status
      ORDER BY status
    `)
    .all(job.id) as Array<{ status: string; count: number }>;
  const months = db
    .prepare(`
      SELECT strftime('%Y-%m', published_date) AS month, COUNT(*) AS count
      FROM (
        SELECT DISTINCT a.id, a.published_date
        FROM articles a
        JOIN source_job_urls ju ON ju.article_id = a.id
        WHERE ju.source_job_id = ?
          AND ju.status = 'crawled'
      )
      GROUP BY month
      ORDER BY month
    `)
    .all(job.id) as Array<{ month: string; count: number }>;
  const rejectionReasons = db
    .prepare(`
      SELECT reason_code, COUNT(*) AS count
      FROM rejected_pages
      WHERE source_job_id = ?
      GROUP BY reason_code
      ORDER BY count DESC, reason_code
    `)
    .all(job.id) as Array<{ reason_code: string; count: number }>;
  const accepted = db
    .prepare(`
      SELECT
        COUNT(*) AS count,
        MIN(published_date) AS min_date,
        MAX(published_date) AS max_date,
        COALESCE(SUM(published_date IS NULL), 0) AS unknown_dates,
        COALESCE(SUM(
          published_date IS NOT NULL AND datetime(published_date) IS NULL
        ), 0) AS invalid_dates,
        COALESCE(SUM(
          datetime(published_date) < datetime('now', '-365 days')
        ), 0) AS too_old,
        COALESCE(SUM(
          datetime(published_date) > datetime('now', '+15 minutes')
        ), 0) AS future_dates
      FROM articles a
      JOIN source_job_urls ju ON ju.article_id = a.id
      WHERE ju.source_job_id = ?
        AND ju.status = 'crawled'
    `)
    .get(job.id) as {
      count: number;
      min_date: string | null;
      max_date: string | null;
      unknown_dates: number;
      invalid_dates: number;
      too_old: number;
      future_dates: number;
    };

  const observedMonths = db
    .prepare(`
      SELECT strftime('%Y-%m', published_date) AS month,
             COUNT(*) AS accepted,
             0 AS rejected
      FROM (
        SELECT DISTINCT a.id, a.published_date
        FROM articles a
        JOIN source_job_urls ju ON ju.article_id = a.id
        WHERE ju.source_job_id = ?
          AND ju.status = 'crawled'
          AND datetime(a.published_date) >= datetime('now', '-365 days')
          AND datetime(a.published_date) <= datetime('now', '+15 minutes')
      )
      WHERE month IS NOT NULL
      GROUP BY month
      ORDER BY month
    `)
    .all(job.id) as Array<{
      month: string;
      accepted: number;
      rejected: number;
    }>;

  const expectedMonths: string[] = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 365);
  cutoff.setUTCDate(1);
  cutoff.setUTCHours(0, 0, 0, 0);
  while (cursor >= cutoff) {
    expectedMonths.unshift(
      `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`
    );
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  const observedSet = new Set(observedMonths.map((row) => row.month));
  const missingMonths = expectedMonths.filter((month) => !observedSet.has(month));

  return {
    urlStatuses,
    accepted,
    months,
    observedMonths,
    expectedMonths,
    missingMonths,
    rejectionReasons
  };
}

export type CoverageCompletionFailureCode =
  | "INCOMPLETE_URLS"
  | "INSUFFICIENT_COVERAGE_MONTHS"
  | "INSUFFICIENT_ACCEPTED_ARTICLES"
  | "LOW_ACCEPTANCE_RATE"
  | "UNKNOWN_ACCEPTED_DATES"
  | "INVALID_ACCEPTED_DATES"
  | "ACCEPTED_DATES_TOO_OLD"
  | "ACCEPTED_DATES_IN_FUTURE";

export type CoverageCompletionPolicy = {
  minimumCoverageMonths: number;
  minimumAcceptedArticles: number;
  minimumAcceptanceRate: number;
};

export function evaluateCoverageCompletion(
  coverage: ReturnType<typeof buildCoverageReport>,
  policy: CoverageCompletionPolicy
) {
  if (
    !Number.isInteger(policy.minimumCoverageMonths) ||
    policy.minimumCoverageMonths < 1 ||
    policy.minimumCoverageMonths > 13
  ) {
    throw new Error("minimumCoverageMonths must be an integer between 1 and 13");
  }
  if (
    !Number.isInteger(policy.minimumAcceptedArticles) ||
    policy.minimumAcceptedArticles < 1
  ) {
    throw new Error("minimumAcceptedArticles must be a positive integer");
  }
  if (
    !Number.isFinite(policy.minimumAcceptanceRate) ||
    policy.minimumAcceptanceRate <= 0 ||
    policy.minimumAcceptanceRate > 1
  ) {
    throw new Error("minimumAcceptanceRate must be greater than 0 and at most 1");
  }

  const statusCounts = new Map(
    coverage.urlStatuses.map((row) => [row.status, row.count])
  );
  const acceptedUrlCount = statusCounts.get("crawled") || 0;
  const rejectedUrlCount = statusCounts.get("skipped") || 0;
  const pendingUrlCount = statusCounts.get("pending") || 0;
  const failedUrlCount = statusCounts.get("failed") || 0;
  const reviewedUrlCount = acceptedUrlCount + rejectedUrlCount;
  const acceptanceRate = reviewedUrlCount > 0
    ? acceptedUrlCount / reviewedUrlCount
    : 0;
  const failureCodes: CoverageCompletionFailureCode[] = [];

  if (pendingUrlCount > 0 || failedUrlCount > 0) {
    failureCodes.push("INCOMPLETE_URLS");
  }
  if (coverage.observedMonths.length < policy.minimumCoverageMonths) {
    failureCodes.push("INSUFFICIENT_COVERAGE_MONTHS");
  }
  if (coverage.accepted.count < policy.minimumAcceptedArticles) {
    failureCodes.push("INSUFFICIENT_ACCEPTED_ARTICLES");
  }
  if (acceptanceRate < policy.minimumAcceptanceRate) {
    failureCodes.push("LOW_ACCEPTANCE_RATE");
  }
  if (coverage.accepted.unknown_dates > 0) {
    failureCodes.push("UNKNOWN_ACCEPTED_DATES");
  }
  if (coverage.accepted.invalid_dates > 0) {
    failureCodes.push("INVALID_ACCEPTED_DATES");
  }
  if (coverage.accepted.too_old > 0) {
    failureCodes.push("ACCEPTED_DATES_TOO_OLD");
  }
  if (coverage.accepted.future_dates > 0) {
    failureCodes.push("ACCEPTED_DATES_IN_FUTURE");
  }

  return {
    passed: failureCodes.length === 0,
    failureCodes,
    acceptedArticleCount: coverage.accepted.count,
    acceptedUrlCount,
    rejectedUrlCount,
    pendingUrlCount,
    failedUrlCount,
    reviewedUrlCount,
    acceptanceRate
  };
}

function requireRate(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be greater than 0 and at most 1`);
  }
  return value;
}

async function processJob(db: ReturnType<typeof openDb>, job: SourceJobRecord) {
  console.log(`[SOURCE JOB ${job.id}] ${job.sourceName}`);
  if (job.requestedDaysBack !== 365) {
    throw new Error(
      `Source job ${job.id} requested ${job.requestedDaysBack} days; strict FIFO backfills require 365`
    );
  }

  const workerId = job.workerId || undefined;
  let leaseLost = false;
  const heartbeat = () => {
    if (!heartbeatSourceJob(db, job.id, workerId)) leaseLost = true;
  };
  const heartbeatTimer = setInterval(heartbeat, 30_000);
  heartbeatTimer.unref();

  try {
    heartbeat();
    const discovery = await discoverSource(job.sourceConfig, {
      db,
      sourceId: job.sourceId,
      sourceJobId: job.id,
      daysBack: job.requestedDaysBack
    });
    if (leaseLost) throw new Error(`Source job ${job.id} lost its worker lease`);
    if (discovery.discovered === 0) {
      throw new NonRetryableJobError("Source discovery returned no candidate URLs");
    }

    const aggregate = emptyCrawlStats();
    const batchSize = requirePositiveInteger(
      Number(process.env.CRAWL_BATCH_SIZE || 100),
      "CRAWL_BATCH_SIZE"
    );
    const maxConcurrency = requirePositiveInteger(
      Number(process.env.MAX_CONCURRENCY || 2),
      "MAX_CONCURRENCY"
    );

    while (true) {
      if (leaseLost) throw new Error(`Source job ${job.id} lost its worker lease`);
      const batch = await crawlArticles({
        db,
        limit: batchSize,
        maxConcurrency,
        sourceName: job.sourceName,
        sourceId: job.sourceId,
        sourceJobId: job.id,
        daysBack: job.requestedDaysBack
      });
      mergeCrawlStats(aggregate, batch);
      heartbeat();

      if (batch.selected === 0 || batch.pendingAfter === 0) break;
    }

    if (leaseLost) throw new Error(`Source job ${job.id} lost its worker lease`);
    if (aggregate.pendingAfter !== 0) {
      throw new Error(
        `Source job cannot complete with ${aggregate.pendingAfter} pending URL(s)`
      );
    }

    const coverage = buildCoverageReport(db, job);
    const minimumCoverageMonths =
      job.sourceConfig.minCoverageMonths ??
      requirePositiveInteger(
        Number(process.env.MIN_COVERAGE_MONTHS || 12),
        "MIN_COVERAGE_MONTHS"
      );
    if (minimumCoverageMonths > 13) {
      throw new NonRetryableJobError("MIN_COVERAGE_MONTHS cannot exceed 13");
    }
    const completionGate = evaluateCoverageCompletion(coverage, {
      minimumCoverageMonths,
      minimumAcceptedArticles: requirePositiveInteger(
        Number(process.env.MIN_ACCEPTED_ARTICLES || 10),
        "MIN_ACCEPTED_ARTICLES"
      ),
      minimumAcceptanceRate: requireRate(
        Number(process.env.MIN_ACCEPTANCE_RATE || 0.05),
        "MIN_ACCEPTANCE_RATE"
      )
    });
    if (!completionGate.passed) {
      throw new NonRetryableJobError(
        `Source coverage failed completion gate: ${completionGate.failureCodes.join(", ")}. ` +
          `Accepted articles=${completionGate.acceptedArticleCount}, ` +
          `acceptance rate=${(completionGate.acceptanceRate * 100).toFixed(2)}%, ` +
          `pending URLs=${completionGate.pendingUrlCount}, ` +
          `failed URLs=${completionGate.failedUrlCount}, ` +
          `accepted months=${coverage.observedMonths.length}/${minimumCoverageMonths}. ` +
          `Missing months: ${coverage.missingMonths.join(", ")}`,
        { discovery, crawl: aggregate, coverage, completionGate }
      );
    }
    return { discovery, crawl: aggregate, coverage, completionGate };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function runSourceQueue() {
  const db = openDb();
  const workerId =
    process.env.WORKER_ID || `${os.hostname()}:${process.pid}:${Date.now()}`;
  const maxAttempts = requirePositiveInteger(
    Number(process.env.SOURCE_JOB_MAX_ATTEMPTS || 3),
    "SOURCE_JOB_MAX_ATTEMPTS"
  );
  const pollMs = requirePositiveInteger(
    Number(process.env.QUEUE_POLL_MS || 5000),
    "QUEUE_POLL_MS"
  );
  const staleMinutes = requirePositiveInteger(
    Number(process.env.SOURCE_JOB_STALE_MINUTES || 120),
    "SOURCE_JOB_STALE_MINUTES"
  );
  const runOnce = process.env.WORKER_ONCE === "true";
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const recovered = requeueStaleSourceJobs(
      db,
      staleMinutes
    );
    if (recovered > 0) console.log(`Recovered stale source jobs: ${recovered}`);

    while (!stopping) {
      const job = claimNextSourceJob(db, workerId);
      if (!job) {
        const recoveredWhilePolling = requeueStaleSourceJobs(db, staleMinutes);
        if (recoveredWhilePolling > 0) {
          console.log(`Recovered stale source jobs: ${recoveredWhilePolling}`);
          continue;
        }
        const queue = getSourceQueueStats(db);
        if (runOnce) {
          console.log(JSON.stringify({ workerId, queue }, null, 2));
          return;
        }
        await sleep(pollMs);
        continue;
      }

      try {
        const stats = await processJob(db, job);

        if (stats.crawl.failed > 0) {
          throw new Error(
            `${stats.crawl.failed} URL(s) failed after crawler retries`
          );
        }

        completeSourceJob(db, job.id, stats);
        console.log(`[SOURCE JOB ${job.id}] completed`);
      } catch (error: any) {
        const message = error?.stack || error?.message || String(error);
        const shouldRetry =
          !(error instanceof NonRetryableJobError) &&
          job.attemptCount < maxAttempts;

        if (shouldRetry) {
          db.prepare(`
            UPDATE source_job_urls
            SET status = 'pending', failed_reason = NULL, crawled_at = NULL
            WHERE source_job_id = ? AND status = 'failed'
          `).run(job.id);
        }

        failSourceJob(db, job.id, message, {
          retry: shouldRetry,
          stats:
            error instanceof NonRetryableJobError ? error.stats : undefined
        });
        console.error(
          `[SOURCE JOB ${job.id}] ${shouldRetry ? "queued for retry" : "failed"}: ${message}`
        );

        if (shouldRetry) continue;
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    db.close();
  }
}

if (require.main === module) {
  runSourceQueue().catch((error) => {
    console.error("Source queue worker failed:", error);
    process.exitCode = 1;
  });
}
