/**
 * Builds the headers needed for Jira REST API requests.
 */
function jiraHeaders(env) {
  if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
    throw new Error('Missing Jira configuration. Expected JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.');
  }

  return {
    Authorization: `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Sends a Jira API request and returns the parsed JSON body.
 */
async function jiraRequest(env, path, options = {}) {
  const baseUrl = env.JIRA_BASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...jiraHeaders(env),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Jira request failed (${response.status}): ${await response.text()}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Cache Jira custom field ids per site so webhook handling does not need to
// rediscover the same field metadata on every request.
const jiraFieldIdCache = new Map();

/**
 * Builds the cache key used for Jira field metadata lookups.
 */
function getJiraFieldCacheKey(env) {
  return String(env.JIRA_BASE_URL || '').trim().toLowerCase();
}

/**
 * Builds the cache key used for one Jira custom field lookup.
 */
function getJiraNamedFieldCacheKey(env, fieldName) {
  return `${getJiraFieldCacheKey(env)}::${String(fieldName || '').trim().toLowerCase()}`;
}

/**
 * Returns the configured Jira field id when present, otherwise reuses the last
 * auto-discovered value for this Jira site and field name.
 */
function getKnownJiraFieldId(env, envKey, fieldName) {
  const configuredFieldId = String(env[envKey] || '').trim();
  if (configuredFieldId) {
    return configuredFieldId;
  }

  return jiraFieldIdCache.get(getJiraNamedFieldCacheKey(env, fieldName)) || '';
}

/**
 * Finds a Jira field by display name once so optional custom fields can sync
 * without requiring a manual custom-field lookup in each environment.
 */
async function resolveJiraFieldId(env, envKey, fieldName) {
  const cachedFieldId = getKnownJiraFieldId(env, envKey, fieldName);
  if (cachedFieldId) {
    return cachedFieldId;
  }

  const fields = await jiraRequest(env, '/rest/api/3/field');
  const match = Array.isArray(fields)
    ? fields.find((field) => String(field?.name || '').trim().toLowerCase() === String(fieldName || '').trim().toLowerCase())
    : null;
  const resolvedFieldId = String(match?.id || '').trim();
  jiraFieldIdCache.set(getJiraNamedFieldCacheKey(env, fieldName), resolvedFieldId);
  return resolvedFieldId;
}

/**
 * Parses a comma-separated Notion-to-Jira status map like:
 * "In Progress=In Development,Done=Closed"
 */
function parseStatusNameMap(raw) {
  const mapping = {};
  for (const pair of String(raw || '').split(',')) {
    const trimmed = pair.trim();
    if (!trimmed || !trimmed.includes('=')) {
      continue;
    }

    const [notionStatus, jiraStatus] = trimmed.split('=', 2).map((value) => value.trim());
    if (notionStatus && jiraStatus) {
      mapping[notionStatus.toLowerCase()] = jiraStatus;
    }
  }

  return mapping;
}

/**
 * Applies the optional env-driven status name override before choosing a Jira transition.
 */
function mapNotionStatusToJira(env, notionStatus) {
  const mapping = parseStatusNameMap(env.NOTION_TO_JIRA_STATUS_MAP);
  return mapping[String(notionStatus || '').trim().toLowerCase()] || String(notionStatus || '').trim();
}

/**
 * Normalizes status-like labels so minor casing and punctuation differences do not
 * block an otherwise valid transition match.
 */
function normalizeStatusName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Converts Jira ADF content into plain text that can fit into Notion text fields.
 */
function adfToText(node) {
  if (!node) {
    return '';
  }

  if (typeof node === 'string') {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map(adfToText).join('');
  }

  if (typeof node !== 'object') {
    return String(node);
  }

  const content = Array.isArray(node.content) ? node.content : [];

  if (node.type === 'doc') {
    return content.map(adfToText).join('\n\n');
  }

  if (node.type === 'text') {
    return node.text || '';
  }

  if (node.type === 'paragraph') {
    return content.map(adfToText).join('');
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  if (node.type === 'mention') {
    return node.attrs?.text || node.attrs?.displayName || '@mention';
  }

  // Jira can serialize URLs inside rich-text custom fields as smart-link card
  // nodes with the URL stored in attrs.url instead of plain text content.
  if (['inlineCard', 'blockCard', 'embedCard'].includes(node.type)) {
    return node.attrs?.url || '';
  }

  return content.map(adfToText).join('');
}

/**
 * Trims long text values so they fit inside Notion rich-text property limits.
 */
function truncate(value, max = 1900) {
  const text = String(value || '').trim();
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 1)}…`;
}

