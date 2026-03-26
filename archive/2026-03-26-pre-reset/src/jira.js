function jiraAuthHeader(env) {
  const raw = `${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`;
  return `Basic ${btoa(raw)}`;
}

function jiraHeaders(env) {
  return {
    Authorization: jiraAuthHeader(env),
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function parseStatusNameMap(raw) {
  const mapping = {};
  if (!raw) {
    return mapping;
  }

  for (const pair of String(raw).split(",")) {
    const trimmed = pair.trim();
    if (!trimmed || !trimmed.includes("=")) {
      continue;
    }

    const [notionStatus, jiraStatus] = trimmed.split("=", 2).map((part) => part.trim());
    if (notionStatus && jiraStatus) {
      mapping[notionStatus.toLowerCase()] = jiraStatus;
    }
  }

  return mapping;
}

function mapNotionStatusToJira(env, notionStatus) {
  const mapping = parseStatusNameMap(env.NOTION_TO_JIRA_STATUS_MAP || "");
  return mapping[(notionStatus || "").toLowerCase()] || notionStatus || "";
}

async function jiraRequest(env, path, options = {}) {
  const baseUrl = (env.JIRA_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("Missing JIRA_BASE_URL secret/variable.");
  }

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
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

function adfToText(node) {
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(adfToText).join("");
  }
  if (typeof node !== "object") {
    return String(node);
  }

  const type = node.type;
  const content = node.content || [];

  if (type === "text") {
    return node.text || "";
  }

  if (type === "paragraph") {
    return `${content.map(adfToText).join("")}\n`;
  }

  if (type === "hardBreak") {
    return "\n";
  }

  if (type === "bulletList" || type === "orderedList") {
    return content.map(adfToText).join("");
  }

  if (type === "listItem") {
    return content.map(adfToText).join("");
  }

  return content.map(adfToText).join("");
}

function truncate(value, max = 1900) {
  const text = value || "";
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function normalizeIso(isoString) {
  if (!isoString) {
    return null;
  }

  try {
    const normalized =
      isoString.length > 5 && (isoString.at(-5) === "+" || isoString.at(-5) === "-")
        ? `${isoString.slice(0, -2)}:${isoString.slice(-2)}`
        : isoString;
    return new Date(normalized).toISOString();
  } catch {
    return null;
  }
}

function extractEpic(issue) {
  const fields = issue.fields || {};
  const issueTypeName = (fields.issuetype || {}).name || "";
  const summary = fields.summary || "";

  if (issueTypeName.toLowerCase() === "epic") {
    return {
      epicKey: issue.key || "",
      epicName: summary,
    };
  }

  const parent = fields.parent || {};
  const parentFields = parent.fields || {};
  const parentTypeName = ((parentFields.issuetype || {}).name || "").toLowerCase();
  if (parent.key && (parentTypeName === "epic" || parentTypeName === "")) {
    return {
      epicKey: parent.key,
      epicName: parentFields.summary || "",
    };
  }

  return {
    epicKey: "",
    epicName: "",
  };
}

export async function fetchJiraComments(env, issueKey) {
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

export async function fetchJiraComment(env, issueKey, commentId) {
  if (!issueKey || !commentId) {
    return null;
  }

  return jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`
  );
}

export function jiraCommentToPlain(comment) {
  return {
    id: String(comment?.id || "").trim(),
    author: ((comment?.author || {}).displayName || "Unknown").trim() || "Unknown",
    created: comment?.created || "",
    updated: comment?.updated || "",
    body: (adfToText(comment?.body) || "").trim(),
  };
}

function textToAdfDoc(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  const paragraphs = normalized ? normalized.split(/\n{2,}/) : [];

  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : [""]).map((paragraph) => ({
      type: "paragraph",
      content: paragraph
        ? [{ type: "text", text: paragraph }]
        : [],
    })),
  };
}

export async function addJiraComment(env, issueKey, text) {
  const clean = String(text || "").trim();
  if (!clean) {
    return null;
  }

  return jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: textToAdfDoc(clean),
    }),
  });
}

export async function updateJiraComment(env, issueKey, commentId, text) {
  const clean = String(text || "").trim();
  if (!clean || !commentId) {
    return null;
  }

  return jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
    method: "PUT",
    body: JSON.stringify({
      body: textToAdfDoc(clean),
    }),
  });
}

export async function deleteJiraComment(env, issueKey, commentId) {
  if (!commentId) {
    return null;
  }

  return jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
    method: "DELETE",
  });
}

export async function fetchJiraIssue(env, issueKey) {
  const fields = [
    "summary",
    "project",
    "status",
    "priority",
    "assignee",
    "updated",
    "reporter",
    "labels",
    "duedate",
    "description",
    "parent",
    "issuetype",
  ];

  return jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields.join(","))}`
  );
}

function normalizeSearchJql(jql) {
  return (jql || "").trim() || "project IS NOT EMPTY ORDER BY key ASC";
}

export async function countJiraIssues(env, { jql = "" } = {}) {
  const result = await jiraRequest(env, "/rest/api/3/search/approximate-count", {
    method: "POST",
    body: JSON.stringify({
      jql: normalizeSearchJql(jql),
    }),
  });

  return Number(result?.count || 0);
}

export async function searchJiraIssues(env, { nextPageToken = "", maxResults = 25, jql = "" } = {}) {
  const fields = [
    "summary",
    "project",
    "status",
    "priority",
    "assignee",
    "updated",
    "reporter",
    "labels",
    "duedate",
    "description",
    "parent",
    "issuetype",
  ];

  const body = {
    jql: normalizeSearchJql(jql),
    maxResults: Math.max(1, Math.min(100, Number(maxResults) || 25)),
    fields,
  };

  if ((nextPageToken || "").trim()) {
    body.nextPageToken = nextPageToken.trim();
  }

  const result = await jiraRequest(env, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    issues: Array.isArray(result?.issues) ? result.issues : [],
    nextPageToken: (result?.nextPageToken || "").trim() || null,
    isLast: Boolean(result?.isLast),
  };
}

export async function fetchJiraIssueStatus(env, issueKey) {
  const issue = await jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent("status")}`
  );
  return ((issue.fields || {}).status || {}).name || "";
}

export async function transitionJiraIssue(env, issueKey, notionStatus) {
  const requestedStatus = (notionStatus || "").trim();
  const mappedStatus = mapNotionStatusToJira(env, requestedStatus).trim();

  if (!requestedStatus && !mappedStatus) {
    return {
      result: "unavailable",
      message: "No target status provided.",
    };
  }

  const currentStatus = await fetchJiraIssueStatus(env, issueKey);
  if (
    (requestedStatus && currentStatus.toLowerCase() === requestedStatus.toLowerCase()) ||
    (mappedStatus && currentStatus.toLowerCase() === mappedStatus.toLowerCase())
  ) {
    return {
      result: "already",
      currentStatus,
      mappedStatus,
    };
  }

  const transitionsResponse = await jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
  );
  const transitions = transitionsResponse.transitions || [];
  const candidates = [];
  if (requestedStatus) {
    candidates.push(requestedStatus);
  }
  if (mappedStatus && mappedStatus.toLowerCase() !== requestedStatus.toLowerCase()) {
    candidates.push(mappedStatus);
  }

  let chosenTransition = null;
  for (const transition of transitions) {
    const targetName = ((transition.to || {}).name || "").trim();
    if (candidates.some((candidate) => candidate.toLowerCase() === targetName.toLowerCase())) {
      chosenTransition = transition;
      break;
    }
  }

  if (!chosenTransition) {
    return {
      result: "unavailable",
      currentStatus,
      mappedStatus,
      availableTargets: transitions
        .map((transition) => ((transition.to || {}).name || "").trim())
        .filter(Boolean),
    };
  }

  await jiraRequest(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    body: JSON.stringify({
      transition: {
        id: chosenTransition.id,
      },
    }),
  });

  return {
    result: "applied",
    currentStatus,
    mappedStatus,
    appliedTarget: ((chosenTransition.to || {}).name || "").trim(),
  };
}

export function jiraIssueToRow(env, issue) {
  const fields = issue.fields || {};
  const project = fields.project || {};
  const epic = extractEpic(issue);
  const baseUrl = (env.JIRA_BASE_URL || "").replace(/\/+$/, "");

  return {
    key: issue.key || "",
    name: fields.summary || "",
    status: (fields.status || {}).name || "",
    priority: (fields.priority || {}).name || "",
    assignee: ((fields.assignee || {}).displayName || ""),
    updated: normalizeIso(fields.updated),
    jira_url: issue.key ? `${baseUrl}/browse/${issue.key}` : "",
    Description: truncate(adfToText(fields.description).trim(), 1900),
    Reporter: ((fields.reporter || {}).displayName || ""),
    Labels: Array.isArray(fields.labels) ? fields.labels.join(", ") : "",
    "Due date": fields.duedate || null,
    "Project Key": project.key || "",
    "Project Name": project.name || "",
    "Epic Key": epic.epicKey || "",
    "Epic Name": epic.epicName || "",
  };
}
