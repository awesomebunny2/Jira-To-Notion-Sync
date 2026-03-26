import {
  getIssueSyncState,
  getWebhookEvent,
  hasDb,
  listRecentWebhookEvents,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  recordWebhookEvent,
  upsertIssueSyncState,
} from "./db.js";
import { countJiraIssues, fetchJiraIssue, jiraIssueToRow, searchJiraIssues, transitionJiraIssue } from "./jira.js";
import {
  countIssuePages,
  fetchDatabaseSchema,
  fetchNotionPage,
  getNotionIssueKey,
  getNotionStatus,
  queryIssuePages,
  upsertIssuePage,
} from "./notion.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function getSecret(requestUrl, request, env) {
  const url = new URL(requestUrl);
  const querySecret = url.searchParams.get("secret") || "";
  const headerSecret = request.headers.get("x-webhook-secret") || "";
  const configuredSecret = (env.WEBHOOK_SHARED_SECRET || "").trim();

  if (!configuredSecret) {
    return { ok: true };
  }

  if (querySecret === configuredSecret || headerSecret === configuredSecret) {
    return { ok: true };
  }

  return { ok: false };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeHeaders(request) {
  return {
    "x-atlassian-webhook-identifier": request.headers.get("x-atlassian-webhook-identifier") || "",
    "x-atlassian-webhook-retry": request.headers.get("x-atlassian-webhook-retry") || "",
    "user-agent": request.headers.get("user-agent") || "",
  };
}

function makeEventId(source, eventType, issueKey, pageId, payload, headers) {
  const notionEventId = source === "notion" ? String(payload?.id || "").trim() : "";
  if (notionEventId) {
    return notionEventId;
  }

  const jiraWebhookId = source === "jira" ? String(headers?.["x-atlassian-webhook-identifier"] || "").trim() : "";
  if (jiraWebhookId) {
    return jiraWebhookId;
  }

  return [
    source || "unknown",
    eventType || "unknown",
    issueKey || "no-issue",
    pageId || "no-page",
    crypto.randomUUID(),
  ].join(":");
}

function extractJiraMetadata(payload) {
  const issue = payload.issue || {};
  const fields = issue.fields || {};
  const project = fields.project || {};

  return {
    eventType: payload.webhookEvent || payload.issue_event_type_name || "jira.event",
    issueKey: issue.key || "",
    projectKey: project.key || "",
    commentId: String(payload?.comment?.id || "").trim(),
  };
}

function extractNotionMetadata(payload) {
  const entity = payload.entity || {};
  const data = payload.data || {};
  const isCommentEvent = String(payload.type || "").startsWith("comment.");

  return {
    eventType: payload.type || payload.event || "notion.event",
    commentId: isCommentEvent && entity.type === "comment" ? entity.id || "" : "",
    pageId:
      data.page_id ||
      (data.page && data.page.id) ||
      (data.parent && data.parent.page_id) ||
      (!isCommentEvent && entity.type === "page" ? entity.id || "" : "") ||
      "",
  };
}

function isJiraCommentMissingError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Jira request failed (404)") && message.includes("Can not find a comment for the id");
}

function logWebhook(stage, details = {}) {
  const payload = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  console.log(`[webhook:${stage}]`, payload);
}

async function processJiraEvent(env, metadata, eventId) {
  if (!metadata.issueKey) {
    return {
      processed: false,
      reason: "No issue key in Jira event payload.",
    };
  }

  const supportedEvents = new Set([
    "jira:issue_created",
    "jira:issue_updated",
  ]);

  if (!supportedEvents.has(metadata.eventType)) {
    await markWebhookEventProcessed(env, eventId, null);
    return {
      processed: false,
      reason: `Jira event type ${metadata.eventType} is recorded but not yet synced.`,
    };
  }

  const issue = await fetchJiraIssue(env, metadata.issueKey);
  const row = jiraIssueToRow(env, issue);
  const state = await getIssueSyncState(env, metadata.issueKey);
  const notionPageId = await upsertIssuePage(env, row, state?.notion_page_id || null);

  await upsertIssueSyncState(env, {
    issueKey: row.key,
    projectKey: row["Project Key"],
    projectName: row["Project Name"],
    notionPageId,
    epicKey: row["Epic Key"],
    epicName: row["Epic Name"],
    lastJiraEventAt: new Date().toISOString(),
    lastSyncedStatus: row.status,
    lastSyncedPrLinks: state?.last_synced_pr_links || null,
  });

  await markWebhookEventProcessed(env, eventId, notionPageId);

  return {
    processed: true,
    notionPageId,
    reason:
      "Jira issue synced to Notion.",
  };
}

