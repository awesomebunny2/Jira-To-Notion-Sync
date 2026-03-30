CREATE TABLE IF NOT EXISTS notion_issue_sync_locks (
  issue_key TEXT PRIMARY KEY,
  lock_token TEXT,
  locked_until TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notion_issue_sync_locks_locked_until
  ON notion_issue_sync_locks(locked_until);

CREATE TABLE IF NOT EXISTS notion_issue_sync_fingerprints (
  issue_key TEXT PRIMARY KEY,
  page_id TEXT,
  fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notion_issue_sync_fingerprints_updated_at
  ON notion_issue_sync_fingerprints(updated_at DESC);
