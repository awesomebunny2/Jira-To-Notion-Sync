#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_URL="${WORKER_URL:-https://jira-to-notion-sync.awesomebunny.workers.dev}"
LIMIT="${LIMIT:-10}"
SECRET="${WEBHOOK_SHARED_SECRET:-}"
FIELDS=()

usage() {
  cat <<'EOF'
Usage:
  ./scripts/backfill-fields.sh --secret <secret> [--field "<Property Name>"]... [--limit 10]
  ./scripts/backfill-fields.sh --secret <secret> --preset identity [--limit 10]

Examples:
  ./scripts/backfill-fields.sh --secret abc123 --preset identity
  ./scripts/backfill-fields.sh --secret abc123 --field "Project Key" --field "Project Name" --field "Epic Key" --field "Epic Name"

Notes:
  - The script loops until the entire Notion database is processed.
  - It shows progress, ETA, batch details, and failed issue keys.
  - If no fields are provided, the Worker refreshes all mapped Jira-backed properties.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret)
      SECRET="${2:-}"
      shift 2
      ;;
    --field)
      FIELDS+=("${2:-}")
      shift 2
      ;;
    --preset)
      case "${2:-}" in
        identity)
          FIELDS=("Project Key" "Project Name" "Epic Key" "Epic Name")
          ;;
        *)
          echo "Unknown preset: ${2:-}" >&2
          exit 1
          ;;
      esac
      shift 2
      ;;
    --limit)
      LIMIT="${2:-10}"
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

TOTAL_JSON="$($CURL_BIN -s "${WORKER_URL}/debug/notion-issue-count?secret=$(urlencode "$SECRET")")"
TOTAL_COUNT="$(node -e 'const data = JSON.parse(process.argv[1]); console.log(data.count || 0);' "$TOTAL_JSON")"

if [[ "$TOTAL_COUNT" -eq 0 ]]; then
  echo "No Notion pages with Issue Key were found."
  exit 0
fi

FIELDS_CSV=""
if [[ ${#FIELDS[@]} -gt 0 ]]; then
  IFS=,
  FIELDS_CSV="${FIELDS[*]}"
  unset IFS
fi

START_TS="$(date +%s)"
CURSOR=""
DONE=0
BATCH_NUM=0

echo "Starting backfill"
echo "Worker: ${WORKER_URL}"
echo "Total pages: ${TOTAL_COUNT}"
echo "Batch size: ${LIMIT}"
if [[ -n "$FIELDS_CSV" ]]; then
  echo "Fields: ${FIELDS_CSV}"
else
  echo "Fields: all mapped Jira-backed properties"
fi
echo

while true; do
  BATCH_NUM=$((BATCH_NUM + 1))
  REQUEST_URL="${WORKER_URL}/debug/backfill/notion-database?secret=$(urlencode "$SECRET")&limit=$(urlencode "$LIMIT")"
  if [[ -n "$CURSOR" ]]; then
    REQUEST_URL="${REQUEST_URL}&cursor=$(urlencode "$CURSOR")"
  fi
  if [[ -n "$FIELDS_CSV" ]]; then
    REQUEST_URL="${REQUEST_URL}&fields=$(urlencode "$FIELDS_CSV")"
  fi

  RESPONSE="$($CURL_BIN -s -X POST "$REQUEST_URL")"

  PARSED_RAW="$(
    node - <<'NODE' "$RESPONSE"
const data = JSON.parse(process.argv[2]);
const refreshed = Array.isArray(data.refreshed) ? data.refreshed : [];
const failed = Array.isArray(data.failed) ? data.failed : [];
const skipped = Array.isArray(data.skipped) ? data.skipped : [];
const refreshedKeys = refreshed.map((item) => item.issueKey).filter(Boolean).join(", ");
const failedKeys = failed.map((item) => `${item.issueKey}: ${item.error}`).join(" | ");
console.log(data.processedCount || 0);
console.log(data.failedCount || 0);
console.log(data.skippedCount || 0);
console.log(data.hasMore ? "true" : "false");
console.log(data.nextCursor || "");
console.log(refreshedKeys);
console.log(failedKeys);
NODE
  )"

  PARSED=()
  while IFS= read -r line; do
    PARSED+=("$line")
  done <<EOF
$PARSED_RAW
EOF

  PROCESSED="${PARSED[0]:-0}"
  FAILED="${PARSED[1]:-0}"
  SKIPPED="${PARSED[2]:-0}"
  HAS_MORE="${PARSED[3]:-false}"
  NEXT_CURSOR="${PARSED[4]:-}"
  REFRESHED_KEYS="${PARSED[5]:-}"
  FAILED_KEYS="${PARSED[6]:-}"

  DONE=$((DONE + PROCESSED + FAILED + SKIPPED))
  if [[ "$DONE" -gt "$TOTAL_COUNT" ]]; then
    DONE="$TOTAL_COUNT"
  fi

  ELAPSED=$(( $(date +%s) - START_TS ))
  if [[ "$DONE" -gt 0 ]]; then
    ETA=$(( (ELAPSED * (TOTAL_COUNT - DONE)) / DONE ))
  else
    ETA=0
  fi

  BAR_WIDTH=30
  FILLED=$(( DONE * BAR_WIDTH / TOTAL_COUNT ))
  if [[ "$FILLED" -gt "$BAR_WIDTH" ]]; then
    FILLED="$BAR_WIDTH"
  fi
  EMPTY=$(( BAR_WIDTH - FILLED ))
  BAR="$(printf '%*s' "$FILLED" '' | tr ' ' '#')$(printf '%*s' "$EMPTY" '' | tr ' ' '-')"
  PERCENT=$(( DONE * 100 / TOTAL_COUNT ))

  printf 'Batch %d  [%s] %d%%  %d/%d  elapsed=%ss  eta=%ss\n' "$BATCH_NUM" "$BAR" "$PERCENT" "$DONE" "$TOTAL_COUNT" "$ELAPSED" "$ETA"
  if [[ -n "$REFRESHED_KEYS" ]]; then
    printf 'Updated: %s\n' "$REFRESHED_KEYS"
  fi
  if [[ -n "$FAILED_KEYS" ]]; then
    printf 'Failed: %s\n' "$FAILED_KEYS"
  fi
  printf '\n'

  if [[ "$HAS_MORE" != "true" || -z "$NEXT_CURSOR" ]]; then
    break
  fi

  CURSOR="$NEXT_CURSOR"
done

echo "Backfill finished."
