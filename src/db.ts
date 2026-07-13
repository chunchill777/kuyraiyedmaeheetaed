import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.CRAWLER_DB_PATH || "./data/crawler.db";
const SCHEMA_VERSION = 5;

type StatementCache = {
  insertUrl?: any;
  selectUrl?: any;
  insertSourceJobUrl?: any;
  markUrlStatus?: any;
  markSourceJobUrlStatus?: any;
  insertArticle?: any;
  selectExistingArticle?: any;
  selectArticleUpgradeConflict?: any;
  upgradeLegacyArticle?: any;
  insertRejectedPage?: any;
};

const statementCaches = new WeakMap<Database.Database, StatementCache>();

function getStatementCache(db: Database.Database): StatementCache {
  let cache = statementCaches.get(db);

  if (!cache) {
    cache = {};
    statementCaches.set(db, cache);
  }

  return cache;
}

function tableHasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;

  return columns.some((item) => item.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  );
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
) {
  if (!tableHasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Apply additive, backwards-compatible schema migrations.
 *
 * This function deliberately does not modify existing rows or clear queues.
 * It is exported so tests and callers using an in-memory database can opt in.
 */
export function ensureSchema(db: Database.Database) {
  db.pragma("foreign_keys = ON");
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS source_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        requested_days_back INTEGER NOT NULL DEFAULT 365,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        error TEXT,
        stats_json TEXT
      );

      CREATE TABLE IF NOT EXISTS urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        source_name TEXT NOT NULL,
        source_category TEXT,
        discovery_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        crawled_at TEXT,
        failed_reason TEXT,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        source_job_id INTEGER REFERENCES source_jobs(id) ON DELETE SET NULL,
        canonical_url TEXT,
        crawl_attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        claimed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS rejected_pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url_id INTEGER REFERENCES urls(id) ON DELETE SET NULL,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        source_job_id INTEGER REFERENCES source_jobs(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        stage TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason_details TEXT,
        title TEXT,
        published_date TEXT,
        text_length INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS source_job_urls (
        source_job_id INTEGER NOT NULL REFERENCES source_jobs(id) ON DELETE CASCADE,
        url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
        article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'crawled', 'skipped', 'failed')),
        discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        crawled_at TEXT,
        failed_reason TEXT,
        crawl_attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        PRIMARY KEY (source_job_id, url_id)
      );
    `);

    // Existing crawler databases predate source/job-aware crawling. SQLite's
    // ADD COLUMN keeps all old rows intact and gives them NULL ownership.
    addColumnIfMissing(
      db,
      "urls",
      "source_id",
      "INTEGER REFERENCES sources(id) ON DELETE SET NULL"
    );
    addColumnIfMissing(
      db,
      "urls",
      "source_job_id",
      "INTEGER REFERENCES source_jobs(id) ON DELETE SET NULL"
    );
    addColumnIfMissing(db, "urls", "canonical_url", "TEXT");
    addColumnIfMissing(
      db,
      "urls",
      "crawl_attempt_count",
      "INTEGER NOT NULL DEFAULT 0"
    );
    addColumnIfMissing(db, "urls", "last_attempt_at", "TEXT");
    addColumnIfMissing(db, "urls", "claimed_at", "TEXT");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_urls_status ON urls(status);
      CREATE INDEX IF NOT EXISTS idx_urls_source ON urls(source_name);
      CREATE INDEX IF NOT EXISTS idx_urls_method ON urls(discovery_method);
      CREATE INDEX IF NOT EXISTS idx_urls_source_id ON urls(source_id);
      CREATE INDEX IF NOT EXISTS idx_urls_source_job_status
        ON urls(source_job_id, status, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_canonical_unique
        ON urls(canonical_url)
        WHERE canonical_url IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sources_enabled
        ON sources(enabled, id);
      CREATE INDEX IF NOT EXISTS idx_source_jobs_fifo
        ON source_jobs(status, id);
      CREATE INDEX IF NOT EXISTS idx_source_jobs_source
        ON source_jobs(source_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_source_jobs_one_active_per_source
        ON source_jobs(source_id)
        WHERE status IN ('queued', 'running');

      CREATE INDEX IF NOT EXISTS idx_rejected_pages_job
        ON rejected_pages(source_job_id, id);
      CREATE INDEX IF NOT EXISTS idx_rejected_pages_reason
        ON rejected_pages(reason_code, id);
      CREATE INDEX IF NOT EXISTS idx_source_job_urls_status
        ON source_job_urls(source_job_id, status, url_id);

      CREATE TRIGGER IF NOT EXISTS trg_source_jobs_365_insert
      BEFORE INSERT ON source_jobs
      WHEN NEW.requested_days_back <> 365
      BEGIN
        SELECT RAISE(ABORT, 'source jobs must request exactly 365 days');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_source_jobs_365_update
      BEFORE UPDATE OF requested_days_back ON source_jobs
      WHEN NEW.requested_days_back <> 365
      BEGIN
        SELECT RAISE(ABORT, 'source jobs must request exactly 365 days');
      END;
    `);

    ensureArticleTables(db);
    addColumnIfMissing(
      db,
      "source_job_urls",
      "article_id",
      "INTEGER REFERENCES articles(id) ON DELETE SET NULL"
    );
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_source_job_urls_article
        ON source_job_urls(article_id);
    `);
    if (currentVersion < SCHEMA_VERSION) {
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  });

  migrate.immediate();
}

export function openDb(dbPath: string = DB_PATH) {
  const dir = path.dirname(dbPath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);

  return db;
}

export type InsertUrlInput = {
  url: string;
  sourceName: string;
  sourceCategory: string | null;
  discoveryMethod: string;
  sourceId?: number | null;
  sourceJobId?: number | null;
  canonicalUrl?: string | null;
};

export function insertUrl(db: Database.Database, input: InsertUrlInput): boolean {
  const cache = getStatementCache(db);

  if (!cache.insertUrl) {
    cache.insertUrl = db.prepare(`
      INSERT OR IGNORE INTO urls (
        url,
        source_name,
        source_category,
        discovery_method,
        source_id,
        source_job_id,
        canonical_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    cache.selectUrl = db.prepare(`
      SELECT id
      FROM urls
      WHERE url = ?
         OR (? IS NOT NULL AND canonical_url = ?)
      ORDER BY CASE WHEN url = ? THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `);
    cache.insertSourceJobUrl = db.prepare(`
      INSERT OR IGNORE INTO source_job_urls (source_job_id, url_id)
      VALUES (?, ?)
    `);
  }

  const insertResult = cache.insertUrl.run(
    input.url,
    input.sourceName,
    input.sourceCategory,
    input.discoveryMethod,
    input.sourceId ?? null,
    input.sourceJobId ?? null,
    input.canonicalUrl ?? null
  );

  if (input.sourceJobId === undefined || input.sourceJobId === null) {
    return insertResult.changes > 0;
  }

  const row = cache.selectUrl.get(
    input.url,
    input.canonicalUrl ?? null,
    input.canonicalUrl ?? null,
    input.url
  ) as { id: number } | undefined;
  if (!row) {
    throw new Error(`Unable to associate discovered URL: ${input.url}`);
  }

  const association = cache.insertSourceJobUrl.run(input.sourceJobId, row.id);
  return association.changes > 0;
}

