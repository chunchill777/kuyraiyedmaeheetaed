import { Configuration, MemoryStorage } from "crawlee";

/**
 * Crawlee's request queue is only an in-batch transport. Durable ownership and
 * retry state live in SQLite, so persisting browser queues wastes disk and can
 * suppress later jobs that reuse the same URL key.
 */
export function createEphemeralCrawlerConfiguration(): Configuration {
  return new Configuration({
    storageClient: new MemoryStorage({ persistStorage: false }),
    persistStorage: false,
    purgeOnStart: false
  });
}
