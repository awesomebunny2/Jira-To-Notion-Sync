# Jira To Notion Sync (Cloudflare Workers Rewrite)

This folder is the new JavaScript rewrite target for the Jira <-> Notion sync.

Reference implementation:
- `/Users/mattshark/Scripts/Python/Sync-Jira-To-Notion`

Current status:
- Cloudflare Worker scaffold only
- stable `/health`, `/webhook/jira`, and `/webhook/notion` endpoints
- shared-secret auth compatible with the Python webhook service
- Notion verification token echo support
- D1 schema and webhook event logging scaffold
- debug event viewer endpoint: `/debug/events`
- Jira issue created/updated events now fetch the full Jira issue and upsert a Notion page
- Notion page update events now fetch the page and push `Status` changes back to Jira

Target deployment:
- Cloudflare Workers for the public webhook endpoint
- One Notion database for issues from all Jira projects
- Existing Python repo kept intact as the feature reference during migration

Saved admin guide:
- `/Users/mattshark/Scripts/Jira-To-Notion-Sync/JIRA_ADMIN_WEBHOOK_SETUP.md`

## Required Worker Secrets / Variables

Set these in Cloudflare Worker settings:
- `WEBHOOK_SHARED_SECRET`
- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`

Optional:
- `NOTION_VERSION`
- `NOTION_TO_JIRA_STATUS_MAP`

## Target Data Model

The new Worker project should support syncing issues from all Jira projects into one Notion database.

Minimum identification fields to keep in Notion:
- `Issue Key`
- `Project Key`
- `Project Name`
- `Epic Key`
- `Epic Name`

Notes:
- `Issue Key` is the full Jira issue key such as `PRP-71`.
- `Project Key` is the Jira project identifier such as `PRP`.
- `Project Name` is the human-readable Jira project name.
- `Epic Key` and `Epic Name` should be plain text fields in Notion when available.
- This allows the user to sort and filter one shared Notion database across multiple Jira projects.

## Rewrite Plan

The new JavaScript Worker is not just a transport rewrite. It should expand the sync scope beyond the old `PRP`-centric setup and make cross-project sync a first-class behavior.

Next implementation phases:
1. Define and confirm the Notion property schema for a single shared database:
   - existing issue properties
   - `Project Key`
   - `Project Name`
   - `Epic Key`
   - `Epic Name`
2. Expand Jira -> Notion handling beyond the current issue create/update upsert path.
3. Add Notion -> Jira event handling using `Issue Key` lookups instead of project-specific assumptions.
4. Port comment sync.
5. Port PR field sync.
6. Add support for delete and other future Jira event types that are already enabled in the Jira admin webhook.

## Scope Clarification

The broad Jira webhook should be treated as an event source, not as a promise that every Jira event type is fully implemented on day one.

Implementation priority:
1. `jira:issue_created`
2. `jira:issue_updated`
3. `jira:issue_deleted`
4. `comment_created`
5. `comment_updated`
6. `comment_deleted`

Future-ready events already requested from Jira admin:
1. `attachment_created`
2. `attachment_deleted`
3. `issuelink_created`
4. `issuelink_deleted`
5. `worklog_created`
6. `worklog_updated`
7. `worklog_deleted`

These future-ready events should be accepted safely even before full downstream handling is implemented.

Local commands:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
npm install -D wrangler
npx wrangler dev
npx wrangler deploy
```

## Cloudflare D1 Setup

1. Create the database:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
npx wrangler d1 create jira-to-notion-sync
```

2. Copy the `database_id` from the command output.

3. Open `/Users/mattshark/Scripts/Jira-To-Notion-Sync/wrangler.jsonc` and uncomment the `d1_databases` section.

4. Paste the `database_id` into that section.

5. Apply the first migration:

```bash
npx wrangler d1 migrations apply jira-to-notion-sync
```

6. Re-deploy the Worker:

```bash
npx wrangler deploy
```

7. Confirm D1 is connected:

```bash
curlhb https://jira-to-notion-sync.awesomebunny.workers.dev/health
```

Expected:
- `dbConfigured: true`

## Manual Testing Before Jira Admin Setup

You can test webhook receipt without the Jira admin webhook by posting to the Worker manually.

Example Jira event:

```bash
curlhb -X POST "https://jira-to-notion-sync.awesomebunny.workers.dev/webhook/jira?secret=<YOUR_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookEvent": "jira:issue_updated",
    "issue": {
      "key": "PRP-71",
      "fields": {
        "project": {
          "key": "PRP"
        }
      }
    }
  }'
