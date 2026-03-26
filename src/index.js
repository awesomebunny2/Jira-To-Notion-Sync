import { getIssueSyncState, hasDb, saveIssueSyncState } from './db.js';
import { fetchJiraIssue, toIssueRecord, transitionJiraIssue } from './jira.js';
import { fetchNotionPage, getNotionIssueKey, getNotionStatus, upsertIssuePage } from './notion.js';

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

  const state = await getIssueSyncState(env, issueKey);
  const lastSyncedStatus = String(state?.last_synced_status || '').trim();
  const now = new Date().toISOString();

  console.log('[notion:status-check]', {
    eventId: event.eventId,
    issueKey,
    pageId: event.pageId,
    notionStatus,
    lastSyncedStatus,
  });

  if (lastSyncedStatus && lastSyncedStatus.toLowerCase() === notionStatus.toLowerCase()) {
    await saveIssueSyncState(env, {
      issueKey,
      notionPageId: event.pageId,
      lastNotionEventAt: now,
      lastSyncedStatus,
    });

    return {
      ok: true,
      processed: false,
      issueKey,
      pageId: event.pageId,
      notionStatus,
      reason: 'Notion status already matches the last synced Jira status.',
    };
  }

  const transition = await transitionJiraIssue(env, issueKey, notionStatus);

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

  await saveIssueSyncState(env, {
    issueKey,
    projectKey: state?.project_key || null,
    projectName: state?.project_name || null,
    notionPageId: event.pageId,
    lastNotionEventAt: now,
    lastSyncedStatus: transition.result === 'unavailable' ? lastSyncedStatus || null : notionStatus,
  });

  return {
    ok: true,
    processed: transition.result === 'applied' || transition.result === 'already',
    issueKey,
    pageId: event.pageId,
    notionStatus,
    jiraTransitionResult: transition.result,
    jiraCurrentStatus: transition.currentStatus || null,
    jiraTargetStatus: transition.appliedTarget || transition.mappedStatus || notionStatus,
    availableTargets: transition.availableTargets || undefined,
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
