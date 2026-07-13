import fs from "node:fs/promises";

import { getBaseUrl } from "./discover";
import { openDb } from "./db";
import { enqueueSource } from "./sourceQueue";
import { Source } from "./types";

function validateUrlTemplates(source: Source) {
  const templates = [
    source.baseUrl,
    source.homepageUrl,
    source.feedUrl,
    ...(source.startUrls || []),
    ...(source.sitemapUrls || []),
    ...(source.archiveUrlTemplates || [])
  ].filter((value): value is string => Boolean(value));

  for (const template of templates) {
    const rendered = template
      .replaceAll("{yyyy}", "2026")
      .replaceAll("{yy}", "26")
      .replaceAll("{mm}", "07")
      .replaceAll("{m}", "7")
      .replaceAll("{dd}", "13")
      .replaceAll("{d}", "13")
      .replaceAll("{date}", "2026-07-13");
    const parsed = new URL(rendered);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol in source config: ${template}`);
    }
  }
}

async function readSourceInput(): Promise<Source> {
  const argument = process.argv[2];
  const inline = process.env.SOURCE_JSON;

  if (!argument && !inline) {
    throw new Error(
      "Usage: npm run source:add -- ./source.json (or set SOURCE_JSON)"
    );
  }

  const raw = inline
    ? inline
    : argument?.trim().startsWith("{")
      ? argument
      : await fs.readFile(argument!, "utf8");
  const parsed = JSON.parse(raw) as Source;

  getBaseUrl(parsed);
  validateUrlTemplates(parsed);
  return parsed;
}

export async function main() {
  const source = await readSourceInput();
  const daysBack = Number(process.env.DAYS_BACK || 365);
  if (daysBack !== 365) {
    throw new Error("FIFO source jobs currently require DAYS_BACK=365");
  }

  const db = openDb();
  try {
    const result = enqueueSource(db, source, { requestedDaysBack: daysBack });
    console.log(
      JSON.stringify(
        {
          enqueued: result.enqueued,
          sourceId: result.source.id,
          sourceKey: result.source.sourceKey,
          jobId: result.job.id,
          queueStatus: result.job.status,
          enqueuedAt: result.job.enqueuedAt
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to enqueue source:", error);
    process.exitCode = 1;
  });
}
