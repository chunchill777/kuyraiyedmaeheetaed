-- Read-only audit for historical rows created before the FIFO quality pipeline.
-- Usage: sqlite3 -readonly data/crawler.db < scripts/audit-existing-data.sql

.headers on
.mode column

SELECT status, COUNT(*) AS urls
FROM urls
GROUP BY status
ORDER BY status;

SELECT
  COUNT(*) AS total_articles,
  SUM(published_date IS NULL) AS unknown_date,
  SUM(datetime(published_date) < datetime('now', '-365 days')) AS older_than_1y,
  SUM(datetime(published_date) > datetime('now', '+15 minutes')) AS future_date,
  SUM(quality_score IS NOT NULL) AS quality_gated
FROM articles;

SELECT COALESCE(SUM(copies - 1), 0) AS exact_duplicate_extras
FROM (
  SELECT COUNT(*) AS copies
  FROM articles
  GROUP BY content_hash
  HAVING COUNT(*) > 1
);

SELECT title, COUNT(*) AS copies
FROM articles
GROUP BY lower(trim(title))
HAVING COUNT(*) > 1
ORDER BY copies DESC
LIMIT 25;

SELECT reason_code, COUNT(*) AS rejected
FROM rejected_pages
GROUP BY reason_code
ORDER BY rejected DESC, reason_code;

SELECT
  j.id AS job_id,
  s.name AS source,
  j.status,
  j.attempt_count,
  j.enqueued_at,
  j.completed_at,
  j.error
FROM source_jobs j
JOIN sources s ON s.id = j.source_id
ORDER BY j.id;