export function insertUrls(
  db: Database.Database,
  inputs: InsertUrlInput[]
): { inserted: number; duplicated: number } {
  let inserted = 0;

  const tx = db.transaction((items: InsertUrlInput[]) => {
    for (const input of items) {
      if (insertUrl(db, input)) {
        inserted++;
      }
    }
  });

  tx(inputs);

  return {
    inserted,
    duplicated: inputs.length - inserted
  };
}

export function getUrlStats(db: Database.Database) {
  const total = db.prepare(`SELECT COUNT(*) as count FROM urls`).get() as {
    count: number;
  };

  const pending = db
    .prepare(`SELECT COUNT(*) as count FROM urls WHERE status = 'pending'`)
    .get() as { count: number };

  const byMethod = db
    .prepare(`
      SELECT discovery_method, COUNT(*) as count
      FROM urls
      GROUP BY discovery_method
      ORDER BY count DESC
    `)
    .all() as Array<{ discovery_method: string; count: number }>;

  return {
    total: total.count,
    pending: pending.count,
    byMethod
  };
}

export type PendingUrl = {
  id: number;
  url: string;
  source_name: string;
  source_category: string | null;
  source_id?: number | null;
  source_job_id?: number | null;
  canonical_url?: string | null;
};

export type PendingUrlSelector = {
  sourceId?: number;
  sourceJobId?: number;
};