async function processNotionEvent(env, metadata, eventId) {
  if (String(metadata.eventType || "").startsWith("comment.")) {
    await markWebhookEventProcessed(env, eventId, metadata.pageId || null);
    return {
      processed: false,
      jiraTransitionResult: null,
      reason: "Notion comment events are intentionally ignored. Jira is the source of truth for comments.",
    };
  }

  if (!metadata.pageId) {
    return {
      processed: false,
      reason: "No page ID in Notion event payload.",
    };
  }

  const page = await fetchNotionPage(env, metadata.pageId);
  const issueKey = getNotionIssueKey(page);
  if (!issueKey) {
    await markWebhookEventProcessed(env, eventId, metadata.pageId);
    return {
      processed: false,
      reason: "Notion page has no Issue Key property value.",
    };
  }

  const notionStatus = getNotionStatus(page);
  const state = await getIssueSyncState(env, issueKey);

  if (!notionStatus) {
    await markWebhookEventProcessed(env, eventId, metadata.pageId);
    return {
      processed: false,
      reason: "Notion page has no Status value.",
    };
  }

  if ((state?.last_synced_status || "").trim().toLowerCase() === notionStatus.trim().toLowerCase()) {
    await markWebhookEventProcessed(env, eventId, metadata.pageId);
    await upsertIssueSyncState(env, {
      issueKey,
      notionPageId: metadata.pageId,
      projectKey: state?.project_key || null,
      projectName: state?.project_name || null,
      epicKey: state?.epic_key || null,
      epicName: state?.epic_name || null,
      lastNotionEventAt: new Date().toISOString(),
      lastSyncedStatus: state?.last_synced_status || notionStatus,
      lastSyncedPrLinks: state?.last_synced_pr_links || null,
      lastJiraCommentSyncAt: state?.last_jira_comment_sync_at || null,
    });
    return {
      processed: false,
      reason: "Notion status already matches the last synced Jira status.",
    };
  }

  const transition = await transitionJiraIssue(env, issueKey, notionStatus);
  await upsertIssueSyncState(env, {
    issueKey,
    notionPageId: metadata.pageId,
    projectKey: state?.project_key || null,
    projectName: state?.project_name || null,
    epicKey: state?.epic_key || null,
    epicName: state?.epic_name || null,
    lastNotionEventAt: new Date().toISOString(),
    lastSyncedStatus: transition.result === "unavailable" ? state?.last_synced_status || null : notionStatus,
    lastSyncedPrLinks: state?.last_synced_pr_links || null,
    lastJiraCommentSyncAt: state?.last_jira_comment_sync_at || null,
  });
  await markWebhookEventProcessed(env, eventId, metadata.pageId);

  return {
    processed: transition.result === "applied" || transition.result === "already",
    jiraTransitionResult: transition.result,
    reason:
      transition.result === "unavailable"
        ? `No Jira transition available for status '${notionStatus}'.`
        : `Notion status sync result: ${transition.result}.`,
  };
}

async function backfillJiraIssue(env, issueKey) {
  if (!issueKey) {
    return {
      processed: false,
      reason: "Missing issueKey query parameter.",
    };
  }

  const issue = await fetchJiraIssue(env, issueKey);
  const row = jiraIssueToRow(env, issue);
  const state = await getIssueSyncState(env, issueKey);
  const notionPageId = await upsertIssuePage(env, row, state?.notion_page_id || null);

  await upsertIssueSyncState(env, {
    issueKey: row.key,
    projectKey: row["Project Key"],
    projectName: row["Project Name"],
    notionPageId,
    epicKey: row["Epic Key"],
    epicName: row["Epic Name"],
    lastJiraEventAt: new Date().toISOString(),
    lastSyncedStatus: row.status,
    lastSyncedPrLinks: state?.last_synced_pr_links || null,
  });

  return {
    processed: true,
    notionPageId,
    issueKey: row.key,
    projectKey: row["Project Key"],
    note: "Jira issue fetched and Notion page backfilled.",
  };
}

function parseFieldsParam(url) {
  const raw = (url.searchParams.get("fields") || "").trim();
  if (!raw) {
    return null;
  }

  const fields = raw
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);

  return fields.length > 0 ? fields : null;
}

