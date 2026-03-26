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

  if (node.type === 'text') {
    return node.text || '';
  }

  if (node.type === 'paragraph') {
    return `${content.map(adfToText).join('')}\n`;
  }

  if (node.type === 'hardBreak') {
    return '\n';
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
 * Converts the Jira issue payload into the small plain object that the
 * Notion sync code expects.
 */
export function toIssueRecord(env, issue) {
  const fields = issue.fields || {};
  const project = fields.project || {};
  const epic = extractEpic(issue);
  const timetracking = fields.timetracking || {};
  const originalEstimate = getTimeTrackingValue(timetracking.originalEstimate, fields.timeoriginalestimate);
  const timeSpent = getTimeTrackingValue(timetracking.timeSpent, fields.timespent);
  const timeRemaining = getTimeTrackingValue(timetracking.remainingEstimate, fields.timeestimate);

  return {
    issueKey: issue.key || '',
    name: fields.summary || '',
    status: (fields.status || {}).name || '',
    priority: (fields.priority || {}).name || '',
    assignee: (fields.assignee || {}).displayName || '',
    updated: normalizeIso(fields.updated),
    description: truncate(adfToText(fields.description)),
    reporter: (fields.reporter || {}).displayName || '',
    labels: Array.isArray(fields.labels) ? fields.labels.join(', ') : '',
    dueDate: fields.duedate || null,
    originalEstimate,
    timeSpent,
    timeRemaining,
    projectKey: project.key || '',
    projectName: project.name || '',
    epicKey: epic.epicKey,
    epicName: epic.epicName,
    jiraUrl: `${String(env.JIRA_BASE_URL || '').replace(/\/+$/, '')}/browse/${issue.key || ''}`,
  };
}
