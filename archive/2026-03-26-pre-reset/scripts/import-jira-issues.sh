#!/usr/bin/env bash
set -euo pipefail

WORKER_URL="${WORKER_URL:-https://jira-to-notion-sync.awesomebunny.workers.dev}"
LIMIT="${LIMIT:-10}"
SECRET="${WEBHOOK_SHARED_SECRET:-}"
JQL="${JQL:-}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/import-jira-issues.sh --secret <secret> [--limit 10] [--jql "project = PRP ORDER BY key ASC"]

Examples:
  ./scripts/import-jira-issues.sh --secret abc123
  ./scripts/import-jira-issues.sh --secret abc123 --limit 20
  ./scripts/import-jira-issues.sh --secret abc123 --jql 'project in (PRP,OPS) ORDER BY key ASC'

Notes:
  - Without --jql, the Worker imports all Jira issues visible to the configured Jira API token.
  - The progress total uses Jira's approximate count API.
  - The script loops until there are no more Jira issues to import.
  - Existing Notion pages are updated; missing ones are created.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret)
      SECRET="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-10}"
      shift 2
      ;;
    --jql)
      JQL="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$SECRET" ]]; then
  echo "Missing --secret and WEBHOOK_SHARED_SECRET is not set." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for JSON parsing." >&2
  exit 1
fi

CURL_BIN="${CURL_BIN:-}"
if [[ -z "$CURL_BIN" ]]; then
  if command -v curlhb >/dev/null 2>&1; then
    CURL_BIN="curlhb"
  else
    CURL_BIN="curl"
  fi
fi

urlencode() {
  node -e 'console.log(encodeURIComponent(process.argv[1] || ""))' "$1"
}

START_TS="$(date +%s)"
NEXT_PAGE_TOKEN=""
TOTAL=0
DONE=0
BATCH_NUM=0

echo "Starting Jira import"
echo "Worker: ${WORKER_URL}"
echo "Batch size: ${LIMIT}"
if [[ -n "$JQL" ]]; then
  echo "JQL: ${JQL}"
else
  echo "JQL: all visible issues (project IS NOT EMPTY ORDER BY key ASC)"
fi
echo

while true; do
  BATCH_NUM=$((BATCH_NUM + 1))
  REQUEST_URL="${WORKER_URL}/debug/import/jira?secret=$(urlencode "$SECRET")&limit=$(urlencode "$LIMIT")"
  if [[ -n "$JQL" ]]; then
    REQUEST_URL="${REQUEST_URL}&jql=$(urlencode "$JQL")"
  fi
  if [[ -n "$NEXT_PAGE_TOKEN" ]]; then
    REQUEST_URL="${REQUEST_URL}&nextPageToken=$(urlencode "$NEXT_PAGE_TOKEN")"
  fi

  RESPONSE="$($CURL_BIN -s -X POST "$REQUEST_URL")"

  PARSED_RAW="$(
    node - <<'NODE' "$RESPONSE"
const data = JSON.parse(process.argv[2]);
const imported = Array.isArray(data.imported) ? data.imported : [];
const failed = Array.isArray(data.failed) ? data.failed : [];
const importedKeys = imported.map((item) => item.issueKey).filter(Boolean).join(", ");
const failedKeys = failed.map((item) => `${item.issueKey}: ${item.error}`).join(" | ");
console.log(data.total || 0);
console.log(data.importedCount || 0);
console.log(data.failedCount || 0);
console.log(data.hasMore ? "true" : "false");
console.log(data.nextPageToken ?? "");
console.log(importedKeys);
console.log(failedKeys);
NODE
  )"

  PARSED=()
  while IFS= read -r line; do
    PARSED+=("$line")
  done <<EOF
$PARSED_RAW
EOF

  TOTAL="${PARSED[0]:-0}"
  IMPORTED="${PARSED[1]:-0}"
  FAILED="${PARSED[2]:-0}"
  HAS_MORE="${PARSED[3]:-false}"
  NEXT_PAGE_TOKEN="${PARSED[4]:-}"
  IMPORTED_KEYS="${PARSED[5]:-}"
  FAILED_KEYS="${PARSED[6]:-}"

  DONE=$((DONE + IMPORTED + FAILED))
  if [[ "$DONE" -gt "$TOTAL" ]]; then
    DONE="$TOTAL"
  fi

  ELAPSED=$(( $(date +%s) - START_TS ))
  if [[ "$DONE" -gt 0 && "$TOTAL" -gt 0 ]]; then
    ETA=$(( (ELAPSED * (TOTAL - DONE)) / DONE ))
  else
    ETA=0
  fi

  BAR_WIDTH=30
  if [[ "$TOTAL" -gt 0 ]]; then
    FILLED=$(( DONE * BAR_WIDTH / TOTAL ))
  else
    FILLED=0
  fi
  if [[ "$FILLED" -gt "$BAR_WIDTH" ]]; then
    FILLED="$BAR_WIDTH"
  fi
  EMPTY=$(( BAR_WIDTH - FILLED ))
  BAR="$(printf '%*s' "$FILLED" '' | tr ' ' '#')$(printf '%*s' "$EMPTY" '' | tr ' ' '-')"
  if [[ "$TOTAL" -gt 0 ]]; then
    PERCENT=$(( DONE * 100 / TOTAL ))
  else
    PERCENT=0
  fi

  printf 'Batch %d  [%s] %d%%  %d/%d  elapsed=%ss  eta=%ss
' "$BATCH_NUM" "$BAR" "$PERCENT" "$DONE" "$TOTAL" "$ELAPSED" "$ETA"
  if [[ -n "$IMPORTED_KEYS" ]]; then
    printf 'Imported/updated: %s
' "$IMPORTED_KEYS"
  fi
  if [[ -n "$FAILED_KEYS" ]]; then
    printf 'Failed: %s
' "$FAILED_KEYS"
  fi
  printf '
'

  if [[ "$HAS_MORE" != "true" || -z "$NEXT_PAGE_TOKEN" ]]; then
    break
  fi
done

echo "Import finished."
