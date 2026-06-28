import fs from "fs/promises";
import { openDb } from "./db";

type SteepCategory =
  | "social"
  | "technology"
  | "economic"
  | "environmental"
  | "political";

type ArticleRow = {
  id: number;
  url: string;
  source_name: string;
  source_category: string | null;
  title: string;
  published_date: string | null;
  text: string;
};

type LlmResult = {
  isNewsArticle: boolean;
  isRelevant: boolean;
  matchedKeywords: string[];
  reason: string;
};

const OUTPUT_DIR = "./knowledge";
const OUTPUT_TEXT_PATH = `${OUTPUT_DIR}/results.txt`;

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";
const OLLAMA_URL = "http://localhost:11434/api/generate";
const CLASSIFIER_VERSION = "kb-v2";
const CLASSIFIER_MODEL = `${OLLAMA_MODEL}:${CLASSIFIER_VERSION}`;

const TEST_SOURCE_NAME = process.env.TEST_SOURCE_NAME || "";
const CLASSIFY_LIMIT = Number(process.env.CLASSIFY_LIMIT || 50);
const DAYS_BACK = Number(process.env.DAYS_BACK || 180);

const ALLOW_UNKNOWN_DATE = process.env.ALLOW_UNKNOWN_DATE !== "false";
const USE_DATE_FILTER = process.env.USE_DATE_FILTER !== "false";
const USE_KEYWORD_PREFILTER = process.env.USE_KEYWORD_PREFILTER === "true";
const USE_PRIORITY_SOURCES = process.env.USE_PRIORITY_SOURCES !== "false";
const USE_SOURCE_CATEGORY_SCOPE =
  process.env.USE_SOURCE_CATEGORY_SCOPE === "true";

const PRIORITY_DOMAINS = [
  "nextbigfuture.com",
  "scitechdaily.com",
  "venturebeat.com",
  "quantumrun.com",
  "futurity.org",
  "pewresearch.org",
  "trendwatching.com",
  "ourworldindata.org",
  "worldbank.org",
  "brookings.edu",
  "piie.com",
  "project-syndicate.org",
  "cepr.org",
  "techcrunch.com",
  "spectrum.ieee.org",
  "restofworld.org",
  "iea.org",
  "resilience.org",
  "wired.com"
];
const ERROR_PAGE_TITLE_PARTS = [
  "404",
  "page not found",
  "not found",
  "access denied",
  "forbidden",
  "service unavailable",
  "bad gateway"
];
const ERROR_PAGE_TEXT_PARTS = [
  "404 - page not found",
  "404 page not found",
  "the page you requested could not be found",
  "the page you are looking for could not be found",
  "sorry, the page you are looking for does not exist",
  "this page could not be found",
  "access denied",
  "403 forbidden",
  "service unavailable",
  "bad gateway"
];

const STEEP_KEYWORDS: Record<SteepCategory, string[]> = {
  social: [
    "Lifestyle changes",
    "Career expectations",
    "Consumer activism",
    "Rate of family formation",
    "Growth rate of population",
    "Age distribution of population",
    "Regional shifts in population",
    "Life expectancies",
    "Birthrates",
    "Pension plans",
    "Health care",
    "Level of education",
    "Living wage",
    "Unionization"
  ],
  technology: [
    "Total government spending for R&D",
    "Total industry spending for R&D",
    "Focus of technological efforts",
    "Patent protection",
    "New products",
    "New developments in technology",
    "Transfer from lab to marketplace",
    "Productivity improvements through automation",
    "Internet availability",
    "Telecommunication infrastructure",
    "Computer hacking activity"
  ],
  economic: [
    "GDP trends",
    "Interest rates",
    "Money supply",
    "Inflation rates",
    "Unemployment levels",
    "Wage/price controls",
    "Devaluation/revaluation",
    "Energy alternatives",
    "Energy availability and cost",
    "Disposable and discretionary income",
    "Currency markets",
    "Global financial system"
  ],
  environmental: [
    "Environmental protection laws",
    "Global warming impacts",
    "Non-governmental organizations",
    "Pollution impacts",
    "Reuse",
    "Triple bottom line",
    "Recycling"
  ],
  political: [
    "Antitrust regulations",
    "Environmental protection laws",
    "Global warming legislation",
    "Immigration laws",
    "Tax laws",
    "Special incentives",
    "Foreign trade regulations",
    "Attitudes toward foreign companies",
    "Laws on hiring and promotion",
    "Stability of government",
    "Outsourcing regulation",
    "Foreign sweatshops"
  ]
};

