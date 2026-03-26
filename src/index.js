import { getIssueSyncState, hasDb, saveIssueSyncState } from './db.js';
import { fetchJiraIssue, toIssueRecord } from './jira.js';
import { upsertIssuePage } from './notion.js';

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

  return {
    eventType: payload?.webhookEvent || '',
    issueKey: issue.key || '',
    projectKey: project.key || '',
  };
}

/**
 * Handles Jira issue-update webhooks and syncs the current Jira issue state
 * into the matching Notion page.
 */
async function handleJiraWebhook(env, payload) {
  const event = getJiraEvent(payload);

  // Keep the log small and focused so tail output is easy to scan.
  console.log('[jira:webhook]', event);

  if (event.eventType !== 'jira:issue_updated') {
    return {
      ok: true,
      processed: false,
      reason: `Ignored Jira event ${event.eventType || 'unknown'}.`,
      ...event,
    };
  }

  if (!event.issueKey) {
    return { ok: false, error: 'missing_issue_key' };
  }

  const jiraIssue = await fetchJiraIssue(env, event.issueKey);
  const issue = toIssueRecord(env, jiraIssue);
  const state = await getIssueSyncState(env, issue.issueKey);
  const notionPageId = await upsertIssuePage(env, issue, state?.notion_page_id || null);

  await saveIssueSyncState(env, {
    issueKey: issue.issueKey,
    projectKey: issue.projectKey,
    projectName: issue.projectName,
    notionPageId,
    lastSyncedStatus: issue.status,
  });

  return {
    ok: true,
    processed: true,
    issueKey: issue.issueKey,
    projectKey: issue.projectKey,
    notionPageId,
    status: issue.status,
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
