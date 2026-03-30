# Jira To Notion Sync

Clean baseline Worker rebuild.

## Current scope
- Jira -> Notion issue create/update sync for issue fields
- Jira -> Notion mirrored Jira comments section
- Notion -> Jira sync for status and a small writable field set
- Notion -> Jira comment creation through `Comment Draft`, `Comment Queue`, and a Notion button
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
- Notion can create a new Jira comment on Notion's free plan through the normal `/webhook/notion` endpoint.
- The intended Notion UX is:
  - a rich-text `Comment Draft` property for the text
  - a hidden rich-text `Comment Queue` property that temporarily holds the submitted text
  - a hidden timestamp property like `Comment Submit At`
  - an optional date property like `Last Comment Sent At` for visual confirmation after Jira accepts the comment
  - a button property like `Send to Jira` that only fills the queue when the queue is empty, then sets `Comment Submit At` and clears `Comment Draft`
- When the normal Notion integration webhook arrives, the Worker sees `Comment Queue` plus `Comment Submit At`, creates the Jira comment, clears both queue fields, and refreshes the mirrored `Jira Comments` callout.
- The Worker deletes and recreates that single container on Jira comment webhooks instead of diffing individual comment blocks.
- Notion native comments are still out of scope.
- This mirrored comments section relies on the existing `jira_comment_sections` D1 table from the checked-in migrations.
- When the `jira_comment_sync_locks` migration is applied, Jira comment refreshes are serialized per issue to avoid duplicate callouts during back-to-back webhook deliveries.
- When the `notion_issue_sync_locks` and `notion_issue_sync_fingerprints` tables are present, Notion -> Jira sync is serialized per issue and duplicate live-page states are skipped.
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

## Notion comment-draft setup
1. Add a rich-text property named `Comment Draft`.
2. Add a rich-text property named `Comment Queue`.
3. Add a date property named `Comment Submit At`.
4. Optional but recommended: add a date property named `Last Comment Sent At`.
5. Optional but recommended: add a formula property named `Comment Status`.
6. Use this formula for `Comment Status`:
   - `if(!empty(prop("Comment Queue")), "Pending Jira sync", if(!empty(prop("Comment Draft")), "Ready to send", if(!empty(prop("Last Comment Sent At")), "Sent to Jira", "Idle")))`
7. Add a button property named `Send to Jira`.
8. In the button settings, define two variables if your Notion button editor supports them:
   - `can_submit` = `empty(prop("Comment Queue")) and !empty(prop("Comment Draft"))`
   - `draft_to_send` = `prop("Comment Draft")`
9. Configure the button actions in this order:
   - set `Comment Queue` to `if(can_submit, draft_to_send, prop("Comment Queue"))`
   - set `Comment Submit At` to `if(can_submit, now(), prop("Comment Submit At"))`
   - set `Comment Draft` to `if(can_submit, "", prop("Comment Draft"))`
10. Hide `Comment Queue` and `Comment Submit At` from your main views.
11. Keep using the normal integration webhook for `/webhook/notion` as before for field sync.

This works on Notion's free personal plan, but comment sends will still follow Notion's normal aggregated webhook timing for page property updates.

## Archived code
Previous experimental implementation was archived under:
`archive/2026-03-26-pre-reset/`