async function backfillNotionDatabaseFromJira(env, { cursor = null, limit = 25, selectedFields = null } = {}) {
  const batch = await queryIssuePages(env, {
    startCursor: cursor,
    pageSize: limit,
  });
  const schema = await fetchDatabaseSchema(env);

  const refreshed = [];
  const skipped = [];
  const failed = [];

  for (const page of batch.results) {
    const issueKey = getNotionIssueKey(page);
    if (!issueKey) {
      skipped.push({
        pageId: page.id,
        reason: "Missing Issue Key",
      });
      continue;
    }

    try {
      const issue = await fetchJiraIssue(env, issueKey);
      const row = jiraIssueToRow(env, issue);
      const notionPageId = await upsertIssuePage(env, row, page.id, schema, selectedFields);
      const state = await getIssueSyncState(env, issueKey);

      await upsertIssueSyncState(env, {
        issueKey: row.key,
        projectKey: row["Project Key"],
        projectName: row["Project Name"],
        notionPageId,
        epicKey: row["Epic Key"],
        epicName: row["Epic Name"],
        lastJiraEventAt: new Date().toISOString(),
        lastSyncedStatus: row.status,
        lastSyncedPrLinks: state?.last_synced_pr_links || null,
      });

      refreshed.push({
        issueKey: row.key,
        pageId: notionPageId,
        projectKey: row["Project Key"] || null,
        updatedFields: selectedFields || "all",
      });
    } catch (error) {
      failed.push({
        issueKey,
        pageId: page.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: true,
    processedCount: refreshed.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    refreshed,
    skipped,
    failed,
    hasMore: batch.hasMore,
    nextCursor: batch.nextCursor,
  };
}

async function importJiraIssuesToNotion(env, { nextPageToken = "", limit = 10, jql = "" } = {}) {
  const [search, total] = await Promise.all([
    searchJiraIssues(env, {
      nextPageToken,
      maxResults: limit,
      jql,
    }),
    countJiraIssues(env, { jql }),
  ]);

  const imported = [];
  const failed = [];

  for (const issue of search.issues || []) {
    const issueKey = issue.key || "";

    try {
      const row = jiraIssueToRow(env, issue);
      const state = await getIssueSyncState(env, issueKey);
      const notionPageId = await upsertIssuePage(env, row, state?.notion_page_id || null);

      await upsertIssueSyncState(env, {
        issueKey: row.key,
        projectKey: row["Project Key"],
        projectName: row["Project Name"],
        notionPageId,
        epicKey: row["Epic Key"],
        epicName: row["Epic Name"],
        lastJiraEventAt: new Date().toISOString(),
        lastSyncedStatus: row.status,
        lastSyncedPrLinks: state?.last_synced_pr_links || null,
      });

      imported.push({
        issueKey: row.key,
        pageId: notionPageId,
        projectKey: row["Project Key"] || null,
      });
    } catch (error) {
      failed.push({
        issueKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: true,
    total,
    maxResults: Math.max(1, Math.min(100, Number(limit) || 10)),
    importedCount: imported.length,
    failedCount: failed.length,
    imported,
    failed,
    hasMore: !search.isLast && Boolean(search.nextPageToken),
    nextPageToken: !search.isLast ? search.nextPageToken : null,
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          service: "jira-to-notion-sync",
          mode: "cloudflare-worker",
          dbConfigured: hasDb(env),
          time: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          message: "Use /health, /webhook/jira, or /webhook/notion.",
        });
      }

      if (request.method === "GET" && url.pathname === "/debug/events") {
        const auth = getSecret(request.url, request, env);
        if (!auth.ok) {
          return json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const limit = url.searchParams.get("limit") || "20";
        const events = await listRecentWebhookEvents(env, limit);
        return json({
          ok: true,
          dbConfigured: hasDb(env),
          count: events.length,
          events,
        });
      }

      if (request.method === "GET" && url.pathname === "/debug/notion-issue-count") {
        const auth = getSecret(request.url, request, env);
        if (!auth.ok) {
          return json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const count = await countIssuePages(env);
        return json({
          ok: true,
          count,
        });
      }

      if (request.method === "POST" && url.pathname === "/debug/backfill/jira") {
        const auth = getSecret(request.url, request, env);
        if (!auth.ok) {
          return json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const issueKey = (url.searchParams.get("issueKey") || "").trim();
        const result = await backfillJiraIssue(env, issueKey);
        return json({
          ok: result.processed,
          ...result,
        }, { status: result.processed ? 200 : 400 });
      }

      if (request.method === "POST" && url.pathname === "/debug/backfill/notion-database") {
        const auth = getSecret(request.url, request, env);
        if (!auth.ok) {
          return json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const cursor = (url.searchParams.get("cursor") || "").trim() || null;
        const limit = Number(url.searchParams.get("limit") || "25");
        const selectedFields = parseFieldsParam(url);
        const result = await backfillNotionDatabaseFromJira(env, {
          cursor,
          limit,
          selectedFields,
        });
        return json(result, { status: 200 });
      }

      if (request.method === "POST" && url.pathname === "/debug/import/jira") {
        const auth = getSecret(request.url, request, env);
        if (!auth.ok) {
          return json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const nextPageToken = (url.searchParams.get("nextPageToken") || "").trim();
        const limit = Number(url.searchParams.get("limit") || "10");
        const jql = (url.searchParams.get("jql") || "").trim();
        const result = await importJiraIssuesToNotion(env, {
          nextPageToken,
          limit,
          jql,
        });
        return json(result, { status: 200 });
      }

      if (request.method === "POST" && (url.pathname === "/webhook/jira" || url.pathname === "/webhook/notion")) {
        const auth = getSecret(request.url, request, env);
        if (!auth.ok) {
          return json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const payload = await readJson(request);
        if (!payload) {
          return json({ ok: false, error: "invalid_json" }, { status: 400 });
        }

        const source = url.pathname.endsWith("/jira") ? "jira" : "notion";
        const metadata = source === "jira" ? extractJiraMetadata(payload) : extractNotionMetadata(payload);
        const headers = normalizeHeaders(request);
        const eventId = makeEventId(source, metadata.eventType, metadata.issueKey, metadata.pageId, payload, headers);
        logWebhook("received", {
          source,
          eventType: metadata.eventType,
          issueKey: metadata.issueKey || null,
          projectKey: metadata.projectKey || null,
          pageId: metadata.pageId || null,
          commentId: metadata.commentId || null,
          eventId,
          webhookIdentifier: headers["x-atlassian-webhook-identifier"] || null,
          retryCount: Number(headers["x-atlassian-webhook-retry"] || 0),
        });
        const recorded = await recordWebhookEvent(env, {
          id: eventId,
          source,
          eventType: metadata.eventType,
          issueKey: metadata.issueKey,
          projectKey: metadata.projectKey,
          pageId: metadata.pageId,
          webhookIdentifier: headers["x-atlassian-webhook-identifier"],
          retryCount: Number(headers["x-atlassian-webhook-retry"] || 0),
          headers,
          payload,
          receivedAt: new Date().toISOString(),
        });

        if (!recorded) {
          const existingEvent = await getWebhookEvent(env, eventId);
          if (["received", "processed"].includes(existingEvent?.status || "")) {
            logWebhook("duplicate-event", {
              source,
              eventType: metadata.eventType,
              issueKey: metadata.issueKey || null,
              pageId: metadata.pageId || null,
              commentId: metadata.commentId || null,
              eventId,
              existingStatus: existingEvent.status,
            });
            return json({
              ok: true,
              dbConfigured: hasDb(env),
              eventRecorded: false,
              duplicate: true,
              source,
              eventType: metadata.eventType,
              issueKey: metadata.issueKey || null,
              projectKey: metadata.projectKey || null,
              pageId: metadata.pageId || null,
              processed: false,
              notionPageId: existingEvent?.page_id || null,
              jiraTransitionResult: null,
              note: `Duplicate webhook delivery ignored because event is already ${existingEvent.status}.`,
            });
          }
        }

        if (url.pathname === "/webhook/notion" && payload.verification_token) {
          console.log("notion_verification_token", payload.verification_token);
          return json({
            ok: true,
            dbConfigured: hasDb(env),
            eventRecorded: recorded,
            verification_token_received: true,
          verification_token: payload.verification_token,
        });
      }

        let processing = {
          processed: false,
          reason: "Event recorded only.",
        };

        if (source === "jira") {
          try {
            processing = await processJiraEvent(env, metadata, eventId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await markWebhookEventFailed(env, eventId, message);
            throw error;
          }
        } else if (source === "notion") {
          try {
            processing = await processNotionEvent(env, metadata, eventId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await markWebhookEventFailed(env, eventId, message);
            throw error;
          }
        }

        logWebhook("processed", {
          source,
          eventType: metadata.eventType,
          issueKey: metadata.issueKey || null,
          pageId: metadata.pageId || null,
          commentId: metadata.commentId || null,
          eventId,
          processed: processing.processed,
          notionPageId: processing.notionPageId || null,
          jiraTransitionResult: processing.jiraTransitionResult || null,
          note: processing.reason || "Event accepted and recorded.",
        });
        return json({
          ok: true,
          dbConfigured: hasDb(env),
          eventRecorded: recorded,
          source,
          eventType: metadata.eventType,
          issueKey: metadata.issueKey || null,
          projectKey: metadata.projectKey || null,
          pageId: metadata.pageId || null,
          processed: processing.processed,
          notionPageId: processing.notionPageId || null,
          jiraTransitionResult: processing.jiraTransitionResult || null,
          note: processing.reason || "Event accepted and recorded.",
        }, { status: 202 });
      }

      return json({ ok: false, error: "not_found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("worker_error", {
        message,
        stack: error instanceof Error ? error.stack : null,
      });
      return json({
        ok: false,
        error: "worker_error",
        message,
      }, { status: 500 });
    }
  },
};
