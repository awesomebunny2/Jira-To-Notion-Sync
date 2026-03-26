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
    `SELECT issue_key, notion_page_id, last_synced_status FROM issue_sync_state WHERE issue_key = ? LIMIT 1`
  )
    .bind(issueKey)
    .first();
}

/**
 * Creates or updates the saved sync state for one Jira issue.
 *
 * Right now this only stores the small set of fields needed for the
 * Jira -> Notion status sync path.
 */
export async function saveIssueSyncState(env, { issueKey, projectKey, projectName, notionPageId, lastSyncedStatus }) {
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
        last_synced_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        project_key = excluded.project_key,
        project_name = excluded.project_name,
        notion_page_id = excluded.notion_page_id,
        last_synced_status = excluded.last_synced_status,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      issueKey,
      projectKey || null,
      projectName || null,
      notionPageId || null,
      lastSyncedStatus || null,
      new Date().toISOString()
    )
    .run();
}
