# Jira and Notion Issue Sync Flow

This document describes the current lean issue-sync code paths in the rebuilt Worker.

## Current scope
- `POST /webhook/jira` is active
- `POST /webhook/notion` is active
- Jira `jira:issue_updated` and `worklog_*` events update the matching Notion page fields
- Notion page events can trigger Jira status transitions and direct Jira field updates
- Comment syncing is not part of this flow

## Jira to Notion flow

1. Jira sends a webhook request to `/webhook/jira`.
2. The Worker checks the shared secret.
3. The Worker parses the JSON payload.
4. The Worker reads the Jira event metadata:
   - event type
   - issue key
   - project key
5. If the event is not one of the supported Jira issue-refresh events, the Worker ignores it.
6. If the event is `jira:issue_updated` or a supported `worklog_*` event, the Worker fetches the live Jira issue from the Jira REST API.
7. The Jira issue response is converted into a small plain issue record used by the Notion sync code.
8. The Worker checks D1 for an existing saved mapping for that Jira issue.
9. The Worker upserts the matching Notion page:
   - update the existing page if a page id is already known
   - otherwise look up a page by `Issue Key`
   - if no page exists, create one
10. The Worker saves the resulting Notion page id and latest synced status into D1.
11. The Worker returns a JSON response describing what it processed.

## Notion to Jira flow

1. Notion sends a webhook request to `/webhook/notion`.
2. The Worker checks the shared secret.
3. The Worker parses the JSON payload.
4. The Worker extracts the event type and page id.
5. Comment events are ignored.
6. The Worker fetches the live Notion page from the Notion API.
7. The Worker reads the writable Jira-backed fields from the page.
8. The Worker fetches the live Jira issue and compares the current Jira values against the current Notion values.
9. If the Notion status differs, the Worker applies a matching Jira transition when available.
10. If any writable Jira fields differ, the Worker updates those Jira issue fields directly.
11. After Jira changes are applied, the Worker refetches the Jira issue and updates the Notion page so Jira-owned fields like `Updated` stay correct.
12. The Worker saves the page id, latest Notion event time, and synced status back into D1.
13. The Worker returns a JSON response describing what it processed.

## Notion properties currently written
- `Name`
- `Issue Key`
- `Status`
- `Priority`
- `Assignee`
- `Updated`
- `Description`
- `Reporter`
- `Labels`
- `Due date`
- `Start date`
- `Original estimate`
- `Time Spent`
- `Time Remaining`
- `Project Key`
- `Project Name`
- `Epic Key`
- `Epic Name`
- `Jira URL`

## Files involved
- `src/index.js`
  - request handling
  - webhook auth
  - Jira and Notion event filtering
- `src/jira.js`
  - Jira API request
  - Jira issue mapping
  - Jira status transition lookup/apply
- `src/notion.js`
  - Notion page lookup
  - Notion page create/update
  - Notion page property reads
- `src/db.js`
  - D1 lookup and save for issue sync state/timestamps

## Design constraints
- The code is intentionally narrow.
- Jira -> Notion sync covers issue fields only.
- Notion -> Jira sync is limited to a small set of explicitly writable issue fields.
- `Updated` remains Jira-owned.
- `Time Spent` and `Time Remaining` remain Jira-owned until a separate worklog write path is added.
- Comment sync stays out of scope.
- Additional fields and webhook types should be added only after these two status paths are confirmed stable.
