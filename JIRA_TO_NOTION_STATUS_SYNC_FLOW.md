# Jira to Notion Status Sync Flow

This document describes the current code path when Jira sends an `issue_updated` webhook.

## Current scope
- Only `POST /webhook/jira` is active
- Only Jira `jira:issue_updated` events are processed
- The Worker updates the matching Notion page
- Comment syncing is not part of this flow

## Request flow

1. Jira sends a webhook request to `/webhook/jira`.
2. The Worker checks the shared secret.
3. The Worker parses the JSON payload.
4. The Worker reads the Jira event metadata:
   - event type
   - issue key
   - project key
5. If the event is not `jira:issue_updated`, the Worker ignores it.
6. If the event is `jira:issue_updated`, the Worker fetches the live Jira issue from the Jira REST API.
7. The Jira issue response is converted into a small plain issue record used by the Notion sync code.
8. The Worker checks D1 for an existing saved mapping for that Jira issue.
9. The Worker upserts the matching Notion page:
   - update the existing page if a page id is already known
   - otherwise look up a page by `Issue Key`
   - if no page exists, create one
10. The Worker saves the resulting Notion page id and latest synced status into D1.
11. The Worker returns a JSON response describing what it processed.

## Notion properties currently written
- `Name`
- `Issue Key`
- `Status`
- `Project Key`
- `Project Name`
- `Jira URL`

## Files involved
- `src/index.js`
  - request handling
  - webhook auth
  - Jira event filtering
- `src/jira.js`
  - Jira API request
  - Jira issue mapping
- `src/notion.js`
  - Notion page lookup
  - Notion page create/update
- `src/db.js`
  - D1 lookup and save for issue sync state

## Design constraints
- The code is intentionally narrow.
- The goal of this step is only to prove Jira issue updates can move status changes into Notion reliably.
- Additional fields and webhook types should be added only after this path is confirmed stable.
