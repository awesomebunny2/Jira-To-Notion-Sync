export function hasDb(env) {
  return !!env.DB;
}

export async function recordWebhookEvent(env, event) {
  if (!hasDb(env)) {
    return false;
  }

  const result = await env.DB.prepare(
    `
      INSERT OR IGNORE INTO webhook_events (
        id,
        source,
        event_type,
        issue_key,
        project_key,
        page_id,
        webhook_identifier,
        retry_count,
        status,
        payload_json,
        headers_json,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      event.id,
      event.source,
      event.eventType,
      event.issueKey || null,
      event.projectKey || null,
      event.pageId || null,
      event.webhookIdentifier || null,
      event.retryCount || 0,
      event.status || "received",
      JSON.stringify(event.payload || {}),
      JSON.stringify(event.headers || {}),
      event.receivedAt
    )
    .run();

  return Number(result?.meta?.changes || 0) > 0;
}

export async function listRecentWebhookEvents(env, limit = 20) {
  if (!hasDb(env)) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const result = await env.DB.prepare(
    `
      SELECT
        id,
        source,
        event_type,
        issue_key,
        project_key,
        page_id,
        webhook_identifier,
        retry_count,
        status,
        received_at,
        processed_at,
        last_error
      FROM webhook_events
      ORDER BY received_at DESC
      LIMIT ?
    `
  )
    .bind(safeLimit)
    .all();

  return result.results || [];
}

export async function getWebhookEvent(env, eventId) {
  if (!hasDb(env) || !eventId) {
    return null;
  }

  return (
    (await env.DB.prepare(
      `
        SELECT
          id,
          source,
          event_type,
          issue_key,
          project_key,
          page_id,
          webhook_identifier,
          retry_count,
          status,
          received_at,
          processed_at,
          last_error
        FROM webhook_events
        WHERE id = ?
        LIMIT 1
      `
    )
      .bind(eventId)
      .first()) || null
  );
}

export async function markWebhookEventProcessed(env, eventId, notionPageId = null) {
  if (!hasDb(env)) {
    return false;
  }

  await env.DB.prepare(
    `
      UPDATE webhook_events
      SET
        status = 'processed',
        page_id = COALESCE(?, page_id),
        processed_at = ?,
        last_error = NULL
      WHERE id = ?
    `
  )
    .bind(notionPageId, new Date().toISOString(), eventId)
    .run();

  return true;
}

export async function markWebhookEventFailed(env, eventId, errorMessage) {
  if (!hasDb(env)) {
    return false;
  }

  await env.DB.prepare(
    `
      UPDATE webhook_events
      SET
        status = 'failed',
        processed_at = ?,
        last_error = ?
      WHERE id = ?
    `
  )
    .bind(new Date().toISOString(), errorMessage || null, eventId)
    .run();

  return true;
}

export async function getIssueSyncState(env, issueKey) {
  if (!hasDb(env) || !issueKey) {
    return null;
  }

  const result = await env.DB.prepare(
    `
      SELECT
        issue_key,
        project_key,
        project_name,
        notion_page_id,
        epic_key,
        epic_name,
        last_jira_event_at,
        last_notion_event_at,
        last_synced_status,
        last_synced_pr_links,
        last_jira_comment_sync_at,
        updated_at
      FROM issue_sync_state
      WHERE issue_key = ?
      LIMIT 1
    `
  )
    .bind(issueKey)
    .first();

  return result || null;
}

export async function upsertIssueSyncState(env, state) {
  if (!hasDb(env) || !state.issueKey) {
    return false;
  }

  await env.DB.prepare(
    `
      INSERT INTO issue_sync_state (
        issue_key,
        project_key,
        project_name,
        notion_page_id,
        epic_key,
        epic_name,
        last_jira_event_at,
        last_notion_event_at,
        last_synced_status,
        last_synced_pr_links,
        last_jira_comment_sync_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        project_key = excluded.project_key,
        project_name = excluded.project_name,
        notion_page_id = COALESCE(excluded.notion_page_id, issue_sync_state.notion_page_id),
        epic_key = excluded.epic_key,
        epic_name = excluded.epic_name,
        last_jira_event_at = COALESCE(excluded.last_jira_event_at, issue_sync_state.last_jira_event_at),
        last_notion_event_at = COALESCE(excluded.last_notion_event_at, issue_sync_state.last_notion_event_at),
        last_synced_status = COALESCE(excluded.last_synced_status, issue_sync_state.last_synced_status),
        last_synced_pr_links = COALESCE(excluded.last_synced_pr_links, issue_sync_state.last_synced_pr_links),
        last_jira_comment_sync_at = COALESCE(excluded.last_jira_comment_sync_at, issue_sync_state.last_jira_comment_sync_at),
        updated_at = excluded.updated_at
    `
  )
    .bind(
      state.issueKey,
      state.projectKey || null,
      state.projectName || null,
      state.notionPageId || null,
      state.epicKey || null,
      state.epicName || null,
      state.lastJiraEventAt || null,
      state.lastNotionEventAt || null,
      state.lastSyncedStatus || null,
      state.lastSyncedPrLinks || null,
      state.lastJiraCommentSyncAt || null,
      new Date().toISOString()
    )
    .run();

  return true;
}

export async function claimJiraCommentSync(env, issueKey, minGapMs = 5000) {
  if (!hasDb(env) || !issueKey) {
    return false;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - Math.max(0, Number(minGapMs) || 0)).toISOString();
  const claimedAt = now.toISOString();
  const result = await env.DB.prepare(
    `
      UPDATE issue_sync_state
      SET
        last_jira_comment_sync_at = ?,
        updated_at = ?
      WHERE issue_key = ?
        AND (last_jira_comment_sync_at IS NULL OR last_jira_comment_sync_at < ?)
    `
  )
    .bind(claimedAt, claimedAt, issueKey, cutoff)
    .run();

  return Number(result?.meta?.changes || 0) > 0;
}

export async function acquireJiraCommentSyncLock(env, issueKey, leaseMs = 120000) {
  if (!hasDb(env) || !issueKey) {
    return { acquired: false, token: null };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + Math.max(1000, Number(leaseMs) || 120000)).toISOString();
  const token = crypto.randomUUID();

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
}

export async function consumePendingJiraCommentSyncLock(env, issueKey, token, leaseMs = 120000) {
  if (!hasDb(env) || !issueKey || !token) {
    return false;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + Math.max(1000, Number(leaseMs) || 120000)).toISOString();
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
}

export async function releaseJiraCommentSyncLock(env, issueKey, token) {
  if (!hasDb(env) || !issueKey || !token) {
    return false;
  }

  await env.DB.prepare(
    `
      DELETE FROM jira_comment_sync_locks
      WHERE issue_key = ?
        AND lock_token = ?
    `
  )
    .bind(issueKey, token)
    .run();

  return true;
}

export async function getJiraCommentSectionState(env, issueKey) {
  if (!hasDb(env) || !issueKey) {
    return null;
  }

  const row = await env.DB.prepare(
    `
      SELECT
        issue_key,
        page_id,
        block_ids_json,
        comment_ids_json,
        updated_at
      FROM jira_comment_sections
      WHERE issue_key = ?
      LIMIT 1
    `
  )
    .bind(issueKey)
    .first();

  if (!row) {
    return null;
  }

  let blockIds = [];
  let commentIds = [];
  try {
    blockIds = JSON.parse(row.block_ids_json || '[]');
  } catch {
    blockIds = [];
  }
  try {
    commentIds = JSON.parse(row.comment_ids_json || '[]');
  } catch {
    commentIds = [];
  }

  return {
    issueKey: row.issue_key,
    pageId: row.page_id,
    blockIds: Array.isArray(blockIds) ? blockIds.filter(Boolean) : [],
    commentIds: Array.isArray(commentIds) ? commentIds.filter(Boolean) : [],
    updatedAt: row.updated_at,
  };
}

export async function upsertJiraCommentSectionState(env, state) {
  if (!hasDb(env) || !state.issueKey) {
    return false;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO jira_comment_sections (
        issue_key,
        page_id,
        block_ids_json,
        comment_ids_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        page_id = excluded.page_id,
        block_ids_json = excluded.block_ids_json,
        comment_ids_json = excluded.comment_ids_json,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      state.issueKey,
      state.pageId || null,
      JSON.stringify(Array.isArray(state.blockIds) ? state.blockIds.filter(Boolean) : []),
      JSON.stringify(Array.isArray(state.commentIds) ? state.commentIds.filter(Boolean) : []),
      now
    )
    .run();

  return true;
}

export async function deleteJiraCommentSectionState(env, issueKey) {
  if (!hasDb(env) || !issueKey) {
    return false;
  }

  await env.DB.prepare(
    `
      DELETE FROM jira_comment_sections
      WHERE issue_key = ?
    `
  )
    .bind(issueKey)
    .run();

  return true;
}

export async function getNotionCommentLink(env, notionCommentId) {
  if (!hasDb(env) || !notionCommentId) {
    return null;
  }

  return (
    (await env.DB.prepare(
      `
        SELECT
          notion_comment_id,
          jira_comment_id,
          issue_key,
          page_id,
          last_synced_text,
          created_at,
          updated_at
        FROM notion_comment_links
        WHERE notion_comment_id = ?
        LIMIT 1
      `
    )
      .bind(notionCommentId)
      .first()) || null
  );
}

export async function upsertNotionCommentLink(env, link) {
  if (!hasDb(env) || !link.notionCommentId || !link.jiraCommentId || !link.issueKey) {
    return false;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO notion_comment_links (
        notion_comment_id,
        jira_comment_id,
        issue_key,
        page_id,
        last_synced_text,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(notion_comment_id) DO UPDATE SET
        jira_comment_id = excluded.jira_comment_id,
        issue_key = excluded.issue_key,
        page_id = excluded.page_id,
        last_synced_text = excluded.last_synced_text,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      link.notionCommentId,
      link.jiraCommentId,
      link.issueKey,
      link.pageId || null,
      link.lastSyncedText || null,
      link.createdAt || now,
      now
    )
    .run();

  return true;
}

export async function deleteNotionCommentLink(env, notionCommentId) {
  if (!hasDb(env) || !notionCommentId) {
    return false;
  }

  await env.DB.prepare(
    `
      DELETE FROM notion_comment_links
      WHERE notion_comment_id = ?
    `
  )
    .bind(notionCommentId)
    .run();

  return true;
}

export async function listMappedJiraCommentIdsForIssue(env, issueKey) {
  if (!hasDb(env) || !issueKey) {
    return [];
  }

  const result = await env.DB.prepare(
    `
      SELECT jira_comment_id
      FROM notion_comment_links
      WHERE issue_key = ?
        AND jira_comment_id IS NOT NULL
        AND jira_comment_id != ''
    `
  )
    .bind(issueKey)
    .all();

  return (result.results || [])
    .map((row) => String(row.jira_comment_id || '').trim())
    .filter(Boolean);
}
