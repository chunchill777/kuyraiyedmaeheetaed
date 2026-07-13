import Database from "better-sqlite3";
import crypto from "crypto";
import { Source } from "./types";
import { isPrivateOrLocalHostname } from "./urlSafety";

export type SourceJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SourceRecord = {
  id: number;
  sourceKey: string;
  name: string;
  category: string | null;
  config: Source;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SourceJobRecord = {
  id: number;
  sourceId: number;
  sourceKey: string;
  sourceName: string;
  sourceCategory: string | null;
  sourceConfig: Source;
  status: SourceJobStatus;
  requestedDaysBack: number;
  attemptCount: number;
  workerId: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  error: string | null;
  stats: unknown | null;
};

export type EnqueueSourceResult = {
  source: SourceRecord;
  job: SourceJobRecord;
  enqueued: boolean;
};

type SourceRow = {
  id: number;
  source_key: string;
  name: string;
  category: string | null;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type SourceJobRow = {
  id: number;
  source_id: number;
  source_key: string;
  source_name: string;
  source_category: string | null;
  config_json: string;
  status: SourceJobStatus;
  requested_days_back: number;
  attempt_count: number;
  worker_id: string | null;
  enqueued_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  error: string | null;
  stats_json: string | null;
};

const SOURCE_JOB_SELECT = `
  SELECT
    j.id,
    j.source_id,
    s.source_key,
    s.name AS source_name,
    s.category AS source_category,
    s.config_json,
    j.status,
    j.requested_days_back,
    j.attempt_count,
    j.worker_id,
    j.enqueued_at,
    j.started_at,
    j.heartbeat_at,
    j.completed_at,
    j.error,
    j.stats_json
  FROM source_jobs j
  JOIN sources s ON s.id = j.source_id
`;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        result[key] = stableValue(record[key]);
      }
    }

    return result;
  }

  return value;
}

/** Stable JSON makes queue identity independent of object-key insertion order. */
export function serializeSourceConfig(source: Source): string {
  return JSON.stringify(stableValue(source));
}

/**
 * Generate a deterministic key from the complete source configuration.
 * A changed config intentionally receives a new identity and a new job.
 */
