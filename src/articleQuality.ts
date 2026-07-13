import { createHash } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

const TRACKING_QUERY_PARAMS = new Set([
  "_ga",
  "_gl",
  "campaign",
  "cmpid",
  "dclid",
  "fbclid",
  "ga_campaign",
  "ga_content",
  "ga_medium",
  "ga_source",
  "ga_term",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "msclkid",
  "ocid",
  "ref",
  "ref_",
  "spm",
  "tracking",
  "vero_conv",
  "vero_id"
]);

const EXACT_BOILERPLATE_LINES = new Set([
  "accept all cookies",
  "advertisement",
  "close",
  "cookie preferences",
  "log in",
  "manage cookies",
  "menu",
  "privacy policy",
  "share this article",
  "sign in",
  "skip to content",
  "terms of use"
]);

export type ArticleRejectionCode =
  | "INVALID_URL"
  | "MISSING_PUBLISHED_DATE"
  | "INVALID_PUBLISHED_DATE"
  | "PUBLISHED_DATE_TOO_OLD"
  | "PUBLISHED_DATE_IN_FUTURE"
  | "MISSING_TITLE"
  | "GENERIC_OR_ERROR_TITLE"
  | "HTML_SHELL"
  | "JAVASCRIPT_OR_CSS_SHELL"
  | "COOKIE_OR_CONSENT_NOISE"
  | "PAYWALL_OR_LOGIN_WALL"
  | "BOT_CHALLENGE_OR_ERROR_PAGE"
  | "NAVIGATION_NOISE"
  | "CONTENT_TOO_SHORT"
  | "NON_PROSE_CONTENT"
  | "REPETITIVE_CONTENT";

export type ArticleCandidate = {
  url: string;
  title: string | null | undefined;
  publishedDate: string | Date | number | null | undefined;
  text: string | null | undefined;
};

export type ArticleQualityOptions = {
  now?: string | Date | number;
  daysBack?: number;
  futureToleranceMinutes?: number;
  minTextLength?: number;
  minWordCount?: number;
};

export type ArticleQualityMetrics = {
  characterCount: number;
  wordCount: number;
  sentenceCount: number;
  letterRatio: number;
  repeatedLineRatio: number;
  tokenDiversity: number;
};

export type ArticleQualityResult = {
  accepted: boolean;
  rejectionCodes: ArticleRejectionCode[];
  qualityScore: number;
  cleanedText: string;
  canonicalUrl: string | null;
  normalizedContent: string;
  contentHash: string;
  publishedDate: string | null;
  metrics: ArticleQualityMetrics;
};

function decodeCommonEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    rsquo: "’"
  };

  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, body: string) => {
      if (body[0] === "#") {
        const isHex = body[1]?.toLowerCase() === "x";
        const value = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);

        if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
          try {
            return String.fromCodePoint(value);
          } catch {
            return entity;
          }
        }

        return entity;
      }

      return named[body.toLowerCase()] ?? entity;
    }
  );
}

function normalizeWhitespace(text: string): string {
  return decodeCommonEntities(text)
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\v\f\u00a0]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes isolated UI labels and adjacent duplicate lines without rewriting prose. */
export function cleanArticleText(input: string | null | undefined): string {
  const normalized = normalizeWhitespace(input ?? "");
  const keptLines: string[] = [];
  let previousComparable = "";

  for (const line of normalized.split("\n")) {
    const comparable = line.toLocaleLowerCase("en-US").replace(/[.!:]+$/g, "").trim();

    if (EXACT_BOILERPLATE_LINES.has(comparable)) continue;
    if (comparable && comparable === previousComparable) continue;

    keptLines.push(line);
    previousComparable = comparable;
  }

  return keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Produces a stable URL used for uniqueness checks. */
export function canonicalizeUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();

    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }

    const retainedParams: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams.entries()) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(normalizedKey)) {
        continue;
      }
      retainedParams.push([key, value]);
    }

    retainedParams.sort(([keyA, valueA], [keyB, valueB]) => {
      const keyOrder = keyA.localeCompare(keyB);
      return keyOrder || valueA.localeCompare(valueB);
    });

    url.search = "";
    for (const [key, value] of retainedParams) url.searchParams.append(key, value);

    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/g, "");

    return url.toString();
  } catch {
    return null;
  }
}

