import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { ensureSchema, getPendingUrls, insertArticle, insertUrl } from "../src/db";
import {
  claimNextSourceJob,
  clearLegacyPendingQueue,
  completeSourceJob,
  enqueueSource,
  getSourceQueueStats
} from "../src/sourceQueue";

function memoryDb() {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

test("claims source jobs in strict FIFO order", () => {
  const db = memoryDb();
  try {
    const first = enqueueSource(db, {
      name: "First",
      baseUrl: "https://first.example"
    });
    const second = enqueueSource(db, {
      name: "Second",
      baseUrl: "https://second.example"
    });

    const claimedFirst = claimNextSourceJob(db, "worker-a");
    assert.equal(claimedFirst?.id, first.job.id);
    assert.equal(claimNextSourceJob(db, "worker-b"), null);

    completeSourceJob(db, first.job.id, { accepted: 1 });
    const claimedSecond = claimNextSourceJob(db, "worker-b");
    assert.equal(claimedSecond?.id, second.job.id);

    const stats = getSourceQueueStats(db);
    assert.equal(stats.completed, 1);
    assert.equal(stats.running, 1);
  } finally {
    db.close();
  }
});

test("rejects private/local scrape targets before enqueue", () => {
  const db = memoryDb();
  try {
    assert.throws(
      () =>
        enqueueSource(db, {
          name: "Internal service",
          baseUrl: "http://127.0.0.1:3000/admin"
        }),
      /Private\/local source hosts are not allowed/
    );
  } finally {
    db.close();
  }
});

test("clears only unowned legacy pending URLs", () => {
  const db = memoryDb();
  try {
    insertUrl(db, {
      url: "https://legacy.example/a",
      sourceName: "Legacy",
      sourceCategory: null,
      discoveryMethod: "sitemap"
    });
    const queued = enqueueSource(db, {
      name: "New",
      baseUrl: "https://new.example"
    });
    insertUrl(db, {
      url: "https://new.example/a",
      canonicalUrl: "https://new.example/a",
      sourceName: "New",
      sourceCategory: null,
      discoveryMethod: "sitemap",
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });

    assert.equal(clearLegacyPendingQueue(db), 1);
    const rows = db
      .prepare("SELECT url, status FROM urls ORDER BY id")
      .all() as Array<{ url: string; status: string }>;
    assert.deepEqual(rows, [
      { url: "https://legacy.example/a", status: "skipped" },
      { url: "https://new.example/a", status: "pending" }
    ]);
  } finally {
    db.close();
  }
});

test("associates a previously seen legacy URL with a new source job", () => {
  const db = memoryDb();
  try {
    insertUrl(db, {
      url: "https://overlap.example/story",
      sourceName: "Legacy",
      sourceCategory: null,
      discoveryMethod: "sitemap"
    });
    db.prepare("UPDATE urls SET status = 'skipped' WHERE url = ?").run(
      "https://overlap.example/story"
    );

    const queued = enqueueSource(db, {
      name: "Overlap",
      baseUrl: "https://overlap.example"
    });
    assert.equal(
      insertUrl(db, {
        url: "https://overlap.example/story",
        canonicalUrl: "https://overlap.example/story",
        sourceName: "Overlap",
        sourceCategory: null,
        discoveryMethod: "sitemap",
        sourceId: queued.source.id,
        sourceJobId: queued.job.id
      }),
      true
    );

    const pending = getPendingUrls(db, 10, "Overlap", {
      sourceId: queued.source.id,
      sourceJobId: queued.job.id
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.url, "https://overlap.example/story");
  } finally {
    db.close();
  }
});

test("rejects non-365-day source jobs at the public queue boundary", () => {
  const db = memoryDb();
  try {
    assert.throws(
      () =>
        enqueueSource(
          db,
          { name: "Wrong window", baseUrl: "https://window.example" },
          { requestedDaysBack: 180 }
        ),
      /exactly 365/
    );
  } finally {
    db.close();
  }
});

test("deduplicates newly accepted articles by normalized content hash", () => {
  const db = memoryDb();
  try {
    const common = {
      sourceName: "Example",
      sourceCategory: "technology",
      title: "A valid title",
      publishedDate: "2026-07-01T00:00:00.000Z",
      text: "Long article body",
      contentHash: "same-normalized-hash",
      qualityScore: 100
    };

    assert.equal(
      insertArticle(db, {
        ...common,
        url: "https://example.com/one",
        canonicalUrl: "https://example.com/one"
      }),
      true
    );
    assert.equal(
      insertArticle(db, {
        ...common,
        url: "https://example.com/two",
        canonicalUrl: "https://example.com/two"
      }),
      false
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM articles").get() as { count: number })
        .count,
      1
    );
  } finally {
    db.close();
  }
});

test("database rejects FIFO articles that bypass strict quality metadata", () => {
  const db = memoryDb();
  try {
    const queued = enqueueSource(db, {
      name: "Strict",
      baseUrl: "https://strict.example"
    });

    assert.throws(
      () =>
        insertArticle(db, {
          url: "https://strict.example/missing-date",
          canonicalUrl: "https://strict.example/missing-date",
          sourceName: "Strict",
          sourceCategory: null,
          sourceId: queued.source.id,
          sourceJobId: queued.job.id,
          title: "Article without a publication date",
          publishedDate: null,
          text: "A valid-looking prose sentence with evidence and context. ".repeat(20),
          contentHash: "missing-date-hash",
          qualityScore: 100
        }),
      /quality constraints/
    );
  } finally {
    db.close();
  }
});

test("database rejects malformed FIFO dates on insert and update", () => {
  const db = memoryDb();
  try {
    const queued = enqueueSource(db, {
      name: "Strict dates",
      baseUrl: "https://strict-dates.example"
    });
    const common = {
      sourceName: "Strict dates",
      sourceCategory: null,
      sourceId: queued.source.id,
      sourceJobId: queued.job.id,
      title: "Article with a deterministic publication date",
      text: "A valid-looking prose sentence with evidence and context. ".repeat(20),
      qualityScore: 100
    };

    assert.throws(
      () =>
        insertArticle(db, {
          ...common,
          url: "https://strict-dates.example/malformed",
          canonicalUrl: "https://strict-dates.example/malformed",
          publishedDate: "not-a-date",
          contentHash: "malformed-date-hash"
        }),
      /quality constraints/
    );

    assert.equal(
      insertArticle(db, {
        ...common,
        url: "https://strict-dates.example/valid",
        canonicalUrl: "https://strict-dates.example/valid",
        publishedDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        contentHash: "valid-date-hash"
      }),
      true
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE articles SET published_date = 'not-a-date' WHERE url = ?")
          .run("https://strict-dates.example/valid"),
      /quality constraints/
    );
  } finally {
    db.close();
  }
});

test("upgrades a matching legacy article with clean FIFO content", () => {
  const db = memoryDb();
  try {
    insertArticle(db, {
      url: "https://upgrade.example/story",
      sourceName: "Legacy",
      sourceCategory: null,
      title: "Legacy title",
      publishedDate: null,
      text: "legacy navigation shell",
      contentHash: "legacy-hash"
    });
    const queued = enqueueSource(db, {
      name: "Upgrade",
      baseUrl: "https://upgrade.example"
    });
    const cleanText = "Evidence-based reporting with several complete sentences. ".repeat(
      20
    );

    assert.equal(
      insertArticle(db, {
        url: "https://upgrade.example/story",
        canonicalUrl: "https://upgrade.example/story",
        sourceName: "Upgrade",
        sourceCategory: "technology",
        sourceId: queued.source.id,
        sourceJobId: queued.job.id,
        title: "Clean current article title",
        publishedDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        text: cleanText,
        contentHash: "clean-hash",
        qualityScore: 100
      }),
      true
    );

    const row = db
      .prepare(
        "SELECT source_job_id, quality_score, title, content_hash FROM articles"
      )
      .get() as {
      source_job_id: number;
      quality_score: number;
      title: string;
      content_hash: string;
    };
    assert.equal(row.source_job_id, queued.job.id);
    assert.equal(row.quality_score, 100);
    assert.equal(row.title, "Clean current article title");
    assert.equal(row.content_hash, "clean-hash");
  } finally {
    db.close();
  }
});

test("legacy upgrade is subject to FIFO quality and date guards", () => {
  const db = memoryDb();
  try {
    insertArticle(db, {
      url: "https://guarded-upgrade.example/story",
      sourceName: "Legacy",
      sourceCategory: null,
      title: "Legacy title",
      publishedDate: null,
      text: "legacy navigation shell",
      contentHash: "guarded-upgrade-legacy-hash"
    });
    const queued = enqueueSource(db, {
      name: "Guarded upgrade",
      baseUrl: "https://guarded-upgrade.example"
    });

    assert.throws(
      () =>
        insertArticle(db, {
          url: "https://guarded-upgrade.example/story",
          canonicalUrl: "https://guarded-upgrade.example/story",
          sourceName: "Guarded upgrade",
          sourceCategory: null,
          sourceId: queued.source.id,
          sourceJobId: queued.job.id,
          title: "Malformed clean article",
          publishedDate: "not-a-date",
          text: "Evidence-based reporting with several complete sentences. ".repeat(20),
          contentHash: "guarded-upgrade-clean-hash",
          qualityScore: 100
        }),
      /quality constraints/
    );

    const legacy = db
      .prepare("SELECT source_job_id, quality_score, content_hash FROM articles WHERE url = ?")
      .get("https://guarded-upgrade.example/story") as {
      source_job_id: number | null;
      quality_score: number | null;
      content_hash: string;
    };
    assert.equal(legacy.source_job_id, null);
    assert.equal(legacy.quality_score, null);
    assert.equal(legacy.content_hash, "guarded-upgrade-legacy-hash");
  } finally {
    db.close();
  }
});

test("legacy upgrade cannot collide with accepted content", () => {
  const db = memoryDb();
  try {
    insertArticle(db, {
      url: "https://collision.example/legacy",
      sourceName: "Legacy",
      sourceCategory: null,
      title: "Legacy title",
      publishedDate: null,
      text: "legacy navigation shell",
      contentHash: "legacy-collision-hash"
    });
    insertArticle(db, {
      url: "https://collision.example/accepted",
      canonicalUrl: "https://collision.example/accepted",
      sourceName: "Previously accepted",
      sourceCategory: null,
      title: "Previously accepted article",
      publishedDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      text: "Existing clean reporting with evidence and several sentences. ".repeat(20),
      contentHash: "already-accepted-hash",
      qualityScore: 100
    });
    const queued = enqueueSource(db, {
      name: "Collision",
      baseUrl: "https://collision.example"
    });

    assert.equal(
      insertArticle(db, {
        url: "https://collision.example/legacy",
        canonicalUrl: "https://collision.example/legacy",
        sourceName: "Collision",
        sourceCategory: null,
        sourceId: queued.source.id,
        sourceJobId: queued.job.id,
        title: "Clean duplicate article",
        publishedDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        text: "Clean duplicate reporting with evidence and several sentences. ".repeat(20),
        contentHash: "already-accepted-hash",
        qualityScore: 100
      }),
      false
    );

    const legacy = db
      .prepare("SELECT source_job_id, quality_score, content_hash FROM articles WHERE url = ?")
      .get("https://collision.example/legacy") as {
      source_job_id: number | null;
      quality_score: number | null;
      content_hash: string;
    };
    assert.equal(legacy.source_job_id, null);
    assert.equal(legacy.quality_score, null);
    assert.equal(legacy.content_hash, "legacy-collision-hash");
  } finally {
    db.close();
  }
});
