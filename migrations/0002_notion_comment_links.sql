CREATE TABLE IF NOT EXISTS notion_comment_links (
  notion_comment_id TEXT PRIMARY KEY,
  jira_comment_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  page_id TEXT,
  last_synced_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notion_comment_links_issue_key
  ON notion_comment_links(issue_key, updated_at DESC);
