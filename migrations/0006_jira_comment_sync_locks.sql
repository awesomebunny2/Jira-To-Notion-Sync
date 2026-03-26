CREATE TABLE IF NOT EXISTS jira_comment_sync_locks (
  issue_key TEXT PRIMARY KEY,
  lock_token TEXT,
  locked_until TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jira_comment_sync_locks_locked_until
  ON jira_comment_sync_locks(locked_until);