export type InsertArticleInput = {
  url: string;
  sourceName: string;
  sourceCategory: string | null;
  title: string;
  publishedDate: string | null;
  text: string;
  contentHash: string;
  sourceId?: number | null;
  sourceJobId?: number | null;
  canonicalUrl?: string | null;
  qualityScore?: number | null;
};

export function ensureArticleTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      source_name TEXT NOT NULL,
      source_category TEXT,
      title TEXT NOT NULL,
      published_date TEXT,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      source_job_id INTEGER REFERENCES source_jobs(id) ON DELETE SET NULL,
      canonical_url TEXT,
      cleaned_at TEXT,
      quality_score REAL
    );
  `);

  addColumnIfMissing(
    db,
    "articles",
    "source_id",
    "INTEGER REFERENCES sources(id) ON DELETE SET NULL"
  );
  addColumnIfMissing(
    db,
    "articles",
    "source_job_id",
    "INTEGER REFERENCES source_jobs(id) ON DELETE SET NULL"
  );
  addColumnIfMissing(db, "articles", "canonical_url", "TEXT");
  addColumnIfMissing(db, "articles", "cleaned_at", "TEXT");
  addColumnIfMissing(db, "articles", "quality_score", "REAL");

  // Recreate owned triggers so opening an existing database upgrades their
  // definitions instead of retaining an older, weaker CREATE IF NOT EXISTS
  // version.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_fifo_article_quality_insert;
    DROP TRIGGER IF EXISTS trg_fifo_article_duplicate_insert;
    DROP TRIGGER IF EXISTS trg_fifo_article_quality_update;
    DROP TRIGGER IF EXISTS trg_fifo_article_duplicate_update;

    CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_name);
    CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_date);
    CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);
    CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);
    CREATE INDEX IF NOT EXISTS idx_articles_source_job
      ON articles(source_job_id, id);
    CREATE INDEX IF NOT EXISTS idx_articles_canonical
      ON articles(canonical_url);

    CREATE TRIGGER IF NOT EXISTS trg_fifo_article_quality_insert
    BEFORE INSERT ON articles
    WHEN NEW.source_job_id IS NOT NULL
      AND (
        NEW.canonical_url IS NULL
        OR NEW.published_date IS NULL
        OR datetime(NEW.published_date) IS NULL
        OR datetime(NEW.published_date) < datetime('now', '-365 days')
        OR datetime(NEW.published_date) > datetime('now', '+15 minutes')
        OR length(NEW.text) < 700
        OR NEW.quality_score IS NULL
        OR NEW.quality_score < 70
      )
    BEGIN
      SELECT RAISE(ABORT, 'FIFO article failed database quality constraints');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_fifo_article_duplicate_insert
    BEFORE INSERT ON articles
    WHEN NEW.source_job_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM articles existing
        WHERE existing.content_hash = NEW.content_hash
           OR (
             NEW.canonical_url IS NOT NULL
             AND existing.canonical_url = NEW.canonical_url
           )
      )
    BEGIN
      SELECT RAISE(ABORT, 'FIFO article duplicates existing accepted content');
    END;

    CREATE TRIGGER trg_fifo_article_quality_update
    BEFORE UPDATE ON articles
    WHEN NEW.source_job_id IS NOT NULL
      AND (
        NEW.canonical_url IS NULL
        OR NEW.published_date IS NULL
        OR datetime(NEW.published_date) IS NULL
        OR datetime(NEW.published_date) < datetime('now', '-365 days')
        OR datetime(NEW.published_date) > datetime('now', '+15 minutes')
        OR length(NEW.text) < 700
        OR NEW.quality_score IS NULL
        OR NEW.quality_score < 70
      )
    BEGIN
      SELECT RAISE(ABORT, 'FIFO article failed database quality constraints');
    END;

    CREATE TRIGGER trg_fifo_article_duplicate_update
    BEFORE UPDATE OF content_hash, canonical_url, source_job_id ON articles
    WHEN NEW.source_job_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM articles existing
        WHERE existing.id <> NEW.id
          AND (
            existing.content_hash = NEW.content_hash
            OR (
              NEW.canonical_url IS NOT NULL
              AND existing.canonical_url = NEW.canonical_url
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'FIFO article duplicates existing accepted content');
    END;
  `);
}

