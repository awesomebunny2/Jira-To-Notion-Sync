# Jira To Notion Sync

Clean baseline Worker rebuild.

## Current scope
- Jira -> Notion issue create/update sync
- Notion -> Jira status sync
- No comment sync in either direction
- Existing webhooks and Notion database preserved

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