export function generateSourceKey(source: Source): string {
  const configJson = serializeSourceConfig(source);
  const digest = crypto.createHash("sha256").update(configJson).digest("hex");
  const slug = source.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${slug || "source"}:${digest.slice(0, 24)}`;
}

function parseJson(value: string | null): unknown | null {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    sourceKey: row.source_key,
    name: row.name,
    category: row.category,
    config: JSON.parse(row.config_json) as Source,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toJob(row: SourceJobRow): SourceJobRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    sourceCategory: row.source_category,
    sourceConfig: JSON.parse(row.config_json) as Source,
    status: row.status,
    requestedDaysBack: row.requested_days_back,
    attemptCount: row.attempt_count,
    workerId: row.worker_id,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
    error: row.error,
    stats: parseJson(row.stats_json)
  };
}

function requireValidSource(source: Source) {
  if (!source || typeof source !== "object") {
    throw new Error("Source config must be an object");
  }

  if (!source.name || !source.name.trim()) {
    throw new Error("Source name is required");
  }
  if (source.name.trim().length > 200) {
    throw new Error("Source name cannot exceed 200 characters");
  }

  for (const key of [
    "startUrls",
    "sitemapUrls",
    "archiveUrlTemplates",
    "dailySearchUrlTemplates",
    "searchUrlTemplates"
  ] as const) {
    const values = source[key];
    if (values !== undefined && !Array.isArray(values)) {
      throw new Error(`${key} must be an array`);
    }
    if (values && values.length > 100) {
      throw new Error(`${key} cannot contain more than 100 entries`);
    }
    if (values?.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`${key} must contain non-empty URL strings`);
    }
  }
  for (const key of ["baseUrl", "homepageUrl", "feedUrl"] as const) {
    const value = source[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`${key} must be a non-empty URL string`);
    }
  }

  const allowedCategories = new Set([
    "social",
    "technology",
    "economic",
    "environmental",
    "political",
    "general"
  ]);
  if (source.category !== undefined && typeof source.category !== "string") {
    throw new Error("Source category must be a string");
  }
  if (source.category && !allowedCategories.has(source.category.toLowerCase())) {
    throw new Error(`Unsupported source category: ${source.category}`);
  }
  if (
    source.minCoverageMonths !== undefined &&
    (!Number.isInteger(source.minCoverageMonths) ||
      source.minCoverageMonths < 1 ||
      source.minCoverageMonths > 13)
  ) {
    throw new Error("minCoverageMonths must be an integer between 1 and 13");
  }

  const entryUrls = [
    source.baseUrl,
    source.homepageUrl,
    ...(source.startUrls || []),
    ...(source.sitemapUrls || [])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  if (entryUrls.length === 0) {
    throw new Error(
      `Source ${source.name} needs a baseUrl, homepageUrl, startUrl, or sitemapUrl`
    );
  }

  const allUrls = [
    ...entryUrls,
    ...(source.feedUrl ? [source.feedUrl] : []),
    ...(source.archiveUrlTemplates || []),
    ...(source.dailySearchUrlTemplates || []),
    ...(source.searchUrlTemplates || [])
  ];

  for (const raw of allUrls) {
    const rendered = raw
      .replaceAll("{yyyy}", "2026")
      .replaceAll("{yy}", "26")
      .replaceAll("{mm}", "07")
      .replaceAll("{m}", "7")
      .replaceAll("{dd}", "13")
      .replaceAll("{d}", "13")
      .replaceAll("{date}", "2026-07-13");
    const parsed = new URL(rendered);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Source URLs must use HTTP(S): ${raw}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`Source URLs cannot contain credentials: ${raw}`);
    }

    if (isPrivateOrLocalHostname(parsed.hostname)) {
      throw new Error(
        `Private/local source hosts are not allowed: ${parsed.hostname}`
      );
    }
  }
}

function requireDaysBack(daysBack: number) {
  if (daysBack !== 365) {
    throw new Error("requestedDaysBack must be exactly 365");
  }
}

function getSourceById(db: Database.Database, sourceId: number): SourceRecord {
  const row = db
    .prepare(`SELECT * FROM sources WHERE id = ?`)
    .get(sourceId) as SourceRow | undefined;

  if (!row) {
    throw new Error(`Source not found: ${sourceId}`);
  }

  return toSource(row);
}

export function getSourceJob(
  db: Database.Database,
  jobId: number
): SourceJobRecord | null {
  const row = db
    .prepare(`${SOURCE_JOB_SELECT} WHERE j.id = ?`)
    .get(jobId) as SourceJobRow | undefined;

  return row ? toJob(row) : null;
}

/**
 * Add a source to the end of the persistent queue. Re-enqueuing an identical
 * config while it is queued/running returns the existing job, preventing a
 * duplicate active backfill.
 */
export function enqueueSource(
  db: Database.Database,
  source: Source,
  options: { requestedDaysBack?: number } = {}
): EnqueueSourceResult {
  requireValidSource(source);

  const requestedDaysBack = options.requestedDaysBack ?? 365;
  requireDaysBack(requestedDaysBack);

  const sourceKey = generateSourceKey(source);
  const configJson = serializeSourceConfig(source);

  const enqueue = db.transaction((): EnqueueSourceResult => {
    db.prepare(`
      INSERT INTO sources (source_key, name, category, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        config_json = excluded.config_json,
        enabled = 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(sourceKey, source.name.trim(), source.category || null, configJson);

    const sourceRow = db
      .prepare(`SELECT * FROM sources WHERE source_key = ?`)
      .get(sourceKey) as SourceRow;

    const active = db
      .prepare(`
        ${SOURCE_JOB_SELECT}
        WHERE j.source_id = ? AND j.status IN ('queued', 'running')
        ORDER BY j.id ASC
        LIMIT 1
      `)
      .get(sourceRow.id) as SourceJobRow | undefined;

    if (active) {
      return {
        source: toSource(sourceRow),
        job: toJob(active),
        enqueued: false
      };
    }

    const insert = db
      .prepare(`
        INSERT INTO source_jobs (source_id, status, requested_days_back)
        VALUES (?, 'queued', ?)
      `)
      .run(sourceRow.id, requestedDaysBack);

    const job = getSourceJob(db, Number(insert.lastInsertRowid));
    if (!job) throw new Error("Failed to read the newly enqueued source job");

    return {
      source: toSource(sourceRow),
      job,
      enqueued: true
    };
  });

  return enqueue.immediate();
}