function buildPendingUrlQuery(
  limit: number,
  sourceName?: string,
  selector: PendingUrlSelector = {},
  domains: string[] = []
): { sql: string; params: Array<string | number> } {
  const where = [`status = 'pending'`];
  const params: Array<string | number> = [];

  if (sourceName) {
    where.push("source_name LIKE ?");
    params.push(`%${sourceName}%`);
  }

  if (selector.sourceId !== undefined) {
    where.push("source_id = ?");
    params.push(selector.sourceId);
  }

  if (selector.sourceJobId !== undefined) {
    where.push("source_job_id = ?");
    params.push(selector.sourceJobId);
  }

  if (domains.length > 0) {
    where.push(`(${domains.map(() => "lower(url) LIKE ?").join(" OR ")})`);
    params.push(...domains.map((domain) => `%${domain.toLowerCase()}%`));
  }

  params.push(limit);

  return {
    sql: `
      SELECT id, url, source_name, source_category,
             source_id, source_job_id, canonical_url
      FROM urls
      WHERE ${where.join(" AND ")}
      ORDER BY id ASC
      LIMIT ?
    `,
    params
  };
}

function buildSourceJobPendingUrlQuery(
  limit: number,
  sourceJobId: number,
  sourceName?: string,
  selector: PendingUrlSelector = {},
  domains: string[] = []
): { sql: string; params: Array<string | number> } {
  const where = ["ju.status = 'pending'", "ju.source_job_id = ?"];
  const params: Array<string | number> = [sourceJobId];

  if (sourceName) {
    where.push("s.name LIKE ?");
    params.push(`%${sourceName}%`);
  }
  if (selector.sourceId !== undefined) {
    where.push("j.source_id = ?");
    params.push(selector.sourceId);
  }
  if (domains.length > 0) {
    where.push(`(${domains.map(() => "lower(u.url) LIKE ?").join(" OR ")})`);
    params.push(...domains.map((domain) => `%${domain.toLowerCase()}%`));
  }
  params.push(limit);

  return {
    sql: `
      SELECT u.id, u.url, s.name AS source_name, s.category AS source_category,
             j.source_id, ju.source_job_id, u.canonical_url
      FROM source_job_urls ju
      JOIN urls u ON u.id = ju.url_id
      JOIN source_jobs j ON j.id = ju.source_job_id
      JOIN sources s ON s.id = j.source_id
      WHERE ${where.join(" AND ")}
      ORDER BY u.id ASC
      LIMIT ?
    `,
    params
  };
}

/**
 * Return pending URLs in insertion order. The optional source/job selector is
 * additive, preserving the original three-argument API.
 */
export function getPendingUrls(
  db: Database.Database,
  limit: number,
  sourceName?: string,
  selector: PendingUrlSelector = {}
): PendingUrl[] {
  const query = selector.sourceJobId !== undefined
    ? buildSourceJobPendingUrlQuery(
        limit,
        selector.sourceJobId,
        sourceName,
        selector
      )
    : buildPendingUrlQuery(limit, sourceName, selector);
  return db.prepare(query.sql).all(...query.params) as PendingUrl[];
}

/**
 * Compatibility selector for callers that still request a domain subset.
 * Domains are filters only; they no longer alter FIFO ordering.
 */
export function getPendingUrlsForDomains(
  db: Database.Database,
  limit: number,
  domains: string[],
  sourceName?: string,
  selector: PendingUrlSelector = {}
): PendingUrl[] {
  if (domains.length === 0) {
    return [];
  }

  const query = selector.sourceJobId !== undefined
    ? buildSourceJobPendingUrlQuery(
        limit,
        selector.sourceJobId,
        sourceName,
        selector,
        domains
      )
    : buildPendingUrlQuery(limit, sourceName, selector, domains);
  return db.prepare(query.sql).all(...query.params) as PendingUrl[];
}

