CREATE TABLE IF NOT EXISTS jira_comment_sections (
  issue_key TEXT PRIMARY KEY,
  page_id TEXT,
  block_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jira_comment_sections_page_id
  ON jira_comment_sections(page_id);