/**
 * Preserves human-readable line breaks while normalizing mixed newline styles.
 */
function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Fetches every Jira comment for one issue using Jira's paginated comment API.
 */
export async function fetchJiraComments(env, issueKey) {
  if (!issueKey) {
    return [];
  }

  const comments = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const result = await jiraRequest(
      env,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${maxResults}`
    );
    const batch = Array.isArray(result?.comments) ? result.comments : [];
    comments.push(...batch);
    const total = Number(result?.total || comments.length);

    if (batch.length === 0 || startAt + batch.length >= total) {
      break;
    }

    startAt += batch.length;
  }

  return comments;
}

/**
 * Converts one Jira comment payload into the small plain object used by the
 * Notion comments mirror.
 */
export function toCommentRecord(comment) {
  return {
    id: String(comment?.id || '').trim(),
    author: String(comment?.author?.displayName || 'Unknown').trim() || 'Unknown',
    created: comment?.created || '',
    updated: comment?.updated || '',
    body: normalizeMultilineText(adfToText(comment?.body)) || '(no text)',
  };
}

/**
 * Formats Jira estimate seconds into a short human-readable label.
 */
function formatEstimateSeconds(seconds) {
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '';
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const weeks = Math.floor(totalMinutes / (5 * 8 * 60));
  const days = Math.floor((totalMinutes % (5 * 8 * 60)) / (8 * 60));
  const hours = Math.floor((totalMinutes % (8 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (weeks > 0) {
    parts.push(`${weeks}w`);
  }
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(' ');
}

/**
 * Picks the best display label for one Jira time-tracking value.
 */
function getTimeTrackingValue(prettyValue, secondsValue) {
  const pretty = String(prettyValue || '').trim();
  if (pretty) {
    return pretty;
  }

  return formatEstimateSeconds(secondsValue);
}

/**
 * Forces values into single-line strings so the read-only props payload stays
 * stable and formula-friendly inside Notion.
 */
function oneLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Formats a timestamp as YYYY-MM-DD for the read-only requested date field.
 */
function getReadOnlyPropsTimeZone(env) {
  return String(env.READ_ONLY_PROPS_TIMEZONE || 'America/New_York').trim() || 'America/New_York';
}

/**
 * Formats a Jira timestamp for the hidden read-only props field.
 */
function formatReadOnlyDateTime(env, value) {
  const iso = normalizeIso(value);
  if (!iso) {
    return '';
  }

  const date = new Date(iso);
  const timeZone = getReadOnlyPropsTimeZone(env);
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  return `${datePart} at ${timePart}`;
}

/**
 * Formats a Jira date-like value for the hidden read-only props field.
 */
function formatReadOnlyDate(env, value) {
  const iso = normalizeIso(value);
  if (!iso) {
    return '';
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: getReadOnlyPropsTimeZone(env),
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

/**
 * Pulls a sprint name out of Jira's sprint field regardless of whether Jira
 * returns structured objects or the older legacy string format.
 */
function getSprintName(rawSprintValue) {
  const value = Array.isArray(rawSprintValue) ? rawSprintValue.at(-1) : rawSprintValue;

  if (!value) {
    return '';
  }

  if (typeof value === 'object') {
    return oneLine(value.name);
  }

  const text = String(value).trim();
  const match = text.match(/name=([^,\]]+)/);
  return match ? oneLine(match[1]) : oneLine(text);
}

/**
 * Normalizes a Jira custom field value that should behave like a single URL.
 */
function getPullRequestLinkValue(rawValue) {
  if (!rawValue) {
    return '';
  }

  if (Array.isArray(rawValue)) {
    return rawValue.map(getPullRequestLinkValue).filter(Boolean).join('\n\n');
  }

  if (typeof rawValue === 'object') {
    // Some Jira custom text fields come back as ADF-style objects instead of
    // plain strings, so prefer text extraction before falling back to simpler
    // URL-like object shapes.
    const richTextValue = normalizeMultilineText(adfToText(rawValue));
    if (richTextValue) {
      return richTextValue;
    }

    return normalizeMultilineText(rawValue.url || rawValue.href || rawValue.value || rawValue.name || '');
  }

  return normalizeMultilineText(rawValue);
}

/**
 * Identifies Jira sprint field payloads across both the modern object shape and
 * Jira's older serialized sprint string.
 */
function isSprintFieldValue(value) {
  if (!value) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(isSprintFieldValue);
  }

  if (typeof value === 'object') {
    return Boolean(value.name) && ['state', 'goal', 'boardId', 'rapidViewId', 'id'].some((key) => value[key] != null);
  }

  const text = String(value).trim();
  return /name=/.test(text) && /(state=|goal=|boardId=|rapidViewId=)/.test(text);
}

/**
 * Pulls the raw sprint field value from the fetched Jira issue, preferring the
 * known field id but falling back to a shape match when needed.
 */
function getRawSprintValue(fields, sprintFieldId) {
  if (sprintFieldId && fields[sprintFieldId] != null) {
    return fields[sprintFieldId];
  }

  return Object.values(fields || {}).find(isSprintFieldValue) || null;
}

/**
 * Serializes Jira-owned values into a single hidden Notion field that formula
 * properties can safely parse without exposing the raw values as editable fields.
 */
function buildJiraReadOnlyProps(issue) {
  const lines = [
    ['updated', issue.updatedDisplay],
    ['time_spent', issue.timeSpent],
    ['time_remaining', issue.timeRemaining],
    ['jira_url', issue.jiraUrl],
    ['issue_key', issue.issueKey],
    ['reporter', issue.reporter],
    ['due_date', issue.dueDateDisplay],
    ['project_key', issue.projectKey],
    ['project_name', issue.projectName],
    ['epic_key', issue.epicKey],
    ['epic_name', issue.epicName],
    ['sprint', issue.sprint],
    ['requested_by', issue.requestedBy],
    ['date_requested', issue.dateRequested],
  ];

  return lines.map(([key, value]) => `${key}::${oneLine(value)}`).join('\n');
}

/**
 * Converts plain text into the minimal Jira ADF document used for description updates.
 */
function textToAdfDoc(text) {
  const normalized = normalizeMultilineText(text);
  const paragraphs = normalized ? normalized.split(/\n{2,}/) : [];

  return {
    type: 'doc',
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : ['']).map((paragraph) => {
      const content = [];
      const parts = paragraph.split(/(https?:\/\/[^\s]+)/g).filter(Boolean);

      for (const part of parts) {
        if (/^https?:\/\//.test(part)) {
          content.push({
            type: 'text',
            text: part,
            marks: [
              {
                type: 'link',
                attrs: { href: part },
              },
            ],
          });
          continue;
        }

        const lines = part.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line) {
            content.push({ type: 'text', text: line });
          }

          if (index < lines.length - 1) {
            content.push({ type: 'hardBreak' });
          }
        }
      }

      return {
        type: 'paragraph',
        content,
      };
    }),
  };
}

/**
 * Normalizes Jira timestamps into ISO strings that Notion date properties accept.
 */
function normalizeIso(value) {
  if (!value) {
    return null;
  }

  try {
    const normalized =
      value.length > 5 && (value.at(-5) === '+' || value.at(-5) === '-')
        ? `${value.slice(0, -2)}:${value.slice(-2)}`
        : value;
    return new Date(normalized).toISOString();
  } catch {
    return null;
  }
}

/**
 * Extracts the Epic identity for issues that are epics themselves or have an epic parent.
 */
function extractEpic(issue) {
  const fields = issue.fields || {};
  const issueTypeName = String((fields.issuetype || {}).name || '').trim().toLowerCase();
  const summary = String(fields.summary || '').trim();

  if (issueTypeName === 'epic') {
    return {
      epicKey: issue.key || '',
      epicName: summary,
    };
  }

  const parent = fields.parent || {};
  const parentFields = parent.fields || {};
  const parentTypeName = String((parentFields.issuetype || {}).name || '').trim().toLowerCase();

  if (parent.key && (parentTypeName === 'epic' || !parentTypeName)) {
    return {
      epicKey: parent.key,
      epicName: String(parentFields.summary || '').trim(),
    };
  }

  return {
    epicKey: '',
    epicName: '',
  };
}

/**
 * Fetches the Jira issue fields currently synced into Notion.
 */
export async function fetchJiraIssue(env, issueKey) {
  const fields = [
    'summary',
    'status',
    'project',
    'priority',
    'assignee',
    'updated',
    'created',
    'reporter',
    'labels',
    'duedate',
    'description',
    'timetracking',
    'timespent',
    'timeestimate',
    'timeoriginalestimate',
    'parent',
    'issuetype',
  ];
  const startDateFieldId = await resolveJiraFieldId(env, 'JIRA_START_DATE_FIELD_ID', 'Start date');
  const sprintFieldId = await resolveJiraFieldId(env, 'JIRA_SPRINT_FIELD_ID', 'Sprint');
  const pullRequestLinkFieldId = await resolveJiraFieldId(env, 'JIRA_PULL_REQUEST_LINK_FIELD_ID', 'Pull Request Link');
  if (startDateFieldId) {
    fields.push(startDateFieldId);
  }
  if (sprintFieldId) {
    fields.push(sprintFieldId);
  }
  if (pullRequestLinkFieldId) {
    fields.push(pullRequestLinkFieldId);
  }

  return jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields.join(','))}`
  );
}

