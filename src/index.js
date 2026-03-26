import { getIssueSyncState, hasDb, saveIssueSyncState } from './db.js';
import { buildJiraIssueFieldUpdate, fetchJiraIssue, toIssueRecord, transitionJiraIssue, updateJiraIssueFields } from './jira.js';
import { fetchNotionPage, getNotionIssueKey, getNotionStatus, getNotionWritableIssueFields, upsertIssuePage } from './notion.js';

/**
 * Returns a JSON response with standard formatting.
 */
function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

/**
 * Verifies the shared webhook secret from either the query string or header.
 */
function isAuthorized(request, env) {
  const expected = String(env.WEBHOOK_SHARED_SECRET || '').trim();
  if (!expected) {
    return true;
  }

  const url = new URL(request.url);
  const querySecret = url.searchParams.get('secret') || '';
  const headerSecret = request.headers.get('x-webhook-secret') || '';
  return querySecret === expected || headerSecret === expected;
}

/**
 * Safely parses a JSON request body.
 */
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Pulls just the Jira webhook fields that this Worker currently needs.
 */
function getJiraEvent(payload) {
  const issue = payload?.issue || {};
  const project = issue.fields?.project || {};
  const worklog = payload?.worklog || {};

  return {
    eventType: payload?.webhookEvent || '',
    issueKey: issue.key || '',
    issueId: String(issue.id || worklog.issueId || '').trim(),
    projectKey: project.key || '',
  };
}

/**
 * Pulls just the Notion webhook fields that this Worker currently needs.
 */
function getNotionEvent(payload) {
  const entity = payload?.entity || {};
  const data = payload?.data || {};

  return {
    eventId: payload?.id || '',
    eventType: payload?.type || payload?.event || '',
    entityType: entity.type || '',
    attemptNumber: Number(payload?.attempt_number || 1),
    eventTimestamp: payload?.timestamp || '',
    pageId:
      data.page_id ||
      data.page?.id ||
      (data.parent?.type === 'page' ? data.parent.id || '' : '') ||
      (entity.type === 'page' ? entity.id || '' : ''),
  };
}

/**
 * Returns true when two status names match case-insensitively.
 */
function sameText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

/**
 * Handles Jira issue-update webhooks and syncs the current Jira issue state
 * into the matching Notion page.
 */
async function handleJiraWebhook(env, payload) {
  const event = getJiraEvent(payload);
  const supportedEvents = new Set(['jira:issue_updated', 'worklog_created', 'worklog_updated', 'worklog_deleted']);

  // Keep the log small and focused so tail output is easy to scan.
  console.log('[jira:webhook]', event);

  if (!supportedEvents.has(event.eventType)) {
    return {
      ok: true,
      processed: false,
      reason: `Ignored Jira event ${event.eventType || 'unknown'}.`,
      ...event,
    };
  }

  if (!event.issueKey && !event.issueId) {
    return { ok: false, error: 'missing_issue_reference' };
  }

  const issueReference = event.issueKey || event.issueId;
  const jiraIssue = await fetchJiraIssue(env, issueReference);
  const issue = toIssueRecord(env, jiraIssue);
  const state = await getIssueSyncState(env, issue.issueKey);
  const notionPageId = await upsertIssuePage(env, issue, state?.notion_page_id || null);

  await saveIssueSyncState(env, {
    issueKey: issue.issueKey,
    projectKey: issue.projectKey,
    projectName: issue.projectName,
    notionPageId,
    lastJiraEventAt: new Date().toISOString(),
    lastSyncedStatus: issue.status,
  });

  return {
    ok: true,
    processed: true,
    eventType: event.eventType,
    issueKey: issue.issueKey,
    projectKey: issue.projectKey,
    notionPageId,
    status: issue.status,
  };
}

/**
 * Handles Notion page-update webhooks and applies a matching Jira status
 * transition when the Notion Status value has diverged from the last synced
 * Jira status.
 */