/**
 * Atomically claim the oldest queued source. Strict FIFO is enforced globally:
 * while one source is running, no later source can be claimed.
 */
export function claimNextSourceJob(
  db: Database.Database,
  workerId: string = "default"
): SourceJobRecord | null {
  if (!workerId.trim()) {
    throw new Error("workerId cannot be empty");
  }

  const claim = db.transaction((): SourceJobRecord | null => {
    const running = db
      .prepare(`SELECT id FROM source_jobs WHERE status = 'running' LIMIT 1`)
      .get() as { id: number } | undefined;

    if (running) return null;

    const next = db
      .prepare(`
        SELECT j.id
        FROM source_jobs j
        JOIN sources s ON s.id = j.source_id
        WHERE j.status = 'queued' AND s.enabled = 1
        ORDER BY j.id ASC
        LIMIT 1
      `)
      .get() as { id: number } | undefined;

    if (!next) return null;

    const result = db
      .prepare(`
        UPDATE source_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            worker_id = ?,
            started_at = CURRENT_TIMESTAMP,
            heartbeat_at = CURRENT_TIMESTAMP,
            completed_at = NULL,
            error = NULL
        WHERE id = ? AND status = 'queued'
      `)
      .run(workerId.trim(), next.id);

    if (result.changes !== 1) return null;
    return getSourceJob(db, next.id);
  });

  return claim.immediate();
}

export function heartbeatSourceJob(
  db: Database.Database,
  jobId: number,
  workerId?: string
): boolean {
  const result = workerId
    ? db
        .prepare(`
          UPDATE source_jobs
          SET heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running' AND worker_id = ?
        `)
        .run(jobId, workerId)
    : db
        .prepare(`
          UPDATE source_jobs
          SET heartbeat_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running'
        `)
        .run(jobId);

  return result.changes === 1;
}

/** Recover a job left running by a crashed worker. Active workers heartbeat
 * between crawl batches, so the timeout should stay comfortably above one batch.
 */
export function requeueStaleSourceJobs(
  db: Database.Database,
  staleAfterMinutes = 120
): number {
  if (!Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 1) {
    throw new Error("staleAfterMinutes must be at least 1");
  }

  const cutoff = `-${Math.floor(staleAfterMinutes)} minutes`;
  const recover = db.transaction(() => {
    const rows = db
      .prepare(`
        SELECT id
        FROM source_jobs
        WHERE status = 'running'
          AND datetime(COALESCE(heartbeat_at, started_at, enqueued_at))
              < datetime('now', ?)
      `)
      .all(cutoff) as Array<{ id: number }>;

    for (const row of rows) {
      db.prepare(`
        UPDATE source_job_urls
        SET status = 'pending', failed_reason = NULL, crawled_at = NULL
        WHERE source_job_id = ? AND status = 'failed'
      `).run(row.id);
    }

    const update = db.prepare(`
      UPDATE source_jobs
      SET status = 'queued',
          worker_id = NULL,
          started_at = NULL,
          heartbeat_at = NULL,
          completed_at = NULL,
          error = 'Recovered after stale worker heartbeat'
      WHERE status = 'running'
        AND datetime(COALESCE(heartbeat_at, started_at, enqueued_at))
            < datetime('now', ?)
    `).run(cutoff);

    return update.changes;
  });

  return recover.immediate();
}

export function completeSourceJob(
  db: Database.Database,
  jobId: number,
  stats?: unknown
): SourceJobRecord {
  const statsJson = stats === undefined ? null : JSON.stringify(stableValue(stats));
  const result = db
    .prepare(`
      UPDATE source_jobs
      SET status = 'completed',
          completed_at = CURRENT_TIMESTAMP,
          heartbeat_at = CURRENT_TIMESTAMP,
          error = NULL,
          stats_json = ?
      WHERE id = ? AND status = 'running'
    `)
    .run(statsJson, jobId);

  if (result.changes !== 1) {
    throw new Error(`Cannot complete source job ${jobId}: it is not running`);
  }

  return getSourceJob(db, jobId)!;
}

