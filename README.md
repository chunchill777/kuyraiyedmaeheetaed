# scrapeai

TypeScript article scraper with a persistent FIFO source queue, strict one-year
backfills, deterministic quality checks, quarantine records, and SQLite output.

## Guarantees for newly queued sources

- Sources are claimed in database insertion order. Only one source job can be
  `running` at a time.
- Every queued source uses a 365-day window.
- Archive/listing URLs are discovery inputs and are not stored as articles.
- An article must have a trustworthy publication date inside the rolling year.
- Readability extraction must succeed; the crawler never falls back to the full
  page body.
- Error, challenge, consent, paywall, navigation, code/CSS, repetitive, generic
  title, and low-prose candidates are quarantined in `rejected_pages`.
- New articles are deduplicated by canonical URL and normalized content hash.
- Accepted/rejected counts and monthly coverage are stored with each source job.

The quality checks are deliberately conservative. Rejected candidates remain
auditable and do not contaminate the `articles` table.

## Install

```sh
npm install
npm run typecheck
npm test
```

Playwright needs a Chromium binary on a fresh machine:

```sh
npx playwright install chromium
```

Copy `.env.example` into the backend's environment configuration and adjust the
database/storage paths as needed.

## Add a source

Create a JSON file:

```json
{
  "name": "Example News",
  "category": "technology",
  "baseUrl": "https://news.example.com",
  "startUrls": ["https://news.example.com/latest"],
  "archiveUrlTemplates": ["https://news.example.com/{yyyy}/{mm}/"],
  "sitemapUrls": ["https://news.example.com/sitemap.xml"]
}
```

Add it to the end of the persistent queue:

```sh
npm run source:add -- ./example-source.json
npm run source:status
npm run source:work
```

`source:work` stays alive, polls for later additions, and completes the oldest
source before claiming the next source. Stop it with `Ctrl+C`; set
`WORKER_ONCE=true` for a drain-once command. A crashed worker can be recovered
after the configurable stale-heartbeat timeout. Transient URL failures are
retried without allowing a later source to jump the queue.

## Backend contract

The backend can call the queue functions directly:

```ts
import { openDb } from "./src/db";
import { enqueueSource, getSourceQueueStats } from "./src/sourceQueue";

const db = openDb(process.env.CRAWLER_DB_PATH);

const queued = enqueueSource(
  db,
  {
    name: "Example News",
    category: "technology",
    baseUrl: "https://news.example.com",
    sitemapUrls: ["https://news.example.com/sitemap.xml"]
  },
  { requestedDaysBack: 365 }
);

console.log(queued.job.id, getSourceQueueStats(db));
```

The backend should run one `source:work` process for strict global FIFO. Starting
multiple workers is safe, but all except the worker holding the running job will
remain idle.

## Database handoff

`openDb()` applies additive migrations and enables SQLite foreign keys.

Important tables:

- `sources`: validated source configuration and stable source key.
- `source_jobs`: FIFO order, attempts, heartbeat, status, error, and final stats.
- `urls`: canonical catalog of discovered candidates.
- `source_job_urls`: per-job URL ownership, FIFO status, retry state, and article link.
- `rejected_pages`: deterministic rejection code and diagnostic metadata.
- `articles`: accepted, clean, in-range, deduplicated article content.
- `article_classifications` and `matches`: optional STEEP classification output.

Runtime databases, browser queues, and exports stay ignored by Git.
Browser request queues are in-memory and ephemeral; SQLite is the durable retry
and ownership store, so repeated jobs do not accumulate multi-gigabyte Crawlee
queue directories.

## Pipeline commands

```sh
npm run source:add -- ./source.json  # enqueue source
npm run source:status                # inspect FIFO state
npm run source:work                  # process all queued sources in order
npm run classify                     # optional local Ollama classification
```

Legacy/manual commands remain available for diagnostics:

```sh
npm run discover
npm run filter
npm run crawl
```

## Quality acceptance checks

For every new source job, the completion report includes:

- URL status counts;
- accepted date minimum/maximum;
- accepted counts by publication month;
- rejection counts by deterministic reason.

New FIFO-owned articles are additionally protected by database triggers. They
cannot be inserted without a canonical URL, quality score, sufficient content,
and a publication date inside the rolling 365-day window.

## Configuration

See `.env.example`. Useful variables include:

- `CRAWLER_DB_PATH`
- `DAYS_BACK` (FIFO add command requires `365`)
- `CRAWL_BATCH_SIZE`
- `MAX_CONCURRENCY`
- `MAX_SITEMAP_URLS`
- `MAX_SITEMAP_FILES`
- `MAX_SITEMAP_DEPTH`
- `MAX_SITEMAP_DOWNLOAD_BYTES`
- `MAX_SITEMAP_UNCOMPRESSED_BYTES`
- `MAX_LISTING_REQUESTS`
- `MAX_PAGINATION_LINKS_PER_PAGE`
- `MIN_COVERAGE_MONTHS` (defaults to 12; override per source when legitimately sparse)
- `MIN_ACCEPTED_ARTICLES` (defaults to 10)
- `MIN_ACCEPTANCE_RATE` (defaults to 5%)
- `QUEUE_POLL_MS`
- `SOURCE_JOB_MAX_ATTEMPTS`
- `SOURCE_JOB_STALE_MINUTES`
- `OLLAMA_URL`
- `OLLAMA_MODEL`
