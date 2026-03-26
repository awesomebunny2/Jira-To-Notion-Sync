/**
 * Returns true when the Worker has a D1 binding available.
 */
export function hasDb(env) {
  return Boolean(env.DB);
}

/**
 * Loads the saved sync state for one Jira issue.
 *
 * This is used to remember which Notion page belongs to the issue,
 * so later updates can patch that page instead of creating duplicates.
 */
export async function getIssueSyncState(env, issueKey) {
  if (!env.DB || !issueKey) {
    return null;
  }

  return env.DB.prepare(
    `
      SELECT
        issue_key,
        project_key,
        project_name,
        notion_page_id,
        last_jira_event_at,
        last_notion_event_at,
        last_synced_status
      FROM issue_sync_state
      WHERE issue_key = ?
      LIMIT 1
    `
  )
    .bind(issueKey)
    .first();
}

/**
 * Creates or updates the saved sync state for one Jira issue.
 *
 * Stores the small set of issue-level sync fields needed by the lean
 * Jira <-> Notion status sync flow.
 */
export async function saveIssueSyncState(
  env,
  { issueKey, projectKey, projectName, notionPageId, lastJiraEventAt, lastNotionEventAt, lastSyncedStatus }
) {
  if (!env.DB || !issueKey) {
    return;
  }

  await env.DB.prepare(
    `
      INSERT INTO issue_sync_state (
        issue_key,
        project_key,
        project_name,
        notion_page_id,
        last_jira_event_at,
        last_notion_event_at,
        last_synced_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        project_key = COALESCE(excluded.project_key, issue_sync_state.project_key),
        project_name = COALESCE(excluded.project_name, issue_sync_state.project_name),
        notion_page_id = COALESCE(excluded.notion_page_id, issue_sync_state.notion_page_id),
        last_jira_event_at = COALESCE(excluded.last_jira_event_at, issue_sync_state.last_jira_event_at),
        last_notion_event_at = COALESCE(excluded.last_notion_event_at, issue_sync_state.last_notion_event_at),
        last_synced_status = COALESCE(excluded.last_synced_status, issue_sync_state.last_synced_status),
        updated_at = excluded.updated_at
    `
  )
    .bind(
      issueKey,
      projectKey || null,
      projectName || null,
      notionPageId || null,
      lastJiraEventAt || null,
      lastNotionEventAt || null,
      lastSyncedStatus || null,
      new Date().toISOString()
    )
    .run();
}
