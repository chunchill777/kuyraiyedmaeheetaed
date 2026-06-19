import Database from "better-sqlite3";
import fs from "fs";

const DATA_DIR = "./data";
const DB_PATH = `${DATA_DIR}/crawler.db`;

type StatementCache = {
  insertUrl?: any;
  markUrlStatus?: any;
  insertArticle?: any;
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

export type InsertUrlInput = {
  url: string;
  sourceName: string;
  sourceCategory: string | null;
  discoveryMethod: string;
};

export function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      source_name TEXT NOT NULL,
      source_category TEXT,
      discovery_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      crawled_at TEXT,
      failed_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_urls_status ON urls(status);
    CREATE INDEX IF NOT EXISTS idx_urls_source ON urls(source_name);
    CREATE INDEX IF NOT EXISTS idx_urls_method ON urls(discovery_method);
  `);

  return db;
}

export function insertUrl(db: Database.Database, input: InsertUrlInput): boolean {
  const cache = getStatementCache(db);

  if (!cache.insertUrl) {
    cache.insertUrl = db.prepare(`
      INSERT OR IGNORE INTO urls (
        url,
        source_name,
        source_category,
        discovery_method
      )
      VALUES (?, ?, ?, ?)
    `);
  }

  const result = cache.insertUrl.run(
    input.url,
    input.sourceName,
    input.sourceCategory,
    input.discoveryMethod
  );

  return result.changes > 0;
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
};

export type InsertArticleInput = {
  url: string;
  sourceName: string;
  sourceCategory: string | null;
  title: string;
  publishedDate: string | null;
  text: string;
  contentHash: string;
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_name);
    CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_date);
    CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);
  `);
}

export function getPendingUrls(
  db: Database.Database,
  limit: number,
  sourceName?: string
): PendingUrl[] {
  if (sourceName) {
    return db
      .prepare(`
        SELECT id, url, source_name, source_category
        FROM urls
        WHERE status = 'pending'
          AND source_name LIKE ?
        ORDER BY
          CASE
            WHEN url LIKE '%/2026/%' THEN 0
            WHEN url LIKE '%/2025/%' THEN 0
            WHEN url LIKE '%/news/%' THEN 1
            WHEN url LIKE '%/article/%' THEN 1
            WHEN url LIKE '%/articles/%' THEN 1
            WHEN url LIKE '%/research/%' THEN 1
            WHEN url LIKE '%/report/%' THEN 1
            WHEN url LIKE '%/blog/%' THEN 1
            ELSE 2
          END,
          id ASC
        LIMIT ?
      `)
      .all(`%${sourceName}%`, limit) as PendingUrl[];
  }

  return db
    .prepare(`
      SELECT id, url, source_name, source_category
      FROM urls
      WHERE status = 'pending'
      ORDER BY
        CASE
          WHEN url LIKE '%/2026/%' THEN 0
          WHEN url LIKE '%/2025/%' THEN 0
          WHEN url LIKE '%/news/%' THEN 1
          WHEN url LIKE '%/article/%' THEN 1
          WHEN url LIKE '%/articles/%' THEN 1
          WHEN url LIKE '%/research/%' THEN 1
          WHEN url LIKE '%/report/%' THEN 1
          WHEN url LIKE '%/blog/%' THEN 1
          ELSE 2
        END,
        id ASC
      LIMIT ?
    `)
    .all(limit) as PendingUrl[];
}

export function markUrlStatus(
  db: Database.Database,
  id: number,
  status: "pending" | "crawled" | "skipped" | "failed",
  failedReason?: string
) {
  const cache = getStatementCache(db);

  if (!cache.markUrlStatus) {
    cache.markUrlStatus = db.prepare(`
      UPDATE urls
      SET status = ?,
          crawled_at = CURRENT_TIMESTAMP,
          failed_reason = ?
      WHERE id = ?
    `);
  }

  cache.markUrlStatus.run(status, failedReason || null, id);
}

export function insertArticle(
  db: Database.Database,
  input: InsertArticleInput
): boolean {
  const cache = getStatementCache(db);

  if (!cache.insertArticle) {
    cache.insertArticle = db.prepare(`
      INSERT OR IGNORE INTO articles (
        url,
        source_name,
        source_category,
        title,
        published_date,
        text,
        content_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  const result = cache.insertArticle.run(
    input.url,
    input.sourceName,
    input.sourceCategory,
    input.title,
    input.publishedDate,
    input.text,
    input.contentHash
  );

  return result.changes > 0;
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
