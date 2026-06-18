import { openDb } from "./db";

type UrlRow = {
  id: number;
  url: string;
  source_name: string;
  status: string;
};

const FILTER_SOURCE_NAME = process.env.FILTER_SOURCE_NAME || "";
const FILTER_MODE = process.env.FILTER_MODE || "balanced";
// balanced = กรองเฉพาะ URL ที่ชัดว่าไม่ใช่ article
// strict = กรองแรงขึ้น เหลือเฉพาะ URL ที่หน้าตาเหมือน article

const DRY_RUN = process.env.DRY_RUN === "true";

function isBlockedUrl(url: string): boolean {
  const u = url.toLowerCase();

  const blockedParts = [
    "/login",
    "/signin",
    "/signup",
    "/subscribe",
    "/subscription",
    "/privacy",
    "/terms",
    "/about",
    "/contact",
    "/advertise",
    "/newsletter",
    "/author/",
    "/authors/",
    "/tag/",
    "/tags/",
    "/category/",
    "/categories/",
    "/video",
    "/videos",
    "/podcast",
    "/podcasts",
    "/events",
    "/event",
    "/careers",
    "/jobs",
    "/shop",
    "/cart",
    "/account",
    "/search",
    "?s=",
    "/?s=",

    "/sponsor/",
    "/sponsored/",
    "/press-release/",
    "/partner/",
    "/brand-studio/",
    "/advertorial/",
    "/deals/",
    "/coupon/",
    "/gallery/",
    "/web-stories/"
  ];

  const blockedExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
    ".pdf",
    ".zip",
    ".mp4",
    ".mp3",
    ".avi",
    ".mov",
    ".css",
    ".js",
    ".ico",
    ".xml"
  ];

  if (blockedParts.some((part) => u.includes(part))) return true;
  if (blockedExtensions.some((ext) => u.endsWith(ext))) return true;
  if (u.includes("#")) return true;
  if (u.startsWith("mailto:")) return true;
  if (u.startsWith("tel:")) return true;

  return false;
}

function isArchiveOrHomepage(url: string): boolean {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "");

  if (path === "") return true;

  // เช่น /2026 หรือ /2026/06
  if (/^\/20\d{2}$/.test(path)) return true;
  if (/^\/20\d{2}\/\d{2}$/.test(path)) return true;

  return false;
}

function isLikelyArticleUrl(url: string): boolean {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();

  if (isBlockedUrl(url)) return false;
  if (isArchiveOrHomepage(url)) return false;

  // article แบบมีวันที่ เช่น /2026/06/12/title/
  if (/\/20\d{2}\/\d{2}\/\d{2}\//.test(path)) return true;

  // article slug ยาว เช่น /some-long-news-title-about-ai/
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";

  const hyphenCount = (last.match(/-/g) || []).length;

  if (segments.length >= 2 && last.length >= 20 && hyphenCount >= 3) {
    return true;
  }

  // บางเว็บใช้ path แบบ /news/... /article/... /research/...
  const articleHints = [
    "/news/",
    "/article/",
    "/articles/",
    "/story/",
    "/stories/",
    "/research/",
    "/report/",
    "/reports/",
    "/blog/"
  ];

  if (articleHints.some((hint) => path.includes(hint)) && last.length >= 12) {
    return true;
  }

  return false;
}

function getReason(url: string): string | null {
  if (isBlockedUrl(url)) {
    return "Filtered before crawl: blocked non-article URL";
  }

  if (isArchiveOrHomepage(url)) {
    return "Filtered before crawl: homepage/archive/listing URL";
  }

  if (FILTER_MODE === "strict" && !isLikelyArticleUrl(url)) {
    return "Filtered before crawl: not likely article URL";
  }

  if (FILTER_MODE === "ultra" && !isUltraArticleUrl(url)) {
    return "Filtered before crawl: ultra non-article URL";
  }

  return null;
}

function main() {
  const db = openDb();

  const rows = FILTER_SOURCE_NAME
    ? (db
        .prepare(
          `
          SELECT id, url, source_name, status
          FROM urls
          WHERE status = 'pending'
            AND source_name LIKE ?
        `
        )
        .all(`%${FILTER_SOURCE_NAME}%`) as UrlRow[])
    : (db
        .prepare(
          `
          SELECT id, url, source_name, status
          FROM urls
          WHERE status = 'pending'
        `
        )
        .all() as UrlRow[]);

  let willSkip = 0;
  let willKeep = 0;

  const updates: Array<{ id: number; reason: string }> = [];

  for (const row of rows) {
    const reason = getReason(row.url);

    if (reason) {
      willSkip++;
      updates.push({ id: row.id, reason });
    } else {
      willKeep++;
    }
  }

  console.log("Phase 1.5 URL Filter");
  console.log(`Source filter: ${FILTER_SOURCE_NAME || "all"}`);
  console.log(`Mode: ${FILTER_MODE}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Pending checked: ${rows.length}`);
  console.log(`Will keep: ${willKeep}`);
  console.log(`Will skip: ${willSkip}`);

  if (DRY_RUN) {
    console.log("\nDry run only. No DB changes.");
    return;
  }

  const stmt = db.prepare(`
    UPDATE urls
    SET status = 'skipped',
        failed_reason = ?,
        crawled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const item of updates) {
      stmt.run(item.reason, item.id);
    }
  });

  tx();

  console.log(`\nUpdated skipped URLs: ${updates.length}`);
}

function isUltraArticleUrl(url: string): boolean {
  const u = url.toLowerCase();
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();

  if (isBlockedUrl(url)) return false;
  if (isArchiveOrHomepage(url)) return false;

  if (
    u.includes("sitemap") ||
    u.includes("/feed") ||
    u.endsWith(".xml") ||
    u.endsWith(".rss")
  ) {
    return false;
  }

  // Strongest signal: article URL with date path
  // เช่น /2026/06/15/title/
  if (/\/20\d{2}\/\d{2}\/\d{2}\//.test(path)) {
    return true;
  }

  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  const hyphenCount = (last.match(/-/g) || []).length;

  const strongArticleHints = [
    "/news/",
    "/article/",
    "/articles/",
    "/story/",
    "/stories/",
    "/research/",
    "/report/",
    "/reports/",
    "/blog/",
    "/post/",
    "/posts/",
    "/resources/"
  ];

  if (
    strongArticleHints.some((hint) => path.includes(hint)) &&
    last.length >= 20 &&
    hyphenCount >= 2
  ) {
    return true;
  }

  return false;
}

main();