# Jira To Notion Sync

Clean baseline Worker rebuild.

## Current scope
- Jira -> Notion issue create/update sync for issue fields
- Jira -> Notion mirrored Jira comments section
- Notion -> Jira sync for status and a small writable field set
- Notion -> Jira comment creation through `Comment Draft`, `Comment Queue`, and a Notion button
- Notion -> Jira worklog creation through queued work-log fields and a Notion button
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
- `updated` still comes from Jira, but it now lives in `Jira Read Only Props` and your formula-backed `Last Updated` field rather than a raw `Updated` property.
- `Time Spent` and `Time Remaining` are still Jira-owned for now.
- Notion can create a new Jira worklog on Notion's free plan through the normal `/webhook/notion` endpoint.
- The intended Notion UX is:
  - a visible `Work Log Time` text property for entries like `20m`, `1h`, or `1h 30m`
  - a visible `Work Log Description` text property for the optional work summary
  - hidden `Work Log Queue Time` and `Work Log Queue Description` properties
  - a hidden timestamp property like `Work Log Submit At`
  - an optional date property like `Last Work Logged At` for visual confirmation after Jira accepts the worklog
  - a button property like `Log Work to Jira` that only fills the worklog queue when it is empty, then sets `Work Log Submit At` and clears the visible inputs
- When the normal Notion integration webhook arrives, the Worker sees `Work Log Queue Time` plus `Work Log Submit At`, creates a Jira worklog entry, clears the queued work-log fields, and refreshes the Jira-owned time-tracking fields in Notion.
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

## Notion work-log setup
1. Add a text property named `Work Log Time`.
2. Add a text property named `Work Log Description`.
3. Add a text property named `Work Log Queue Time`.
4. Add a text property named `Work Log Queue Description`.
5. Add a date property named `Work Log Submit At`.
6. Optional but recommended: add a date property named `Last Work Logged At`.
7. Optional but recommended: add a formula property named `Work Log Status`.
8. Use this formula for `Work Log Status`:
   - `if(!empty(prop("Work Log Queue Time")), "Pending Jira work log", if(!empty(prop("Work Log Time")), "Ready to log", if(!empty(prop("Last Work Logged At")), "Logged to Jira", "Idle")))`
9. Add a button property named `Log Work to Jira`.
10. If your Notion button editor supports variables, define:
   - `can_log_work` = `empty(prop("Work Log Queue Time")) and !empty(prop("Work Log Time"))`
   - `queued_time` = `prop("Work Log Time")`
   - `queued_description` = `prop("Work Log Description")`
11. Configure the button actions in this order:
   - set `Work Log Queue Time` to `if(can_log_work, queued_time, prop("Work Log Queue Time"))`
   - set `Work Log Queue Description` to `if(can_log_work, queued_description, prop("Work Log Queue Description"))`
   - set `Work Log Submit At` to `if(can_log_work, now(), prop("Work Log Submit At"))`
   - set `Work Log Time` to `if(can_log_work, "", prop("Work Log Time"))`
   - set `Work Log Description` to `if(can_log_work, "", prop("Work Log Description"))`
12. If your button editor does not support variables, use the same logic inline with the property names directly.
13. Hide `Work Log Queue Time`, `Work Log Queue Description`, and `Work Log Submit At` from your main views.

This logs additive Jira worklog entries. It does not overwrite the aggregate `Time Spent` total directly.

## Archived code
Previous experimental implementation was archived under:
`archive/2026-03-26-pre-reset/`