```

Current expected result:
- the event is recorded in D1
- for `jira:issue_created` and `jira:issue_updated`, the Worker also fetches the Jira issue and creates or updates the matching Notion page
- the Worker stores the Jira issue key -> Notion page ID mapping in D1

Example Notion event:

```bash
curlhb -X POST "https://jira-to-notion-sync.awesomebunny.workers.dev/webhook/notion?secret=<YOUR_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "page.updated",
    "entity": {
      "type": "page",
      "id": "example-page-id"
    }
  }'
```

Current expected result:
- the event is recorded in D1
- if the page contains `Issue Key` and `Status`, the Worker fetches the page and attempts the matching Jira transition
- if the Notion status matches the last Jira-synced status, the Worker skips the transition to avoid a loop

View recorded events:

```bash
curlhb "https://jira-to-notion-sync.awesomebunny.workers.dev/debug/events?secret=<YOUR_SECRET>"
```

Backfill an existing Jira issue into Notion on demand:

```bash
curlhb -X POST "https://jira-to-notion-sync.awesomebunny.workers.dev/debug/backfill/jira?secret=<YOUR_SECRET>&issueKey=PRP-71"
```

Current expected result:
- the Worker fetches the live Jira issue
- the matching Notion page is updated if it already exists
- a new Notion page is created if it does not exist yet
- `Project Key`, `Project Name`, `Epic Key`, and `Epic Name` populate if those properties exist in the Notion database

Backfill the whole Notion database from Jira in batches:

```bash
curlhb -X POST "https://jira-to-notion-sync.awesomebunny.workers.dev/debug/backfill/notion-database?secret=<YOUR_SECRET>&limit=10"
```

Current expected result:
- the Worker processes up to `limit` Notion pages that have an `Issue Key`
- each page is refreshed from the live Jira issue
- the response includes `hasMore` and `nextCursor`
- smaller limits such as `5` or `10` are recommended to avoid Cloudflare subrequest limits during bulk refreshes

If `hasMore` is `true`, call it again with the returned `nextCursor`:

```bash
curlhb -X POST "https://jira-to-notion-sync.awesomebunny.workers.dev/debug/backfill/notion-database?secret=<YOUR_SECRET>&limit=10&cursor=<NEXT_CURSOR>"
```

## Local Backfill Script

Use the local helper script when you want the backfill to repeat automatically until it finishes, while showing progress in the terminal.

Script:

```bash
/Users/mattshark/Scripts/Jira-To-Notion-Sync/scripts/backfill-fields.sh
```

Examples:

Backfill only the new identity fields:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
./scripts/backfill-fields.sh --secret <YOUR_SECRET> --preset identity
```

Backfill specific fields by name:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
./scripts/backfill-fields.sh \
  --secret <YOUR_SECRET> \
  --field "Project Key" \
  --field "Project Name" \
  --field "Epic Key" \
  --field "Epic Name"
```

Backfill all mapped Jira-backed properties:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
./scripts/backfill-fields.sh --secret <YOUR_SECRET>
```

Optional:
- `--limit 10`
  - controls batch size
  - default is `10`
  - reduce it if you hit Worker limits

What the script shows:
- total page count
- current batch number
- progress bar
- processed count out of total
- elapsed time
- ETA
- issue keys updated in the current batch
- failed issue keys and error messages

## Import All Jira Issues

Use this when you want to import Jira issues that do not already exist in Notion.

Script:

```bash
/Users/mattshark/Scripts/Jira-To-Notion-Sync/scripts/import-jira-issues.sh
```

Import all Jira issues visible to the configured Jira API token (default JQL: `project IS NOT EMPTY ORDER BY key ASC`):

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
./scripts/import-jira-issues.sh --secret <YOUR_SECRET>
```

Import with a custom batch size:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
./scripts/import-jira-issues.sh --secret <YOUR_SECRET> --limit 10
```

Import only a Jira subset using JQL:

```bash
cd /Users/mattshark/Scripts/Jira-To-Notion-Sync
./scripts/import-jira-issues.sh --secret <YOUR_SECRET> --jql 'project in (PRP, OPS) ORDER BY key ASC'
```

What the import script does:
- pages through Jira search results
- creates missing Notion pages
- updates existing Notion pages if the `Issue Key` already exists
- writes project and epic identity fields when those Notion properties exist
- repeats automatically until all Jira pages in the selected scope are processed

What the import script shows:
- batch number
- progress bar
- processed count out of Jira's approximate total in the selected scope
- elapsed time
- ETA
- issue keys imported or updated in the current batch
- failed issue keys and error messages
