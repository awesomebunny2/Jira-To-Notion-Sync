import {
  acquireNotionIssueSyncLock,
  acquireJiraCommentSyncLock,
  consumePendingNotionIssueSyncLock,
  consumePendingJiraCommentSyncLock,
  deleteJiraCommentSectionState,
  getIssueSyncState,
  getJiraCommentSectionState,
  getNotionIssueSyncFingerprint,
  hasDb,
  releaseNotionIssueSyncLock,
  releaseJiraCommentSyncLock,
  saveIssueSyncState,
  saveNotionIssueSyncFingerprint,
  saveJiraCommentSectionState,
} from './db.js';
import {
  addJiraComment,
  buildJiraIssueFieldUpdate,
  fetchJiraComments,
  fetchJiraIssue,
  toCommentRecord,
  toIssueRecord,
  transitionJiraIssue,
  updateJiraIssueFields,
} from './jira.js';
import {
  clearNotionCommentDraft,
  fetchNotionPage,
  getNotionIssueKey,
  getNotionStatus,
  getNotionWritableIssueFields,
  replaceJiraCommentsSection,
  upsertIssuePage,
} from './notion.js';

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
  const comment = payload?.comment || {};

  return {
    eventType: payload?.webhookEvent || '',
    issueKey: issue.key || '',
    issueId: String(issue.id || worklog.issueId || '').trim(),
    projectKey: project.key || '',
    commentId: String(comment.id || '').trim(),
  };
}

/**
 * Captures the Jira delivery headers that help explain retries or overlapping
 * webhook deliveries for the same user action.
 */
function getJiraDelivery(request, payload) {
  return {
    webhookIdentifier: String(request.headers.get('x-atlassian-webhook-identifier') || '').trim(),
    retryCount: Number(request.headers.get('x-atlassian-webhook-retry') || 0),
    issueEventTypeName: String(payload?.issue_event_type_name || '').trim(),
  };
}

/**
 * Returns true when the Jira event should refresh the mirrored Jira comments.
 */
function isJiraCommentEvent(eventType) {
  return new Set(['comment_created', 'comment_updated', 'comment_deleted']).has(String(eventType || '').trim());
}

/**
 * Mirrors Jira comments into the managed Notion comments container, serializing
 * concurrent refreshes per issue when the lock table is available.
 */
async function syncJiraCommentsToNotion(env, issueKey, notionPageId, eventType) {
  const lock = await acquireJiraCommentSyncLock(env, issueKey);
  if (!lock.acquired) {
    console.log('[jira:comments-sync-skipped]', {
      eventType,
      issueKey,
      notionPageId,
      reason: 'lock_busy',
    });
    return null;
  }

  let commentCount = null;
  try {
    let shouldRunAgain = false;

    do {
      const comments = (await fetchJiraComments(env, issueKey)).map(toCommentRecord);
      const commentSectionState = await getJiraCommentSectionState(env, issueKey);
      const commentSection = await replaceJiraCommentsSection(
        env,
        notionPageId,
        comments,
        commentSectionState?.blockIds || []
      );

      if (commentSection.blockIds.length > 0) {
        await saveJiraCommentSectionState(env, {
          issueKey,
          pageId: notionPageId,
          blockIds: commentSection.blockIds,
        });
      } else {
        await deleteJiraCommentSectionState(env, issueKey);
      }

      commentCount = commentSection.commentCount;

      console.log('[jira:comments-sync]', {
        eventType,
        issueKey,
        notionPageId,
        commentCount,
      });

      shouldRunAgain = await consumePendingJiraCommentSyncLock(env, issueKey, lock.token);
      if (shouldRunAgain) {
        console.log('[jira:comments-sync-rerun]', {
          eventType,
          issueKey,
          notionPageId,
        });
      }
    } while (shouldRunAgain);
  } finally {
    await releaseJiraCommentSyncLock(env, issueKey, lock.token);
  }

  return commentCount;
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
 * Builds a stable fingerprint of the live Notion values that can write back
 * into Jira or trigger a queued comment send.
 */
function buildNotionIssueFingerprint(issueKey, notionStatus, notionIssue) {
  const labels = Array.isArray(notionIssue?.labels)
    ? notionIssue.labels.map((label) => String(label || '').trim()).filter(Boolean).sort()
    : [];

  return JSON.stringify({
    issueKey: String(issueKey || '').trim(),
    status: String(notionStatus || '').trim(),
    name: String(notionIssue?.name || '').trim(),
    description: String(notionIssue?.description || '').trim(),
    priority: String(notionIssue?.priority || '').trim(),
    labels,
    originalEstimate: String(notionIssue?.originalEstimate || '').trim(),
    pullRequests: String(notionIssue?.pullRequests || '').trim(),
    startDate: notionIssue?.startDate || null,
    commentQueue: String(notionIssue?.commentQueue || '').trim(),
    commentSubmitAt: notionIssue?.commentSubmitAt || null,
  });
}

/**
 * Returns the expected Notion writable state after the Worker finishes acting
 * on the current page. Queued comments are cleared once they have been sent.
 */
function getExpectedNotionIssueState(notionIssue, commentCreated) {
  if (!commentCreated) {
    return notionIssue;
  }

  return {
    ...notionIssue,
    commentQueue: '',
    commentSubmitAt: null,
  };
}

/**
 * Handles Jira issue-update webhooks and syncs the current Jira issue state
 * into the matching Notion page.
 */
async function handleJiraWebhook(env, payload, delivery = {}) {
  const event = getJiraEvent(payload);
  const supportedEvents = new Set([
    'jira:issue_updated',
    'worklog_created',
    'worklog_updated',
    'worklog_deleted',
    'comment_created',
    'comment_updated',
    'comment_deleted',
  ]);

  // Keep the log small and focused so tail output is easy to scan.
  console.log('[jira:webhook]', {
    ...event,
    webhookIdentifier: delivery.webhookIdentifier || null,
    retryCount: delivery.retryCount || 0,
    issueEventTypeName: delivery.issueEventTypeName || null,
  });

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
  const shouldSyncComments = isJiraCommentEvent(event.eventType) || !state?.notion_page_id;
  let mirroredCommentCount = null;

  if (shouldSyncComments) {
    mirroredCommentCount = await syncJiraCommentsToNotion(env, issue.issueKey, notionPageId, event.eventType);
  }

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
    commentCount: mirroredCommentCount,
  };
}