const STEEP_CATEGORIES = Object.keys(STEEP_KEYWORDS) as SteepCategory[];
const KEYWORD_STOP_WORDS = new Set([
  "of",
  "and",
  "the",
  "for",
  "in",
  "to",
  "from",
  "through",
  "with",
  "a",
  "an",
  "total",
  "level",
  "rate",
  "rates"
]);

function buildKeywordTokens(keywords: string[]): string[] {
  const tokens = new Set<string>();

  for (const keyword of keywords) {
    const words = normalizeText(keyword)
      .split(" ")
      .filter((w) => w.length >= 4 && !KEYWORD_STOP_WORDS.has(w));

    for (const word of words) {
      tokens.add(word);
    }
  }

  return Array.from(tokens);
}

const KEYWORD_TOKENS_BY_CATEGORY = STEEP_CATEGORIES.reduce((acc, category) => {
  acc[category] = buildKeywordTokens(STEEP_KEYWORDS[category]);
  return acc;
}, {} as Record<SteepCategory, string[]>);

const ALL_KEYWORD_TOKENS = Array.from(
  new Set(STEEP_CATEGORIES.flatMap((category) => KEYWORD_TOKENS_BY_CATEGORY[category]))
);

function normalizeCategory(category?: string | null): SteepCategory | null {
  if (!category) return null;

  const c = category.toLowerCase();

  if (c.includes("social")) return "social";
  if (c.includes("tech")) return "technology";
  if (c.includes("economic")) return "economic";
  if (c.includes("environment")) return "environmental";
  if (c.includes("politic")) return "political";

  return null;
}

function getFromDate(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d;
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function isDateAccepted(publishedDate: string | null, fromDate: Date): boolean {
  if (!USE_DATE_FILTER) return true;

  const date = parseDate(publishedDate);

  if (!date) return ALLOW_UNKNOWN_DATE;

  return date >= fromDate;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/r\s*&\s*d/g, "research and development")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getScopesForArticle(article: ArticleRow): {
  category: SteepCategory;
  keywords: string[];
}[] {
  const category = normalizeCategory(article.source_category);

  if (USE_SOURCE_CATEGORY_SCOPE && category) {
    return [
      {
        category,
        keywords: STEEP_KEYWORDS[category]
      }
    ];
  }

  return (Object.keys(STEEP_KEYWORDS) as SteepCategory[]).map((cat) => ({
    category: cat,
    keywords: STEEP_KEYWORDS[cat]
  }));
}

function getKeywordTokens(
  scopes: { category: SteepCategory; keywords: string[] }[]
): string[] {
  if (scopes.length === 1) {
    return KEYWORD_TOKENS_BY_CATEGORY[scopes[0].category];
  }

  if (scopes.length === STEEP_CATEGORIES.length) {
    return ALL_KEYWORD_TOKENS;
  }

  return Array.from(new Set(scopes.flatMap((scope) => buildKeywordTokens(scope.keywords))));
}

function keywordPrefilter(
  article: ArticleRow,
  scopes: { category: SteepCategory; keywords: string[] }[]
) {
  if (!USE_KEYWORD_PREFILTER) return true;

  const tokens = getKeywordTokens(scopes);
  const text = normalizeText(`${article.title}\n${article.text}`);

  return tokens.some((token) => text.includes(token));
}

function isObviousErrorPage(article: ArticleRow): boolean {
  const title = normalizeText(article.title);
  const textStart = normalizeText(article.text).slice(0, 1000);

  if (
    ERROR_PAGE_TITLE_PARTS.some((part) => title.includes(part)) &&
    title.length <= 80
  ) {
    return true;
  }

  return ERROR_PAGE_TEXT_PARTS.some((part) => textStart.includes(part));
}

function safeJsonParse(text: string): LlmResult {
  try {
    const parsed = JSON.parse(text);
    return normalizeLlmResult(parsed);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      return {
        isNewsArticle: false,
        isRelevant: false,
        matchedKeywords: [],
        reason: "LLM did not return JSON."
      };
    }

    try {
      const parsed = JSON.parse(match[0]);
      return normalizeLlmResult(parsed);
    } catch {
      return {
        isNewsArticle: false,
        isRelevant: false,
        matchedKeywords: [],
        reason: "Failed to parse JSON from LLM response."
      };
    }
  }
}

