CREATE TABLE IF NOT EXISTS site_visits (
  id TEXT PRIMARY KEY CHECK (id = 'homepage'),
  total INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total) = 'integer' AND total BETWEEN 0 AND 9007199254740991),
  since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (
      typeof(since) = 'text' AND length(since) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', since) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', since) = since
    )
);

INSERT OR IGNORE INTO site_visits (id) VALUES ('homepage');
