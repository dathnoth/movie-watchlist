-- Caches the TMDB "fresh finds" response so the app hits TMDB about once a
-- week rather than on every page load. Cloudflare Pages Functions have no cron,
-- so the refresh happens lazily on the first request after the TTL expires.
CREATE TABLE fresh_cache (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