export function markUrlStatus(
  db: Database.Database,
  id: number,
  status: "pending" | "crawled" | "skipped" | "failed",
  failedReason?: string,
  sourceJobId?: number
) {
  const cache = getStatementCache(db);

  if (sourceJobId !== undefined) {
    if (!cache.markSourceJobUrlStatus) {
      cache.markSourceJobUrlStatus = db.prepare(`
        UPDATE source_job_urls
        SET status = ?,
            crawled_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END,
            last_attempt_at = CASE WHEN ? = 'pending' THEN last_attempt_at ELSE CURRENT_TIMESTAMP END,
            crawl_attempt_count = crawl_attempt_count + CASE WHEN ? = 'pending' THEN 0 ELSE 1 END,
            failed_reason = ?
        WHERE source_job_id = ? AND url_id = ?
      `);
    }

    cache.markSourceJobUrlStatus.run(
      status,
      status,
      status,
      status,
      failedReason || null,
      sourceJobId,
      id
    );
    return;
  }

  if (!cache.markUrlStatus) {
    cache.markUrlStatus = db.prepare(`
      UPDATE urls
      SET status = ?,
          crawled_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END,
          last_attempt_at = CASE WHEN ? = 'pending' THEN last_attempt_at ELSE CURRENT_TIMESTAMP END,
          crawl_attempt_count = crawl_attempt_count + CASE WHEN ? = 'pending' THEN 0 ELSE 1 END,
          failed_reason = ?
      WHERE id = ?
    `);
  }

  cache.markUrlStatus.run(
    status,
    status,
    status,
    status,
    failedReason || null,
    id
  );
}

export function insertArticle(
  db: Database.Database,
  input: InsertArticleInput
): boolean {
  const cache = getStatementCache(db);

  if (!cache.insertArticle) {
    cache.selectExistingArticle = db.prepare(`
      SELECT id, source_job_id, quality_score
      FROM articles
      WHERE url = ?
         OR (? IS NOT NULL AND canonical_url = ?)
         OR content_hash = ?
      ORDER BY
        CASE WHEN url = ? THEN 0 ELSE 1 END,
        CASE WHEN ? IS NOT NULL AND canonical_url = ? THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
    `);
    cache.selectArticleUpgradeConflict = db.prepare(`
      SELECT id
      FROM articles
      WHERE id <> ?
        AND (
          content_hash = ?
          OR (? IS NOT NULL AND canonical_url = ?)
        )
      LIMIT 1
    `);
    cache.upgradeLegacyArticle = db.prepare(`
      UPDATE articles
      SET source_name = ?,
          source_category = ?,
          title = ?,
          published_date = ?,
          text = ?,
          content_hash = ?,
          source_id = ?,
          source_job_id = ?,
          canonical_url = ?,
          cleaned_at = CURRENT_TIMESTAMP,
          quality_score = ?
      WHERE id = ?
    `);
    cache.insertArticle = db.prepare(`
      INSERT OR IGNORE INTO articles (
        url,
        source_name,
        source_category,
        title,
        published_date,
        text,
        content_hash,
        source_id,
        source_job_id,
        canonical_url,
        cleaned_at,
        quality_score
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM articles
        WHERE content_hash = ?
           OR (? IS NOT NULL AND canonical_url = ?)
      )
    `);
  }

  const existing = cache.selectExistingArticle.get(
    input.url,
    input.canonicalUrl ?? null,
    input.canonicalUrl ?? null,
    input.contentHash,
    input.url,
    input.canonicalUrl ?? null,
    input.canonicalUrl ?? null
  ) as
    | { id: number; source_job_id: number | null; quality_score: number | null }
    | undefined;

  if (existing && existing.quality_score === null) {
    const upgrade = db.transaction((): boolean => {
      const conflict = cache.selectArticleUpgradeConflict.get(
        existing.id,
        input.contentHash,
        input.canonicalUrl ?? null,
        input.canonicalUrl ?? null
      ) as { id: number } | undefined;
      if (conflict) return false;

      if (tableExists(db, "matches")) {
        db.prepare(`DELETE FROM matches WHERE article_id = ?`).run(existing.id);
      }
      if (tableExists(db, "article_classifications")) {
        db.prepare(`DELETE FROM article_classifications WHERE article_id = ?`).run(
          existing.id
        );
      }

      cache.upgradeLegacyArticle.run(
        input.sourceName,
        input.sourceCategory,
        input.title,
        input.publishedDate,
        input.text,
        input.contentHash,
        input.sourceId ?? null,
        input.sourceJobId ?? null,
        input.canonicalUrl ?? null,
        input.qualityScore ?? null,
        existing.id
      );
      return true;
    });
    return upgrade.immediate();
  }

  if (existing) return false;

  const result = cache.insertArticle.run(
    input.url,
    input.sourceName,
    input.sourceCategory,
    input.title,
    input.publishedDate,
    input.text,
    input.contentHash,
    input.sourceId ?? null,
    input.sourceJobId ?? null,
    input.canonicalUrl ?? null,
    input.qualityScore ?? null,
    input.contentHash,
    input.canonicalUrl ?? null,
    input.canonicalUrl ?? null
  );

  return result.changes > 0;
}