function normalizeLlmResult(value: any): LlmResult {
  return {
    isNewsArticle: Boolean(value?.isNewsArticle),
    isRelevant: Boolean(value?.isRelevant),
    matchedKeywords: Array.isArray(value?.matchedKeywords)
      ? value.matchedKeywords.filter((x: any) => typeof x === "string")
      : [],
    reason: typeof value?.reason === "string" ? value.reason : ""
  };
}

async function classifyWithLocalLlm(article: ArticleRow): Promise<LlmResult> {
  const scopes = getScopesForArticle(article);
  const allKeywords = scopes.flatMap((scope) => scope.keywords);

  const keywordSection = scopes
    .map((scope) => {
      return [
        `Category: ${scope.category}`,
        "Keywords:",
        ...scope.keywords.map((k) => `- ${k}`)
      ].join("\n");
    })
    .join("\n\n");

  const slicedText = article.text.slice(0, 7000);

  const prompt = `
You are a STEEP knowledge-base classifier for an AI agent.

Task:
1. Decide whether this page is a real news/article page.
2. Decide whether it is useful knowledge for any STEEP dimension.
3. Return only valid JSON.

Rules:
- isNewsArticle should be true only for actual news articles, reports, blog articles, research/news posts, or analysis articles.
- isNewsArticle should be false for homepages, category pages, tag pages, search pages, author pages, login pages, newsletters, ads, privacy pages, and event listing pages.
- Prefer recall over precision. This output feeds an AI-agent knowledge base.
- isRelevant should be true if the article gives useful strategic context, evidence, signals, forecasts, policy/economic/social/technology/environment information, or analysis related to any STEEP dimension.
- Do not require the exact keyword phrase to appear in the text.
- If an article is relevant, choose the closest matching keywords from the provided keyword list.
- matchedKeywords must contain only keywords from the provided keyword list.
- Do not invent keywords.
- If relevant, matchedKeywords should not be empty unless no provided keyword is even loosely related.
- If not relevant, matchedKeywords must be [].

Allowed keywords:
${allKeywords.map((k) => `- ${k}`).join("\n")}

${keywordSection}

Article:
Source: ${article.source_name}
Source Category: ${article.source_category || "unknown"}
URL: ${article.url}
Title: ${article.title}
Published Date: ${article.published_date || "Unknown"}

Text:
${slicedText}

Return only JSON in this exact shape:
{
  "isNewsArticle": boolean,
  "isRelevant": boolean,
  "matchedKeywords": string[],
  "reason": string
}
`;

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        num_ctx: 8192
      }
    })
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}`);
  }

  const data: any = await res.json();

  return safeJsonParse(data.response || "");
}

function ensurePhase3Tables(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS article_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL UNIQUE,
      is_news_article INTEGER NOT NULL,
      is_relevant INTEGER NOT NULL,
      reason TEXT,
      model TEXT NOT NULL,
      classified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(article_id) REFERENCES articles(id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      source_name TEXT NOT NULL,
      category TEXT NOT NULL,
      keyword TEXT NOT NULL,
      reason TEXT,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(article_id, category, keyword),
      FOREIGN KEY(article_id) REFERENCES articles(id)
    );

    CREATE INDEX IF NOT EXISTS idx_matches_keyword ON matches(keyword);
    CREATE INDEX IF NOT EXISTS idx_matches_category ON matches(category);
    CREATE INDEX IF NOT EXISTS idx_matches_source ON matches(source_name);
  `);
}

