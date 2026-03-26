# Jira Admin Webhook Setup

This guide is for a Jira admin who needs to create or update the Jira webhook used by the Jira-to-Notion sync.

## Purpose

This webhook sends Jira changes to the Cloudflare Worker so Jira issues can stay in sync with Notion.

## Webhook URL

Use this URL:

```text
https://jira-to-notion-sync.awesomebunny.workers.dev/webhook/jira?secret=<SECRET_VALUE>
```

Replace `<SECRET_VALUE>` with the actual shared secret value.

## Steps

1. Open Jira in your browser.
2. Click the gear icon in the top-right corner.
3. Open `Jira settings`.
4. In the left menu, open `System`.
5. Find and open `Webhooks`.
6. If a webhook named `Jira Notion Sync` already exists, open it to edit it.
7. If it does not exist, create a new webhook.
8. Set the webhook name to:

```text
Jira Notion Sync
```

9. Set the webhook URL to the URL shown above.
10. Make the webhook apply to all issues.
11. If Jira shows an `All issues` option, select it.
12. If Jira uses a JQL filter and leaving it blank is allowed, leave it blank.
13. If Jira requires a JQL expression, use:

```text
project IS NOT EMPTY
```

14. Make sure `Exclude body` is **unchecked**.
15. Turn on these events:

```text
Issue created
Issue updated
Issue deleted
Comment created
Comment updated
Comment deleted
Attachment created
Attachment deleted
Issue link created
Issue link deleted
Worklog created
Worklog updated
Worklog deleted
```

16. Save the webhook.
17. Let the project owner know once it is saved so they can test it.

## Notes

- This webhook is intentionally broad so the project owner does not need to request Jira admin changes again when the sync expands.
- The secret in the URL is required for security.
- The Cloudflare Worker URL is stable and should not rotate like the old test tunnel URLs.
- `Exclude body` must stay off so Jira includes the issue/comment payload in the webhook request.