export function findArticleIdByIdentity(
  db: Database.Database,
  input: { url: string; canonicalUrl?: string | null; contentHash: string }
): number | null {
  const row = db
    .prepare(`
      SELECT id
      FROM articles
      WHERE url = ?
         OR (? IS NOT NULL AND canonical_url = ?)
         OR content_hash = ?
      ORDER BY
        CASE WHEN url = ? THEN 0 ELSE 1 END,
        CASE WHEN ? IS NOT NULL AND canonical_url = ? THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
    `)
    .get(
      input.url,
      input.canonicalUrl ?? null,
      input.canonicalUrl ?? null,
      input.contentHash,
      input.url,
      input.canonicalUrl ?? null,
      input.canonicalUrl ?? null
    ) as { id: number } | undefined;
  return row?.id ?? null;
}

export function linkSourceJobUrlArticle(
  db: Database.Database,
  sourceJobId: number,
  urlId: number,
  articleId: number
): boolean {
  const result = db
    .prepare(`
      UPDATE source_job_urls
      SET article_id = ?
      WHERE source_job_id = ? AND url_id = ?
    `)
    .run(articleId, sourceJobId, urlId);
  return result.changes === 1;
}

export type InsertRejectedPageInput = {
  url: string;
  stage: string;
  reasonCode: string;
  reasonDetails?: string | null;
  title?: string | null;
  publishedDate?: string | null;
  textLength?: number | null;
  contentHash?: string | null;
  urlId?: number | null;
  sourceId?: number | null;
  sourceJobId?: number | null;
};

export function insertRejectedPage(
  db: Database.Database,
  input: InsertRejectedPageInput
): number {
  const cache = getStatementCache(db);

  if (!cache.insertRejectedPage) {
    cache.insertRejectedPage = db.prepare(`
      INSERT INTO rejected_pages (
        url_id, source_id, source_job_id, url, stage, reason_code,
        reason_details, title, published_date, text_length, content_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  const result = cache.insertRejectedPage.run(
    input.urlId ?? null,
    input.sourceId ?? null,
    input.sourceJobId ?? null,
    input.url,
    input.stage,
    input.reasonCode,
    input.reasonDetails ?? null,
    input.title ?? null,
    input.publishedDate ?? null,
    input.textLength ?? null,
    input.contentHash ?? null
  );

  return Number(result.lastInsertRowid);
}

export function getArticleStats(db: Database.Database) {
  const total = db.prepare(`SELECT COUNT(*) as count FROM articles`).get() as {
    count: number;
  };

  const bySource = db
    .prepare(`
      SELECT source_name, COUNT(*) as count
      FROM articles
      GROUP BY source_name
      ORDER BY count DESC
    `)
    .all() as Array<{ source_name: string; count: number }>;

  return {
    total: total.count,
    bySource
  };
}
