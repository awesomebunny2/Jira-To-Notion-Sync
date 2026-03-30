# Jira To Notion Sync

Clean baseline Worker rebuild.

## Current scope
- Jira -> Notion issue create/update sync for issue fields
- Jira -> Notion mirrored Jira comments section
- Notion -> Jira sync for status and a small writable field set
- No Notion -> Jira comment sync yet
- Existing webhooks and Notion database preserved

## Jira Events Currently Applied To Notion
- `jira:issue_updated`
- `comment_created`
- `comment_updated`
- `comment_deleted`
- `worklog_created`
- `worklog_updated`
- `worklog_deleted`

## Jira Fields Currently Synced To Notion
- `Name`
- `Issue Key`
- `Jira Read Only Props`
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
- `Pull Requests`
- `Time Spent`
- `Time Remaining`
- `Project Key`
- `Project Name`
- `Epic Key`
- `Epic Name`
- `Jira URL`

## Jira Read Only Props Payload
- `Jira Read Only Props` is a hidden rich-text transport field for Jira-owned values.
- It is written as newline-separated `key::value` pairs.
- `updated` is formatted like `March 26, 2026 at 4:59 PM`.
- `date_requested` is formatted like `March 26, 2026`.
- `due_date` is formatted like `March 26, 2026`.
- The display timezone defaults to `America/New_York` and can be overridden with `READ_ONLY_PROPS_TIMEZONE`.
- `sprint` is included from Jira's Sprint field.
- `JIRA_START_DATE_FIELD_ID` is optional. If it is not set, the Worker auto-discovers the Jira field named `Start date` and uses that.
- `JIRA_SPRINT_FIELD_ID` is optional. If it is not set, the Worker auto-discovers the Jira field named `Sprint` and uses that.
- `JIRA_PULL_REQUEST_LINK_FIELD_ID` is optional. If it is not set, the Worker auto-discovers the Jira field named `Pull Request Link` and uses that.
- `Pull Requests` preserves clickable links in Notion when the synced value contains full `http` or `https` URLs.
- `Pull Requests` writes back into Jira as rich text so Jira custom rich-text fields accept the update cleanly.
- `Pull Requests` preserves paragraph breaks in both directions. Separate entries with a blank line if you want distinct paragraphs in Jira and Notion.
- When the Worker writes `Pull Requests` into Notion, it also keeps one trailing blank line so adding the next PR in the Notion UI is easier.
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
- You can build visible Notion formula fields from this property and then remove old raw Jira-owned columns if you want.

## Current Direction Rules
- Jira is the source of truth for all fields above.
- Jira is also the source of truth for the mirrored `Jira Comments` page section.
- Notion -> Jira currently writes:
  - `Name`
  - `Description`
  - `Status`
  - `Priority`
  - `Labels`
  - `Original estimate`
  - `Pull Requests`
  - `Start date`
- `Updated` stays Jira-owned and is refreshed back into Notion after Jira changes.
- `Time Spent` and `Time Remaining` are still Jira-owned for now.
- Jira comments are mirrored into one managed `Jira Comments` callout block on the page.
- The Worker deletes and recreates that single container on Jira comment webhooks instead of diffing individual comment blocks.
- Notion native comments are still out of scope.
- This mirrored comments section relies on the existing `jira_comment_sections` D1 table from the checked-in migrations.
- When the `jira_comment_sync_locks` migration is applied, Jira comment refreshes are serialized per issue to avoid duplicate callouts during back-to-back webhook deliveries.
- Mirrored Jira comments preserve Jira `@mentions` as readable plain text in Notion.
- Jira webhook logs include Atlassian delivery metadata like `webhookIdentifier` and `retryCount` to help diagnose duplicate deliveries.
- Notion `page.content_updated` events are intentionally ignored because the mirrored Jira comments live in page content and are Jira-owned.

## Commands

Deploy:
```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
npx wrangler deploy
```

Apply D1 migrations if needed:
```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
npx wrangler d1 migrations apply jira-to-notion-sync --remote
```

Tail logs:
```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
npx wrangler tail
```

## Archived code
Previous experimental implementation was archived under:
`archive/2026-03-26-pre-reset/`
