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

/**
 * Loads the managed Jira-comments section state for one issue.
 *
 * This lets the Worker replace only the comment blocks it created, instead of
 * touching unrelated page content.
 */
export async function getJiraCommentSectionState(env, issueKey) {
  if (!env.DB || !issueKey) {
    return null;
  }

  let row;
  try {
    row = await env.DB.prepare(
      `
        SELECT
          issue_key,
          page_id,
          block_ids_json,
          updated_at
        FROM jira_comment_sections
        WHERE issue_key = ?
        LIMIT 1
      `
    )
      .bind(issueKey)
      .first();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('no such table: jira_comment_sections')) {
      return null;
    }
    throw error;
  }

  if (!row) {
    return null;
  }

  let blockIds = [];
  try {
    blockIds = JSON.parse(row.block_ids_json || '[]');
  } catch {
    blockIds = [];
  }

  return {
    issueKey: row.issue_key,
    pageId: row.page_id,
    blockIds: Array.isArray(blockIds) ? blockIds.filter(Boolean) : [],
    updatedAt: row.updated_at,
  };
}

/**
 * Saves the managed Jira-comments section block ids for one issue.
 */
export async function saveJiraCommentSectionState(env, { issueKey, pageId, blockIds }) {
  if (!env.DB || !issueKey) {
    return false;
  }

  try {
    await env.DB.prepare(
      `
        INSERT INTO jira_comment_sections (
          issue_key,
          page_id,
          block_ids_json,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(issue_key) DO UPDATE SET
          page_id = excluded.page_id,
          block_ids_json = excluded.block_ids_json,
          updated_at = excluded.updated_at
      `
    )
      .bind(
        issueKey,
        pageId || null,
        JSON.stringify(Array.isArray(blockIds) ? blockIds.filter(Boolean) : []),
        new Date().toISOString()
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('no such table: jira_comment_sections')) {
      return false;
    }
    throw error;
  }

  return true;
}

/**
 * Deletes the managed Jira-comments section state for one issue.
 */
export async function deleteJiraCommentSectionState(env, issueKey) {
  if (!env.DB || !issueKey) {
    return false;
  }

  try {
    await env.DB.prepare(
      `
        DELETE FROM jira_comment_sections
        WHERE issue_key = ?
      `
    )
      .bind(issueKey)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('no such table: jira_comment_sections')) {
      return false;
    }
    throw error;
  }

  return true;
}

/**
 * Tries to acquire the per-issue Jira comment sync lock.
 *
 * If the lock table is missing, this degrades gracefully to an unlocked mode so
 * comment mirroring still works until migrations are applied.
 */
export async function acquireJiraCommentSyncLock(env, issueKey, leaseMs = 120000) {
  if (!env.DB || !issueKey) {
    return { acquired: true, token: null };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + Math.max(1000, Number(leaseMs) || 120000)).toISOString();
  const token = crypto.randomUUID();

  try {
    const result = await env.DB.prepare(
      `
        INSERT INTO jira_comment_sync_locks (
          issue_key,
          lock_token,
          locked_until,
          pending,
          updated_at
        ) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(issue_key) DO UPDATE SET
          lock_token = excluded.lock_token,
          locked_until = excluded.locked_until,
          updated_at = excluded.updated_at
        WHERE jira_comment_sync_locks.locked_until IS NULL
           OR jira_comment_sync_locks.locked_until < excluded.updated_at
      `
    )
      .bind(issueKey, token, lockedUntil, nowIso)
      .run();

    if (Number(result?.meta?.changes || 0) > 0) {
      return { acquired: true, token };
    }

    await env.DB.prepare(
      `
        UPDATE jira_comment_sync_locks
        SET pending = 1,
            updated_at = ?
        WHERE issue_key = ?
      `
    )
      .bind(nowIso, issueKey)
      .run();

    return { acquired: false, token: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('no such table: jira_comment_sync_locks')) {
      return { acquired: true, token: null };
    }
    throw error;
  }
}

/**
 * Checks whether another comment event arrived while the current sync held the
 * lock. If so, it renews the lease and lets the caller run one more pass.
 */
export async function consumePendingJiraCommentSyncLock(env, issueKey, token, leaseMs = 120000) {
  if (!env.DB || !issueKey || !token) {
    return false;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + Math.max(1000, Number(leaseMs) || 120000)).toISOString();

  try {
    const result = await env.DB.prepare(
      `
        UPDATE jira_comment_sync_locks
        SET pending = 0,
            locked_until = ?,
            updated_at = ?
        WHERE issue_key = ?
          AND lock_token = ?
          AND pending = 1
      `
    )
      .bind(lockedUntil, nowIso, issueKey, token)
      .run();

    return Number(result?.meta?.changes || 0) > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('no such table: jira_comment_sync_locks')) {
      return false;
    }
    throw error;
  }
}

/**
 * Releases the per-issue Jira comment sync lock.
 */
export async function releaseJiraCommentSyncLock(env, issueKey, token) {
  if (!env.DB || !issueKey || !token) {
    return false;
  }

  try {
    await env.DB.prepare(
      `
        DELETE FROM jira_comment_sync_locks
        WHERE issue_key = ?
          AND lock_token = ?
      `
    )
      .bind(issueKey, token)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('no such table: jira_comment_sync_locks')) {
      return false;
    }
    throw error;
  }

  return true;
}
