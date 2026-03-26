# Jira To Notion Sync

Clean baseline Worker rebuild.

## Current scope
- Jira -> Notion issue create/update sync for issue fields
- Notion -> Jira sync for status and a small writable field set
- No comment sync in either direction
- Existing webhooks and Notion database preserved

## Jira Events Currently Applied To Notion
- `jira:issue_updated`
- `worklog_created`
- `worklog_updated`
- `worklog_deleted`

## Jira Fields Currently Synced To Notion
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
- `Start date` if `JIRA_START_DATE_FIELD_ID` is configured
- `Original estimate`
- `Time Spent`
- `Time Remaining`
- `Project Key`
- `Project Name`
- `Epic Key`
- `Epic Name`
- `Jira URL`

## Current Direction Rules
- Jira is the source of truth for all fields above.
- Notion -> Jira currently writes:
  - `Name`
  - `Description`
  - `Status`
  - `Priority`
  - `Labels`
  - `Original estimate`
  - `Start date` if `JIRA_START_DATE_FIELD_ID` is configured
- `Updated` stays Jira-owned and is refreshed back into Notion after Jira changes.
- `Time Spent` and `Time Remaining` are still Jira-owned for now.
- Comments are still out of scope.

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