/**
 * Applies the current live Notion page state to Jira and returns the resulting
 * response plus the post-sync fingerprint that should be remembered for dedupe.
 */
async function processNotionIssuePage(env, event, issueKey, page) {
  const notionIssue = getNotionWritableIssueFields(page);
  const notionStatus = getNotionStatus(page);
  if (!notionStatus) {
    return {
      fingerprint: null,
      response: {
        ok: true,
        processed: false,
        reason: 'Ignored Notion page with no Status value.',
        issueKey,
        pageId: event.pageId,
      },
    };
  }

  const now = new Date().toISOString();
  const state = await getIssueSyncState(env, issueKey);
  const currentJiraIssue = toIssueRecord(env, await fetchJiraIssue(env, issueKey));
  const trimmedCommentQueue = String(notionIssue.commentQueue || '').trim();
  let commentCreated = false;

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

  // A button-updated submit timestamp keeps comment sending out of the normal
  // field-edit flow while still working on Notion's free plan.
  if (trimmedCommentQueue && notionIssue.commentSubmitAt) {
    await addJiraComment(env, issueKey, trimmedCommentQueue);
    await clearNotionCommentDraft(env, event.pageId);
    await syncJiraCommentsToNotion(env, issueKey, event.pageId, 'notion_comment_submit');
    commentCreated = true;

    console.log('[notion:jira-comment]', {
      eventId: event.eventId,
      issueKey,
      pageId: event.pageId,
      submitAt: notionIssue.commentSubmitAt,
      result: 'created',
    });
  }

  const issueUpdate = buildJiraIssueFieldUpdate(env, notionIssue, currentJiraIssue);

  console.log('[notion:jira-fields]', {
    eventId: event.eventId,
    issueKey,
    pageId: event.pageId,
    changedFields: issueUpdate.changedFields,
  });

  const expectedFingerprint = buildNotionIssueFingerprint(
    issueKey,
    notionStatus,
    getExpectedNotionIssueState(notionIssue, commentCreated)
  );

  if (transition.result === 'already' && issueUpdate.changedFields.length === 0 && !commentCreated) {
    await saveIssueSyncState(env, {
      issueKey,
      projectKey: state?.project_key || currentJiraIssue.projectKey || null,
      projectName: state?.project_name || currentJiraIssue.projectName || null,
      notionPageId: event.pageId,
      lastNotionEventAt: now,
      lastSyncedStatus: currentJiraIssue.status,
    });

    return {
      fingerprint: expectedFingerprint,
      response: {
        ok: true,
        processed: false,
        issueKey,
        pageId: event.pageId,
        notionStatus,
        jiraTransitionResult: transition.result,
        changedFields: issueUpdate.changedFields,
        commentCreated,
        reason: 'Notion values already match Jira.',
      },
    };
  }

  const statusApplied = transition.result === 'applied';
  const fieldApplied = issueUpdate.changedFields.length > 0
    ? await updateJiraIssueFields(env, issueKey, issueUpdate.fields)
    : false;

  if (!statusApplied && !fieldApplied && transition.result !== 'already' && !commentCreated) {
    await saveIssueSyncState(env, {
      issueKey,
      projectKey: state?.project_key || currentJiraIssue.projectKey || null,
      projectName: state?.project_name || currentJiraIssue.projectName || null,
      notionPageId: event.pageId,
      lastNotionEventAt: now,
      lastSyncedStatus: currentJiraIssue.status,
    });

    return {
      fingerprint: expectedFingerprint,
      response: {
        ok: true,
        processed: false,
        issueKey,
        pageId: event.pageId,
        notionStatus,
        jiraTransitionResult: transition.result,
        changedFields: issueUpdate.changedFields,
        availableTargets: transition.availableTargets || undefined,
        reason: issueUpdate.changedFields.length === 0 ? 'Notion values already match Jira.' : undefined,
      },
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
    fingerprint: expectedFingerprint,
    response: {
      ok: true,
      processed: commentCreated || statusApplied || fieldApplied,
      issueKey,
      pageId: notionPageId,
      notionStatus,
      jiraTransitionResult: transition.result,
      jiraCurrentStatus: refreshedIssue.status,
      jiraTargetStatus: transition.appliedTarget || transition.mappedStatus || refreshedIssue.status,
      changedFields: issueUpdate.changedFields,
      commentCreated,
    },
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

  if (event.eventType === 'page.content_updated') {
    return {
      ok: true,
      processed: false,
      reason: `Ignored Notion event ${event.eventType}.`,
      ...event,
    };
  }

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

  const lock = await acquireNotionIssueSyncLock(env, issueKey);
  if (!lock.acquired) {
    console.log('[notion:sync-skipped]', {
      eventId: event.eventId,
      issueKey,
      pageId: event.pageId,
      reason: 'lock_busy',
    });

    return {
      ok: true,
      processed: false,
      reason: 'Ignored Notion event while another sync for this issue is already running.',
      issueKey,
      pageId: event.pageId,
    };
  }

  let response = null;
  try {
    let shouldRunAgain = false;

    do {
      const livePage = await fetchNotionPage(env, event.pageId);
      const liveIssueKey = getNotionIssueKey(livePage) || issueKey;
      const liveNotionStatus = getNotionStatus(livePage);

      if (!liveNotionStatus) {
        response = {
          ok: true,
          processed: false,
          reason: 'Ignored Notion page with no Status value.',
          issueKey: liveIssueKey,
          pageId: event.pageId,
        };
      } else {
        const liveNotionIssue = getNotionWritableIssueFields(livePage);
        const fingerprint = buildNotionIssueFingerprint(liveIssueKey, liveNotionStatus, liveNotionIssue);
        const lastFingerprintState = await getNotionIssueSyncFingerprint(env, liveIssueKey);

        if (lastFingerprintState?.fingerprint === fingerprint) {
          console.log('[notion:dedupe-skip]', {
            eventId: event.eventId,
            issueKey: liveIssueKey,
            pageId: event.pageId,
          });

          response = {
            ok: true,
            processed: false,
            issueKey: liveIssueKey,
            pageId: event.pageId,
            notionStatus: liveNotionStatus,
            reason: 'Live Notion page state already processed.',
          };
        } else {
          const processed = await processNotionIssuePage(env, event, liveIssueKey, livePage);
          response = processed.response;

          if (processed.fingerprint) {
            await saveNotionIssueSyncFingerprint(env, {
              issueKey: liveIssueKey,
              pageId: response.pageId || event.pageId,
              fingerprint: processed.fingerprint,
            });
          }
        }
      }

      shouldRunAgain = await consumePendingNotionIssueSyncLock(env, issueKey, lock.token);
      if (shouldRunAgain) {
        console.log('[notion:sync-rerun]', {
          eventId: event.eventId,
          issueKey,
          pageId: event.pageId,
        });
      }
    } while (shouldRunAgain);
  } finally {
    await releaseNotionIssueSyncLock(env, issueKey, lock.token);
  }

  return response;
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

        return json(await handleJiraWebhook(env, payload, getJiraDelivery(request, payload)));
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
