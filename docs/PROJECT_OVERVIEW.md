# Project overview

## Runtime flow

```text
add source
    ↓
source_jobs (strict FIFO)
    ↓
sitemap/archive/listing discovery
    ↓
urls + source_job_urls (catalog + per-job ownership)
    ↓
Readability extraction
    ↓
deterministic date/content/metadata validation
    ├── rejected_pages
    └── articles (clean, canonical, deduplicated)
             ↓
       optional STEEP classification
```

Only one source job can run at a time. The resident worker polls for new jobs,
then discovers and processes all URLs owned by the oldest job before the next
source is claimed.

## Source onboarding

Sources are queued through `enqueueSource()` in `src/sourceQueue.ts` or the
`npm run source:add -- source.json` command. Static entries in
`src/storage.json` remain available for legacy/manual discovery but are not
automatically placed into the FIFO.

Each new job requests exactly 365 days. Source configuration is validated before
it enters the queue, including category, URL syntax, HTTP(S) protocol, embedded
credentials, private/local hosts, and minimum month-coverage requirements.

## Discovery

`src/discover.ts` supports sitemap indexes and URL sets, paired `loc`/`lastmod`
parsing, XML entity decoding, monthly archive templates, start pages, and bounded
pagination. Sitemap entries with a known old `lastmod` are skipped; entries with
unknown dates remain candidates for strict page-level validation.

Sitemap downloads, decompressed output, nested index depth, and index-file count
are capped. Hitting a cap fails the source job instead of accepting a partial
backfill.

Archive and pagination pages are never inserted as articles.

## Quality gate

`src/articleQuality.ts` contains deterministic, testable validation. The crawler
requires:

- a canonical HTTP(S) URL;
- an explicit Article JSON-LD or `og:type=article` document signal;
- a non-generic article title;
- `datePublished`/trusted publication metadata inside the rolling year;
- sufficient prose, sentence, character, and token diversity;
- no known error, bot challenge, JS/CSS, HTML shell, consent, paywall, or heavy
  navigation patterns.

Readability failure results in quarantine. The old full-body fallback has been
removed. Rejections store reason codes and metrics in `rejected_pages`.
Completion also requires accepted articles across the configured months, a
minimum accepted count, a minimum acceptance rate, and no unfinished URL rows.

## Persistence

`src/db.ts` applies additive SQLite migrations and enables foreign keys.
`source_job_urls` keeps per-job ownership and status even when a URL was seen by
an older job. FIFO articles carry `source_id` and `source_job_id`. Database
triggers protect new job-owned articles from missing/out-of-range dates and
missing quality metadata. Application writes also deduplicate normalized content
hashes and canonical URLs.

Existing historical rows are retained for compatibility; strict guarantees apply
to newly queued source jobs.

## Backend integration

The stable integration surface is:

- `enqueueSource()` to add work;
- `getSourceQueueStats()`/`getSourceJob()` for status;
- `runSourceQueue()` for the worker;
- SQLite job stats for accepted, rejected, failed, and month coverage counts.

The backend should expose these through its own authenticated API rather than
accepting arbitrary unauthenticated scrape targets.

The worker rejects local/non-public address ranges before requests and verifies
the navigation response address. Production deployment should additionally use
an outbound firewall: application-level DNS checks cannot fully eliminate DNS
rebinding between resolution and a browser socket connection.

## Verification

```sh
npm run typecheck
npm test
npm audit --omit=dev
```

Tests cover canonical URLs, normalized hashes, strict dates, common junk types,
sitemap parsing, listing/pagination detection, FIFO claiming, queue cleanup,
deduplication, and database quality enforcement.