export function failSourceJob(
  db: Database.Database,
  jobId: number,
  error: string,
  options: { retry?: boolean; stats?: unknown } = {}
): SourceJobRecord {
  const message = error.trim() || "Unknown source job failure";
  const statsJson =
    options.stats === undefined
      ? null
      : JSON.stringify(stableValue(options.stats));

  const result = options.retry
    ? db
        .prepare(`
          UPDATE source_jobs
          SET status = 'queued',
              worker_id = NULL,
              started_at = NULL,
              heartbeat_at = NULL,
              completed_at = NULL,
              error = ?,
              stats_json = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(message, statsJson, jobId)
    : db
        .prepare(`
          UPDATE source_jobs
          SET status = 'failed',
              completed_at = CURRENT_TIMESTAMP,
              heartbeat_at = CURRENT_TIMESTAMP,
              error = ?,
              stats_json = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(message, statsJson, jobId);

  if (result.changes !== 1) {
    throw new Error(`Cannot fail source job ${jobId}: it is not running`);
  }

  return getSourceJob(db, jobId)!;
}

export type SourceQueueStats = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  current: SourceJobRecord | null;
  next: SourceJobRecord | null;
};

export function getSourceQueueStats(db: Database.Database): SourceQueueStats {
  const rows = db
    .prepare(`
      SELECT status, COUNT(*) AS count
      FROM source_jobs
      GROUP BY status
    `)
    .all() as Array<{ status: SourceJobStatus; count: number }>;

  const counts: Record<SourceJobStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  };

  for (const row of rows) counts[row.status] = row.count;

  const currentRow = db
    .prepare(`${SOURCE_JOB_SELECT} WHERE j.status = 'running' ORDER BY j.id LIMIT 1`)
    .get() as SourceJobRow | undefined;
  const nextRow = db
    .prepare(`
      ${SOURCE_JOB_SELECT}
      WHERE j.status = 'queued' AND s.enabled = 1
      ORDER BY j.id ASC
      LIMIT 1
    `)
    .get() as SourceJobRow | undefined;

  return {
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    ...counts,
    current: currentRow ? toJob(currentRow) : null,
    next: nextRow ? toJob(nextRow) : null
  };
}

/**
 * Explicit one-time administrative action for the pre-source-job URL queue.
 * It preserves rows for audit and only clears pending URLs with no job owner.
 * Nothing calls this automatically during module import or database open.
 */
export function clearLegacyPendingQueue(
  db: Database.Database,
  reason: string = "Legacy pending queue cleared before FIFO source jobs"
): number {
  const result = db
    .prepare(`
      UPDATE urls
      SET status = 'skipped',
          crawled_at = CURRENT_TIMESTAMP,
          failed_reason = ?
      WHERE status = 'pending' AND source_job_id IS NULL
    `)
    .run(reason);

  return result.changes;
}

export function setSourceEnabled(
  db: Database.Database,
  sourceId: number,
  enabled: boolean
): SourceRecord {
  const update = db.transaction(() => {
    if (!enabled) {
      const running = db
        .prepare(`
          SELECT id FROM source_jobs
          WHERE source_id = ? AND status = 'running'
          LIMIT 1
        `)
        .get(sourceId) as { id: number } | undefined;
      if (running) {
        throw new Error(
          `Cannot disable source ${sourceId} while job ${running.id} is running`
        );
      }

      db.prepare(`
        UPDATE source_jobs
        SET status = 'cancelled',
            completed_at = CURRENT_TIMESTAMP,
            error = 'Source disabled before processing'
        WHERE source_id = ? AND status = 'queued'
      `).run(sourceId);
    }

    const result = db
      .prepare(`
        UPDATE sources
        SET enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(enabled ? 1 : 0, sourceId);

    if (result.changes !== 1) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    return getSourceById(db, sourceId);
  });

  return update.immediate();
}