type ClassificationStatements = {
  markClassification: any;
  deleteMatches: any;
  insertMatch: any;
};

function prepareClassificationStatements(db: any): ClassificationStatements {
  return {
    markClassification: db.prepare(`
      INSERT OR REPLACE INTO article_classifications (
        article_id,
        is_news_article,
        is_relevant,
        reason,
        model
      )
      VALUES (?, ?, ?, ?, ?)
    `),
    deleteMatches: db.prepare(`DELETE FROM matches WHERE article_id = ?`),
    insertMatch: db.prepare(`
      INSERT OR IGNORE INTO matches (
        article_id,
        url,
        source_name,
        category,
        keyword,
        reason,
        model
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
  };
}

function getPrioritySqlParts() {
  const domainWhere = PRIORITY_DOMAINS.map(() => "lower(a.url) LIKE ?").join(
    " OR "
  );
  const domainOrder = PRIORITY_DOMAINS.map(
    (_, index) => `WHEN lower(a.url) LIKE ? THEN ${index}`
  ).join("\n");
  const whereParams = PRIORITY_DOMAINS.map((domain) => `%${domain}%`);
  const orderParams = PRIORITY_DOMAINS.map((domain) => `%${domain}%`);

  return {
    domainWhere,
    domainOrder,
    whereParams,
    orderParams
  };
}

function getArticlesToClassify(db: any): ArticleRow[] {
  const priority = USE_PRIORITY_SOURCES ? getPrioritySqlParts() : null;
  const priorityWhere = priority ? `AND (${priority.domainWhere})` : "";
  const priorityOrder = priority
    ? `
        CASE
          ${priority.domainOrder}
          ELSE ${PRIORITY_DOMAINS.length}
        END,`
    : "";
  const baseParams = priority ? priority.whereParams : [];
  const orderParams = priority ? priority.orderParams : [];

  if (TEST_SOURCE_NAME) {
    return db
      .prepare(`
        SELECT
          a.id,
          a.url,
          a.source_name,
          a.source_category,
          a.title,
          a.published_date,
          a.text
        FROM articles a
        WHERE a.source_name LIKE ?
          ${priorityWhere}
          AND NOT EXISTS (
            SELECT 1
            FROM article_classifications c
            WHERE c.article_id = a.id
              AND c.model = ?
          )
        ORDER BY
          ${priorityOrder}
          CASE WHEN a.published_date IS NULL THEN 1 ELSE 0 END,
          a.published_date DESC,
          a.id ASC
        LIMIT ?
      `)
      .all(
        `%${TEST_SOURCE_NAME}%`,
        ...baseParams,
        CLASSIFIER_MODEL,
        ...orderParams,
        CLASSIFY_LIMIT
      ) as ArticleRow[];
  }

  return db
    .prepare(`
      SELECT
        a.id,
        a.url,
        a.source_name,
        a.source_category,
        a.title,
        a.published_date,
        a.text
      FROM articles a
      WHERE NOT EXISTS (
        SELECT 1
        FROM article_classifications c
        WHERE c.article_id = a.id
          AND c.model = ?
      )
        ${priorityWhere}
      ORDER BY
        ${priorityOrder}
        CASE WHEN a.published_date IS NULL THEN 1 ELSE 0 END,
        a.published_date DESC,
        a.id ASC
      LIMIT ?
    `)
    .all(
      CLASSIFIER_MODEL,
      ...baseParams,
      ...orderParams,
      CLASSIFY_LIMIT
    ) as ArticleRow[];
}

function markClassification(
  statements: ClassificationStatements,
  articleId: number,
  result: LlmResult
) {
  if (!result.isNewsArticle || !result.isRelevant) {
    statements.deleteMatches.run(articleId);
  }

  statements.markClassification.run(
    articleId,
    result.isNewsArticle ? 1 : 0,
    result.isRelevant ? 1 : 0,
    result.reason || null,
    CLASSIFIER_MODEL
  );
}

function findCategoryForKeyword(
  keyword: string,
  scopes: { category: SteepCategory; keywords: string[] }[]
): SteepCategory | null {
  for (const scope of scopes) {
    if (scope.keywords.includes(keyword)) {
      return scope.category;
    }
  }

  return null;
}

function saveMatches(
  statements: ClassificationStatements,
  article: ArticleRow,
  result: LlmResult
) {
  const scopes = getScopesForArticle(article);

  statements.deleteMatches.run(article.id);

  for (const keyword of result.matchedKeywords) {
    const category = findCategoryForKeyword(keyword, scopes);

    if (!category) continue;

    statements.insertMatch.run(
      article.id,
      article.url,
      article.source_name,
      category,
      keyword,
      result.reason || null,
      CLASSIFIER_MODEL
    );
  }
}

function getStats(db: any) {
  const classified = db
    .prepare(`SELECT COUNT(*) as count FROM article_classifications`)
    .get() as { count: number };

  const relevant = db
    .prepare(`
      SELECT COUNT(*) as count
      FROM article_classifications
      WHERE is_news_article = 1
        AND is_relevant = 1
    `)
    .get() as { count: number };

  const matched = db.prepare(`SELECT COUNT(*) as count FROM matches`).get() as {
    count: number;
  };

  const matchedArticles = db
    .prepare(`SELECT COUNT(DISTINCT article_id) as count FROM matches`)
    .get() as { count: number };

  return {
    classified: classified.count,
    relevant: relevant.count,
    matches: matched.count,
    matchedArticles: matchedArticles.count
  };
}

type ExportRow = {
  id: number;
  source_name: string;
  category: string;
  title: string;
  published_date: string | null;
  url: string;
  matched_keywords: string;
  reason: string | null;
  text: string;
};

async function exportKnowledgeText(db: any) {
  const rows = db
    .prepare(`
      SELECT
        a.id,
        a.source_name,
        COALESCE(m.category, a.source_category, 'general') as category,
        a.title,
        a.published_date,
        a.url,
        COALESCE(
          GROUP_CONCAT(DISTINCT m.keyword),
          'General STEEP relevance'
        ) as matched_keywords,
        COALESCE(MAX(m.reason), c.reason) as reason,
        a.text
      FROM article_classifications c
      JOIN articles a ON a.id = c.article_id
      LEFT JOIN matches m ON m.article_id = a.id
      WHERE c.is_news_article = 1
        AND c.is_relevant = 1
      GROUP BY a.id, COALESCE(m.category, a.source_category, 'general')
      ORDER BY a.published_date DESC
    `)
    .all() as ExportRow[];

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  if (rows.length === 0) {
    await fs.writeFile(
      OUTPUT_TEXT_PATH,
      "No relevant knowledge-base articles found.\n",
      "utf-8"
    );
    return;
  }

  const blocks = rows.map((row) => {
    return [
      "==============================",
      `SOURCE: ${row.source_name}`,
      `CATEGORY: ${row.category}`,
      `MATCHED KEYWORDS: ${row.matched_keywords}`,
      `TITLE: ${row.title}`,
      `DATE: ${row.published_date || "Unknown"}`,
      `LINK: ${row.url}`,
      `LLM_REASON: ${row.reason || ""}`,
      "==============================",
      "",
      "TEXT:",
      row.text,
      "",
      "------------------------------",
      ""
    ].join("\n");
  });

  await fs.writeFile(OUTPUT_TEXT_PATH, blocks.join("\n"), "utf-8");
}

async function main() {
  const db = openDb();
  ensurePhase3Tables(db);
  const statements = prepareClassificationStatements(db);

  const fromDate = getFromDate(DAYS_BACK);
  const articles = getArticlesToClassify(db);

  console.log("Starting Phase 3: LLM Classification + Export");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Classifier version: ${CLASSIFIER_VERSION}`);
  console.log(`Source filter: ${TEST_SOURCE_NAME || "all"}`);
  console.log(`Priority sources only: ${USE_PRIORITY_SOURCES}`);
  console.log(`Classify limit: ${CLASSIFY_LIMIT}`);
  console.log(`Days back: ${DAYS_BACK}`);
  console.log(`From date: ${fromDate.toISOString()}`);
  console.log(`Use date filter: ${USE_DATE_FILTER}`);
  console.log(`Allow unknown date: ${ALLOW_UNKNOWN_DATE}`);
  console.log(`Use keyword prefilter: ${USE_KEYWORD_PREFILTER}`);
  console.log(`Use source category scope: ${USE_SOURCE_CATEGORY_SCOPE}`);
  console.log(`Articles selected: ${articles.length}`);

  let classifiedThisRun = 0;
  let skippedByDate = 0;
  let skippedByPrefilter = 0;
  let skippedByErrorPage = 0;
  let relevantThisRun = 0;
  let llmCalls = 0;

  for (const article of articles) {
    console.log(`\n[ARTICLE] ${article.title}`);

    if (isObviousErrorPage(article)) {
      skippedByErrorPage++;

      markClassification(statements, article.id, {
        isNewsArticle: false,
        isRelevant: false,
        matchedKeywords: [],
        reason: "Skipped obvious error page before LLM."
      });

      classifiedThisRun++;
      console.log("Skipped obvious error page before LLM.");
      continue;
    }

    if (!isDateAccepted(article.published_date, fromDate)) {
      skippedByDate++;

      markClassification(statements, article.id, {
        isNewsArticle: true,
        isRelevant: false,
        matchedKeywords: [],
        reason: "Skipped because published date is outside range or unknown."
      });

      classifiedThisRun++;
      console.log("Skipped by date.");
      continue;
    }

    const scopes = getScopesForArticle(article);

    if (!keywordPrefilter(article, scopes)) {
      skippedByPrefilter++;

      markClassification(statements, article.id, {
        isNewsArticle: true,
        isRelevant: false,
        matchedKeywords: [],
        reason: "Skipped by keyword prefilter."
      });

      classifiedThisRun++;
      console.log("Skipped by keyword prefilter.");
      continue;
    }

    let result: LlmResult;

    try {
      llmCalls++;
      result = await classifyWithLocalLlm(article);
    } catch (err: any) {
      result = {
        isNewsArticle: false,
        isRelevant: false,
        matchedKeywords: [],
        reason: err?.message || "LLM call failed."
      };
    }

    markClassification(statements, article.id, result);

    if (result.isNewsArticle && result.isRelevant) {
      saveMatches(statements, article, result);
      relevantThisRun++;
      console.log(`[MATCH] ${result.matchedKeywords.join(", ")}`);
    } else {
      console.log(`[NO MATCH] ${result.reason}`);
    }

    classifiedThisRun++;
  }

  await exportKnowledgeText(db);

  const stats = getStats(db);

  console.log("\nDone Phase 3.");
  console.log(`Classified this run: ${classifiedThisRun}`);
  console.log(`Skipped by error page: ${skippedByErrorPage}`);
  console.log(`Skipped by date: ${skippedByDate}`);
  console.log(`Skipped by prefilter: ${skippedByPrefilter}`);
  console.log(`LLM calls: ${llmCalls}`);
  console.log(`Relevant this run: ${relevantThisRun}`);
  console.log(`Total classified in DB: ${stats.classified}`);
  console.log(`Total relevant KB articles: ${stats.relevant}`);
  console.log(`Total matched articles: ${stats.matchedArticles}`);
  console.log(`Total keyword matches: ${stats.matches}`);
  console.log(`Saved: ${OUTPUT_TEXT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
});
