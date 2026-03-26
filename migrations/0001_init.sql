CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  issue_key TEXT,
  project_key TEXT,
  page_id TEXT,
  webhook_identifier TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received',
  payload_json TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_source_status
  ON webhook_events(source, status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_issue_key
  ON webhook_events(issue_key, received_at DESC);

CREATE TABLE IF NOT EXISTS issue_sync_state (
  issue_key TEXT PRIMARY KEY,
  project_key TEXT,
  project_name TEXT,
  notion_page_id TEXT,
  epic_key TEXT,
  epic_name TEXT,
  last_jira_event_at TEXT,
  last_notion_event_at TEXT,
  last_synced_status TEXT,
  last_synced_pr_links TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_sync_state_project_key
  ON issue_sync_state(project_key, updated_at DESC);