async function handleNotionWebhook(env, payload) {
  const event = getNotionEvent(payload);
  const deliveredAt = Date.now();
  const eventAt = event.eventTimestamp ? Date.parse(event.eventTimestamp) : NaN;
  const deliveryLagMs = Number.isNaN(eventAt) ? null : Math.max(0, deliveredAt - eventAt);

  console.log('[notion:webhook]', {
    eventId: event.eventId,
    eventType: event.eventType,
    entityType: event.entityType,
    pageId: event.pageId,
    attemptNumber: event.attemptNumber,
    eventTimestamp: event.eventTimestamp,
    deliveryLagMs,
  });

  if (event.eventType.startsWith('comment.')) {
    return {
      ok: true,
      processed: false,
      reason: `Ignored Notion event ${event.eventType}.`,
      ...event,
    };
  }

  if (!event.pageId) {
    return {
      ok: true,
      processed: false,
      reason: `Ignored Notion event ${event.eventType || 'unknown'} with no page id.`,
      ...event,
    };
  }

  const page = await fetchNotionPage(env, event.pageId);
  const issueKey = getNotionIssueKey(page);
  if (!issueKey) {
    return {
      ok: true,
      processed: false,
      reason: 'Ignored Notion page with no Issue Key value.',
      pageId: event.pageId,
    };
  }

  const notionIssue = getNotionWritableIssueFields(page);
  const notionStatus = getNotionStatus(page);
  if (!notionStatus) {
    return {
      ok: true,
      processed: false,
      reason: 'Ignored Notion page with no Status value.',
      issueKey,
      pageId: event.pageId,
    };
  }

  const now = new Date().toISOString();
  const state = await getIssueSyncState(env, issueKey);
  const currentJiraIssue = toIssueRecord(env, await fetchJiraIssue(env, issueKey));

  console.log('[notion:status-check]', {
    eventId: event.eventId,
    issueKey,
    pageId: event.pageId,
    notionStatus,
    jiraStatus: currentJiraIssue.status,
  });

  const transition = sameText(notionStatus, currentJiraIssue.status)
    ? {
        result: 'already',
        currentStatus: currentJiraIssue.status,
        appliedTarget: currentJiraIssue.status,
      }
    : await transitionJiraIssue(env, issueKey, notionStatus);

  console.log('[notion:jira-transition]', {
    eventId: event.eventId,
    issueKey,
    pageId: event.pageId,
    notionStatus,
    result: transition.result,
    currentStatus: transition.currentStatus || null,
    mappedStatus: transition.mappedStatus || null,
    appliedTarget: transition.appliedTarget || null,
    availableTargets: transition.availableTargets || null,
  });

  const issueUpdate = buildJiraIssueFieldUpdate(env, notionIssue, currentJiraIssue);

  console.log('[notion:jira-fields]', {
    eventId: event.eventId,
    issueKey,
    pageId: event.pageId,
    changedFields: issueUpdate.changedFields,
  });

  if (transition.result === 'already' && issueUpdate.changedFields.length === 0) {
    await saveIssueSyncState(env, {
      issueKey,
      projectKey: state?.project_key || currentJiraIssue.projectKey || null,
      projectName: state?.project_name || currentJiraIssue.projectName || null,
      notionPageId: event.pageId,
      lastNotionEventAt: now,
      lastSyncedStatus: currentJiraIssue.status,
    });

    return {
      ok: true,
      processed: false,
      issueKey,
      pageId: event.pageId,
      notionStatus,
      jiraTransitionResult: transition.result,
      changedFields: issueUpdate.changedFields,
      reason: 'Notion values already match Jira.',
    };
  }

  const statusApplied = transition.result === 'applied';
  const fieldApplied = issueUpdate.changedFields.length > 0
    ? await updateJiraIssueFields(env, issueKey, issueUpdate.fields)
    : false;

  if (!statusApplied && !fieldApplied && transition.result !== 'already') {
    await saveIssueSyncState(env, {
      issueKey,
      projectKey: state?.project_key || currentJiraIssue.projectKey || null,
      projectName: state?.project_name || currentJiraIssue.projectName || null,
      notionPageId: event.pageId,
      lastNotionEventAt: now,
      lastSyncedStatus: currentJiraIssue.status,
    });

    return {
      ok: true,
      processed: false,
      issueKey,
      pageId: event.pageId,
      notionStatus,
      jiraTransitionResult: transition.result,
      changedFields: issueUpdate.changedFields,
      availableTargets: transition.availableTargets || undefined,
      reason: issueUpdate.changedFields.length === 0 ? 'Notion values already match Jira.' : undefined,
    };
  }

  const refreshedIssue = toIssueRecord(env, await fetchJiraIssue(env, issueKey));
  const notionPageId = await upsertIssuePage(env, refreshedIssue, state?.notion_page_id || event.pageId);

  await saveIssueSyncState(env, {
    issueKey,
    projectKey: refreshedIssue.projectKey,
    projectName: refreshedIssue.projectName,
    notionPageId,
    lastNotionEventAt: now,
    lastSyncedStatus: refreshedIssue.status,
  });

  return {
    ok: true,
    processed: statusApplied || fieldApplied,
    issueKey,
    pageId: notionPageId,
    notionStatus,
    jiraTransitionResult: transition.result,
    jiraCurrentStatus: refreshedIssue.status,
    jiraTargetStatus: transition.appliedTarget || transition.mappedStatus || refreshedIssue.status,
    changedFields: issueUpdate.changedFields,
  };
}

export default {
  /**
   * Main Cloudflare Worker request handler.
   */
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({
          ok: true,
          service: 'jira-to-notion-sync',
          dbConfigured: hasDb(env),
          time: new Date().toISOString(),
        });
      }

      if (request.method === 'POST' && url.pathname === '/webhook/jira') {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: 'unauthorized' }, { status: 401 });
        }

        const payload = await readJson(request);
        if (!payload) {
          return json({ ok: false, error: 'invalid_json' }, { status: 400 });
        }

        return json(await handleJiraWebhook(env, payload));
      }

      if (request.method === 'POST' && url.pathname === '/webhook/notion') {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: 'unauthorized' }, { status: 401 });
        }

        const payload = await readJson(request);
        if (!payload) {
          return json({ ok: false, error: 'invalid_json' }, { status: 400 });
        }

        return json(await handleNotionWebhook(env, payload));
      }

      return json({ ok: false, error: 'not_found' }, { status: 404 });
    } catch (error) {
      console.error('worker_error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return json(
        {
          ok: false,
          error: 'worker_error',
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  },
};
