# Jira and Notion Issue Sync Flow

This document describes the current lean issue-sync code paths in the rebuilt Worker.

## Current scope
- `POST /webhook/jira` is active
- `POST /webhook/notion` is active
- Jira `jira:issue_updated`, `comment_*`, and `worklog_*` events update the matching Notion page fields
- Notion page events can trigger Jira status transitions and direct Jira field updates
- Jira comments are mirrored into Notion page content
- Notion can create Jira comments through a button-stamped submit property
- Notion comments are still ignored

## Jira to Notion flow

1. Jira sends a webhook request to `/webhook/jira`.
2. The Worker checks the shared secret.
3. The Worker parses the JSON payload.
4. The Worker reads the Jira event metadata:
   - event type
   - issue key
   - project key
5. If the event is not one of the supported Jira issue-refresh events, the Worker ignores it.
6. If the event is `jira:issue_updated`, `comment_*`, or a supported `worklog_*` event, the Worker fetches the live Jira issue from the Jira REST API.
7. The Jira issue response is converted into a small plain issue record used by the Notion sync code.
   - If `JIRA_START_DATE_FIELD_ID`, `JIRA_SPRINT_FIELD_ID`, or `JIRA_PULL_REQUEST_LINK_FIELD_ID` are not configured, the Worker auto-discovers Jira fields named `Start date`, `Sprint`, and `Pull Request Link` before reading those values.
8. The Worker checks D1 for an existing saved mapping for that Jira issue.
9. The Worker upserts the matching Notion page:
   - update the existing page if a page id is already known
   - otherwise look up a page by `Issue Key`
   - if no page exists, create one
10. On Jira comment events, or when the page is created for the first time, the Worker fetches all Jira comments for the issue.
11. The Worker acquires a per-issue comment-sync lock when that D1 migration is available, so overlapping Jira comment events serialize cleanly.
12. The Worker replaces one managed `Jira Comments` callout block on the Notion page with the freshly fetched comments.
13. The Worker saves the resulting Notion page id and latest synced status into D1.
14. The Worker returns a JSON response describing what it processed.

## Notion to Jira flow

1. Notion sends a webhook request to `/webhook/notion`.
2. The Worker checks the shared secret.
3. The Worker parses the JSON payload.
4. The Worker extracts the event type and page id.
5. Comment events and `page.content_updated` events are ignored.
6. The Worker fetches the live Notion page from the Notion API.
7. When the Notion issue-sync lock migration is available, the Worker serializes Notion -> Jira sync per issue so overlapping webhooks do not race.
8. The Worker reads the writable Jira-backed fields from the latest fetched page and builds a live-page fingerprint.
9. If that fingerprint matches the last successfully processed fingerprint for the same issue, the Worker skips the duplicate page state.
10. Otherwise, the Worker fetches the live Jira issue and compares the current Jira values against the current Notion values.
11. If the Notion status differs, the Worker applies a matching Jira transition when available.
12. If any writable Jira fields differ, the Worker updates those Jira issue fields directly.
13. After Jira field or status changes are applied, the Worker refetches the Jira issue and updates the Notion page so Jira-owned fields like the read-only `updated` display stay correct.
14. The Worker saves the page id, latest Notion event time, synced status, and processed fingerprint back into D1.
15. The Worker returns a JSON response describing what it processed.

## Notion comment-draft flow

1. A Notion button updates a hidden timestamp property like `Comment Submit At`.
2. The button also copies the visible `Comment Draft` into a hidden `Comment Queue` property before clearing the visible draft, but only when the queue is currently empty.
3. That property change produces the usual Notion `page.properties_updated` webhook.
4. The Worker fetches the page and reads `Issue Key`, `Comment Queue`, and `Comment Submit At`.
5. If `Comment Queue` has text and `Comment Submit At` is set, the Worker creates a Jira comment through Jira's comment API.
6. The Worker clears `Comment Queue` and `Comment Submit At` in Notion, and stamps `Last Comment Sent At` when that property exists.
7. The Worker refetches the Jira issue, upserts the Notion page, and refreshes the mirrored `Jira Comments` callout.

## Notion work-log flow

1. A Notion button copies visible `Work Log Time` and `Work Log Description` values into hidden queue properties, but only when the work-log queue is currently empty.
2. The button also stamps `Work Log Submit At` and clears the visible work-log input fields.
3. That property change produces the usual Notion `page.properties_updated` webhook.
4. The Worker fetches the page and reads `Issue Key`, `Work Log Queue Time`, `Work Log Queue Description`, and `Work Log Submit At`.
5. If `Work Log Queue Time` has text and `Work Log Submit At` is set, the Worker creates a Jira worklog entry.
6. The Worker clears the queued work-log fields in Notion, and stamps `Last Work Logged At` when that property exists.
7. The Worker refetches the Jira issue, upserts the Notion page, and refreshes Jira-owned fields like `Time Spent` and `Time Remaining`.

## Notion properties currently written
- `Name`
- `Issue Key`
- `Jira Read Only Props`
- `Status`
- `Priority`
- `Assignee`
- `Description`
- `Reporter`
- `Labels`
- `Due date`
- `Start date`
- `Original estimate`
- `Pull Requests`
- `Time Spent`
- `Time Remaining`
- `Project Key`
- `Project Name`
- `Epic Key`
- `Epic Name`
- `Jira URL`

## Jira Read Only Props format
- The hidden `Jira Read Only Props` field is written as newline-separated `key::value` pairs.
- Current keys:
  - `updated`
  - `time_spent`
  - `time_remaining`
  - `jira_url`
  - `issue_key`
  - `reporter`
  - `due_date`
  - `project_key`
  - `project_name`
  - `epic_key`
  - `epic_name`
  - `sprint`
  - `requested_by`
  - `date_requested`

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
  - managed Jira comments section block sync
- `src/db.js`
  - D1 lookup and save for issue sync state/timestamps
  - D1 save/load for the managed Jira comments section block ids

## Design constraints
- The code is intentionally narrow.
- Jira -> Notion sync covers issue fields plus a mirrored Jira comments callout block.
- Notion -> Jira sync is limited to a small set of explicitly writable issue fields.
- `Pull Requests` and `Start date` can sync in both directions.
- Comment creation from Notion is opt-in and handled through `Comment Draft`, `Comment Queue`, and a button-managed `Comment Submit At` property.
- The recommended Notion UX uses a visible `Comment Status` formula plus an optional `Last Comment Sent At` property for feedback while a queued comment is pending or has just been sent.
- Jira worklog creation from Notion is opt-in and handled through visible work-log inputs, queued hidden work-log properties, and a button-managed `Work Log Submit At` property.
- `updated` remains Jira-owned and is exposed through `Jira Read Only Props` rather than a raw editable property.
- `Time Spent` and `Time Remaining` remain Jira-owned fields; Notion now adds new Jira worklog entries instead of editing those totals directly.
- Native Notion comment sync stays out of scope.
- Notion `page.content_updated` events are ignored because mirrored Jira comments live in page content and should not trigger Jira writes.
- Notion -> Jira dedupe and serialization rely on the `notion_issue_sync_locks` and `notion_issue_sync_fingerprints` migrations when available.
- Additional fields and webhook types should be added only after these two status paths are confirmed stable.