/** Normalizes formatting differences so equivalent article bodies hash identically. */
export function normalizeContentForHash(input: string | null | undefined): string {
  return normalizeWhitespace(input ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashNormalizedContent(input: string | null | undefined): string {
  return createHash("sha256").update(normalizeContentForHash(input), "utf8").digest("hex");
}

export function parseDeterministicDate(
  value: ArticleCandidate["publishedDate"]
): Date | null {
  if (value === null || value === undefined || value === "") return null;
  let normalized = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      normalized = `${trimmed}T00:00:00.000Z`;
    } else if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) &&
      !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
    ) {
      return null;
    }
  }

  const parsed =
    normalized instanceof Date
      ? new Date(normalized.getTime())
      : new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function repeatedLineRatio(text: string): number {
  const lines = text
    .split("\n")
    .map((line) => line.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 20);

  if (lines.length < 3) return 0;

  let repeatedCharacters = 0;
  let totalCharacters = 0;
  const seen = new Set<string>();

  for (const line of lines) {
    totalCharacters += line.length;
    if (seen.has(line)) repeatedCharacters += line.length;
    seen.add(line);
  }

  return totalCharacters === 0 ? 0 : repeatedCharacters / totalCharacters;
}

function calculateMetrics(text: string): ArticleQualityMetrics {
  const characters = Array.from(text);
  const letterCount = countMatches(text, /[\p{L}\p{N}]/gu);
  const tokens = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  const sentenceCount = countMatches(text, /[.!?。！？](?:[\s"'”’)]|$)/gu);

  return {
    characterCount: characters.length,
    wordCount: tokens.length,
    sentenceCount,
    letterRatio: characters.length ? letterCount / characters.length : 0,
    repeatedLineRatio: repeatedLineRatio(text),
    tokenDiversity: tokens.length ? new Set(tokens).size / tokens.length : 0
  };
}

function hasGenericOrErrorTitle(title: string): boolean {
  const normalized = normalizeWhitespace(title)
    .toLocaleLowerCase("en-US")
    .replace(/[\s|\-–—:]+$/g, "")
    .trim();

  if (!normalized) return false;
  if (normalized.length > 300) return true;

  return (
    /^(?:archives?|articles?|blog|home|homepage|latest|latest news|news|news archive|posts?|untitled)(?:\s*[|\-–—]\s*.+)?$/i.test(normalized) ||
    /^day:\s+[a-z]+\s+\d{1,2},?\s+20\d{2}$/i.test(normalized) ||
    /^your choices regarding cookies on this site$/i.test(normalized) ||
    /^scitechdaily\s*[-|]\s*science,? space and technology news\s+20\d{2}$/i.test(normalized) ||
    /(?:^|\b)(?:404|403|500)(?:\b|$)/.test(normalized) ||
    /^(?:access denied|bad gateway|forbidden|internal server error|looking for something|page not found|service unavailable|something went wrong|web server is returning an unknown error)(?:\s*[|\-–—]\s*.+)?$/i.test(
      normalized
    )
  );
}

function looksLikeHtmlShell(rawText: string): boolean {
  const lower = rawText.toLocaleLowerCase("en-US");
  if (/^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/.test(lower)) return true;

  const tags = lower.match(/<\/?(?:html|head|body|main|article|div|span|script|style|meta|link|nav|footer|header)\b[^>]*>/g) ?? [];
  return tags.length >= 8 && tags.join("").length / Math.max(rawText.length, 1) >= 0.12;
}

function looksLikeJavascriptOrCss(rawText: string): boolean {
  const sample = rawText.slice(0, 20_000);
  const jsSignals = countMatches(
    sample,
    /(?:\b(?:const|let|var|function)\s+[a-z_$][\w$]*\s*(?:=|\()|\b(?:window|document|module\.exports|webpackJsonp|__NEXT_DATA__)\b|=>\s*[{(]|[};]\s*[};])/gim
  );
  const cssSignals = countMatches(
    sample,
    /(?:^|\n)\s*(?:@(?:media|font-face|keyframes|import)\b|[#.a-z][^\n{}]{0,120}\{\s*(?:[a-z-]+\s*:\s*[^;}]+;){1,})/gim
  );
  const braceAndSemicolonCount = countMatches(sample, /[{};]/g);
  const nonEmptyLines = sample.split("\n").filter((line) => line.trim()).length || 1;
  const codeLikeLines = sample
    .split("\n")
    .filter((line) =>
      /(?:\b(?:const|let|var|function)\b|=>|[.#][\w-]+\s*\{|@media\b|[{};]\s*$)/i.test(
        line
      )
    ).length;
  const codeLineRatio = codeLikeLines / nonEmptyLines;
  const punctuationDensity = braceAndSemicolonCount / Math.max(sample.length, 1);

  return (
    (jsSignals >= 3 && (codeLineRatio >= 0.35 || punctuationDensity >= 0.012)) ||
    (cssSignals >= 2 && codeLineRatio >= 0.3) ||
    (jsSignals + cssSignals >= 2 &&
      braceAndSemicolonCount >= 12 &&
      codeLineRatio >= 0.25)
  );
}

function hasCookieOrConsentNoise(text: string): boolean {
  const lower = text.toLocaleLowerCase("en-US");
  const signals = [
    /\bwe (?:use|value) cookies\b/,
    /\baccept all cookies\b/,
    /\bmanage (?:cookie|consent) (?:preferences|settings)\b/,
    /\bcookie (?:preferences|settings|consent manager)\b/,
    /\b(?:reject|decline) (?:all )?(?:optional )?cookies\b/,
    /\bconsent preferences\b/
  ].filter((pattern) => pattern.test(lower)).length;

  return signals >= 2 || (signals >= 1 && text.length < 1_500);
}

function hasPaywallOrLoginWall(text: string): boolean {
  const lower = text.toLocaleLowerCase("en-US");
  const signals = [
    /\bsubscribe to (?:continue|read|unlock)\b/,
    /\bsubscription (?:is )?required\b/,
    /\balready (?:a )?subscriber\b/,
    /\byou(?:'|’)ve read your last free article\b/,
    /\byou (?:have )?reached your (?:free )?(?:article )?limit\b/,
    /\bstart your free trial\b/,
    /\b(?:sign|log) in to (?:continue|read)\b/,
    /\bregister to (?:continue|read)\b/,
    /\bunlock (?:this|the full) article\b/,
    /\byou have \d+ (?:free )?articles? remaining\b/
  ].filter((pattern) => pattern.test(lower)).length;

  return signals >= 1;
}

function hasBotChallengeOrError(text: string): boolean {
  const lowerStart = text.toLocaleLowerCase("en-US").slice(0, 2_500);
  return [
    /\bchecking (?:your )?browser\b/,
    /\bverify (?:that )?you are (?:a )?human\b/,
    /\benable javascript and cookies to continue\b/,
    /\battention required\b.*\bcloudflare\b/s,
    /\bcf-chl-/,
    /\bcaptcha\b/,
    /\bthe page you requested could not be found\b/,
    /\b(?:403 forbidden|404 page not found|service unavailable|bad gateway)\b/
  ].some((pattern) => pattern.test(lowerStart));
}

function hasNavigationNoise(text: string, metrics: ArticleQualityMetrics): boolean {
  const lower = text.toLocaleLowerCase("en-US");
  const navSignals = [
    /\bskip to (?:main )?content\b/,
    /\bhome\s+(?:about|news|contact)\s+(?:about|news|contact|privacy)\b/,
    /\bprivacy policy\b/,
    /\bterms (?:and conditions|of (?:service|use))\b/,
    /\b(?:main|primary) navigation\b/,
    /\b(?:open|close) menu\b/,
    /\bfollow us on\b/
  ].filter((pattern) => pattern.test(lower)).length;

  return navSignals >= 3 || (navSignals >= 2 && (text.length < 1_500 || metrics.sentenceCount < 4));
}

function looksNonProse(text: string, metrics: ArticleQualityMetrics, minWordCount: number): boolean {
  if (!text) return true;
  if (metrics.letterRatio < 0.52) return true;

  const latinCount = countMatches(text, /[A-Za-z]/g);
  const allLetterCount = countMatches(text, /\p{L}/gu);
  const mostlyLatin = allLetterCount > 0 && latinCount / allLetterCount >= 0.7;

  if (mostlyLatin && metrics.wordCount < minWordCount) return true;
  if (mostlyLatin && metrics.sentenceCount < 3 && metrics.characterCount < 2_000) return true;

  return false;
}

function looksRepetitive(metrics: ArticleQualityMetrics): boolean {
  return (
    metrics.repeatedLineRatio >= 0.35 ||
    (metrics.wordCount >= 80 && metrics.tokenDiversity < 0.18)
  );
}

const SCORE_DEDUCTIONS: Record<ArticleRejectionCode, number> = {
  INVALID_URL: 30,
  MISSING_PUBLISHED_DATE: 35,
  INVALID_PUBLISHED_DATE: 35,
  PUBLISHED_DATE_TOO_OLD: 35,
  PUBLISHED_DATE_IN_FUTURE: 35,
  MISSING_TITLE: 25,
  GENERIC_OR_ERROR_TITLE: 35,
  HTML_SHELL: 55,
  JAVASCRIPT_OR_CSS_SHELL: 55,
  COOKIE_OR_CONSENT_NOISE: 35,
  PAYWALL_OR_LOGIN_WALL: 40,
  BOT_CHALLENGE_OR_ERROR_PAGE: 60,
  NAVIGATION_NOISE: 30,
  CONTENT_TOO_SHORT: 35,
  NON_PROSE_CONTENT: 30,
  REPETITIVE_CONTENT: 35
};

export function validateArticleCandidate(
  candidate: ArticleCandidate,
  options: ArticleQualityOptions = {}
): ArticleQualityResult {
  const daysBack = options.daysBack ?? 365;
  const futureToleranceMinutes = options.futureToleranceMinutes ?? 15;
  const minTextLength = options.minTextLength ?? 500;
  const minWordCount = options.minWordCount ?? 80;
  const now = parseDeterministicDate(options.now ?? new Date());

  if (!now) throw new TypeError("options.now must be a valid date");
  if (!Number.isFinite(daysBack) || daysBack <= 0) throw new RangeError("daysBack must be positive");
  if (!Number.isFinite(futureToleranceMinutes) || futureToleranceMinutes < 0) {
    throw new RangeError("futureToleranceMinutes cannot be negative");
  }

  const rejectionCodes: ArticleRejectionCode[] = [];
  const reject = (code: ArticleRejectionCode) => {
    if (!rejectionCodes.includes(code)) rejectionCodes.push(code);
  };

  const rawText = normalizeWhitespace(candidate.text ?? "");
  const cleanedText = cleanArticleText(rawText);
  const normalizedContent = normalizeContentForHash(cleanedText);
  const metrics = calculateMetrics(cleanedText);
  const canonicalUrl = canonicalizeUrl(candidate.url);
  const title = normalizeWhitespace(candidate.title ?? "");

  if (!canonicalUrl) reject("INVALID_URL");

  const publishedDate = parseDeterministicDate(candidate.publishedDate);
  if (candidate.publishedDate === null || candidate.publishedDate === undefined || candidate.publishedDate === "") {
    reject("MISSING_PUBLISHED_DATE");
  } else if (!publishedDate) {
    reject("INVALID_PUBLISHED_DATE");
  } else {
    const oldestAllowed = now.getTime() - daysBack * DAY_MS;
    const newestAllowed = now.getTime() + futureToleranceMinutes * 60 * 1000;
    if (publishedDate.getTime() < oldestAllowed) reject("PUBLISHED_DATE_TOO_OLD");
    if (publishedDate.getTime() > newestAllowed) reject("PUBLISHED_DATE_IN_FUTURE");
  }

  if (!title) reject("MISSING_TITLE");
  else if (hasGenericOrErrorTitle(title)) reject("GENERIC_OR_ERROR_TITLE");

  if (looksLikeHtmlShell(rawText)) reject("HTML_SHELL");
  if (looksLikeJavascriptOrCss(rawText)) reject("JAVASCRIPT_OR_CSS_SHELL");
  if (hasCookieOrConsentNoise(rawText)) reject("COOKIE_OR_CONSENT_NOISE");
  if (hasPaywallOrLoginWall(rawText)) reject("PAYWALL_OR_LOGIN_WALL");
  if (hasBotChallengeOrError(rawText)) reject("BOT_CHALLENGE_OR_ERROR_PAGE");
  if (hasNavigationNoise(rawText, metrics)) reject("NAVIGATION_NOISE");
  if (metrics.characterCount < minTextLength) reject("CONTENT_TOO_SHORT");
  if (looksNonProse(cleanedText, metrics, minWordCount)) reject("NON_PROSE_CONTENT");
  if (looksRepetitive(metrics)) reject("REPETITIVE_CONTENT");

  const qualityScore = Math.max(
    0,
    100 - rejectionCodes.reduce((total, code) => total + SCORE_DEDUCTIONS[code], 0)
  );

  return {
    accepted: rejectionCodes.length === 0,
    rejectionCodes,
    qualityScore,
    cleanedText,
    canonicalUrl,
    normalizedContent,
    contentHash: hashNormalizedContent(cleanedText),
    publishedDate: publishedDate?.toISOString() ?? null,
    metrics
  };
}