/**
 * Reads the current Jira status name for one issue.
 */
export async function fetchJiraIssueStatus(env, issueKey) {
  const issue = await jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent('status')}`
  );
  return ((issue?.fields || {}).status || {}).name || '';
}

/**
 * Moves a Jira issue to the status requested by Notion when a matching transition exists.
 */
export async function transitionJiraIssue(env, issueKey, notionStatus) {
  const requestedStatus = String(notionStatus || '').trim();
  const mappedStatus = mapNotionStatusToJira(env, requestedStatus);
  const requestedNormalized = normalizeStatusName(requestedStatus);
  const mappedNormalized = normalizeStatusName(mappedStatus);

  if (!issueKey || !requestedStatus) {
    return {
      result: 'unavailable',
      requestedStatus,
      mappedStatus,
      message: 'Missing issue key or target status.',
    };
  }

  const currentStatus = await fetchJiraIssueStatus(env, issueKey);
  if (
    currentStatus &&
    [requestedNormalized, mappedNormalized].some(
      (candidate) => candidate && candidate === normalizeStatusName(currentStatus)
    )
  ) {
    return {
      result: 'already',
      currentStatus,
      requestedStatus,
      mappedStatus,
    };
  }

  const response = await jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
  const transitions = Array.isArray(response?.transitions) ? response.transitions : [];
  const candidates = [requestedStatus];
  const candidateNames = new Set([requestedNormalized]);

  if (mappedStatus && mappedNormalized !== requestedNormalized) {
    candidates.push(mappedStatus);
    candidateNames.add(mappedNormalized);
  }

  const chosen = transitions.find((transition) => {
    const transitionName = normalizeStatusName(transition?.name);
    const targetStatus = normalizeStatusName((transition?.to || {}).name);
    return candidateNames.has(targetStatus) || candidateNames.has(transitionName);
  });

  if (!chosen) {
    return {
      result: 'unavailable',
      currentStatus,
      requestedStatus,
      mappedStatus,
      availableTargets: transitions
        .map((transition) => ({
          name: String(transition?.name || '').trim(),
          to: String((transition?.to || {}).name || '').trim(),
        }))
        .filter((transition) => transition.name || transition.to),
    };
  }

  await jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({
      transition: {
        id: chosen.id,
      },
    }),
  });

  return {
    result: 'applied',
    currentStatus,
    requestedStatus,
    mappedStatus,
    appliedTarget: String((chosen.to || {}).name || '').trim(),
  };
}

/**
 * Updates editable Jira issue fields from a partial fields payload.
 */
export async function updateJiraIssueFields(env, issueKey, fields) {
  if (!issueKey || !fields || Object.keys(fields).length === 0) {
    return false;
  }

  await jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });

  return true;
}

/**
 * Builds the Jira issue edit payload for the fields the Worker currently lets
 * Notion write back into Jira.
 */
export function buildJiraIssueFieldUpdate(env, notionIssue, jiraIssue) {
  const fields = {};
  const changedFields = [];
  const startDateFieldId = getKnownJiraFieldId(env, 'JIRA_START_DATE_FIELD_ID', 'Start date');
  const pullRequestLinkFieldId = getKnownJiraFieldId(env, 'JIRA_PULL_REQUEST_LINK_FIELD_ID', 'Pull Request Link');

  if (typeof notionIssue.name === 'string' && notionIssue.name.trim() && notionIssue.name.trim() !== jiraIssue.name) {
    fields.summary = notionIssue.name.trim();
    changedFields.push('Name');
  }

  if (
    typeof notionIssue.description === 'string' &&
    notionIssue.description.trim() !== String(jiraIssue.description || '').trim()
  ) {
    fields.description = textToAdfDoc(notionIssue.description);
    changedFields.push('Description');
  }

  if (
    typeof notionIssue.priority === 'string' &&
    notionIssue.priority.trim() &&
    notionIssue.priority.trim().toLowerCase() !== String(jiraIssue.priority || '').trim().toLowerCase()
  ) {
    fields.priority = { name: notionIssue.priority.trim() };
    changedFields.push('Priority');
  }

  if (Array.isArray(notionIssue.labels)) {
    const notionLabels = notionIssue.labels.map((label) => label.trim()).filter(Boolean).sort();
    const jiraLabels = String(jiraIssue.labels || '')
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
      .sort();

    if (JSON.stringify(notionLabels) !== JSON.stringify(jiraLabels)) {
      fields.labels = notionLabels;
      changedFields.push('Labels');
    }
  }

  if (
    typeof notionIssue.originalEstimate === 'string' &&
    notionIssue.originalEstimate.trim() &&
    notionIssue.originalEstimate.trim().toLowerCase() !== String(jiraIssue.originalEstimate || '').trim().toLowerCase()
  ) {
    fields.timetracking = {
      ...(fields.timetracking || {}),
      originalEstimate: notionIssue.originalEstimate.trim(),
    };
    changedFields.push('Original estimate');
  }

  if (
    pullRequestLinkFieldId &&
    typeof notionIssue.pullRequests === 'string' &&
    notionIssue.pullRequests.trim() !== String(jiraIssue.pullRequests || '').trim()
  ) {
    // Jira returns this custom field as rich text, so writes need to use the
    // same ADF shape instead of a plain string.
    fields[pullRequestLinkFieldId] = notionIssue.pullRequests.trim()
      ? textToAdfDoc(notionIssue.pullRequests)
      : null;
    changedFields.push('Pull Requests');
  }

  if (startDateFieldId && notionIssue.startDate !== undefined && notionIssue.startDate !== jiraIssue.startDate) {
    fields[startDateFieldId] = notionIssue.startDate || null;
    changedFields.push('Start date');
  }

  return {
    fields,
    changedFields,
  };
}

/**
 * Converts the Jira issue payload into the small plain object that the
 * Notion sync code expects.
 */
export function toIssueRecord(env, issue) {
  const fields = issue.fields || {};
  const project = fields.project || {};
  const epic = extractEpic(issue);
  const timetracking = fields.timetracking || {};
  const startDateFieldId = getKnownJiraFieldId(env, 'JIRA_START_DATE_FIELD_ID', 'Start date');
  const sprintFieldId = getKnownJiraFieldId(env, 'JIRA_SPRINT_FIELD_ID', 'Sprint');
  const pullRequestLinkFieldId = getKnownJiraFieldId(env, 'JIRA_PULL_REQUEST_LINK_FIELD_ID', 'Pull Request Link');
  const originalEstimate = getTimeTrackingValue(timetracking.originalEstimate, fields.timeoriginalestimate);
  const timeSpent = getTimeTrackingValue(timetracking.timeSpent, fields.timespent);
  const timeRemaining = getTimeTrackingValue(timetracking.remainingEstimate, fields.timeestimate);
  const issueRecord = {
    issueKey: issue.key || '',
    name: fields.summary || '',
    status: (fields.status || {}).name || '',
    priority: (fields.priority || {}).name || '',
    assignee: (fields.assignee || {}).displayName || '',
    updated: normalizeIso(fields.updated),
    updatedDisplay: formatReadOnlyDateTime(env, fields.updated),
    description: truncate(adfToText(fields.description)),
    reporter: (fields.reporter || {}).displayName || '',
    requestedBy: (fields.reporter || {}).displayName || '',
    dateRequested: formatReadOnlyDate(env, fields.created),
    labels: Array.isArray(fields.labels) ? fields.labels.join(', ') : '',
    dueDate: fields.duedate || null,
    dueDateDisplay: formatReadOnlyDate(env, fields.duedate),
    startDate: startDateFieldId ? fields[startDateFieldId] || null : null,
    originalEstimate,
    pullRequests: pullRequestLinkFieldId ? getPullRequestLinkValue(fields[pullRequestLinkFieldId]) : '',
    timeSpent,
    timeRemaining,
    projectKey: project.key || '',
    projectName: project.name || '',
    epicKey: epic.epicKey,
    epicName: epic.epicName,
    sprint: getSprintName(getRawSprintValue(fields, sprintFieldId)),
    jiraUrl: `${String(env.JIRA_BASE_URL || '').replace(/\/+$/, '')}/browse/${issue.key || ''}`,
  };

  issueRecord.jiraReadOnlyProps = buildJiraReadOnlyProps(issueRecord);
  return issueRecord;
}
