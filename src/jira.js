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
  };
}

/**
 * Sends a GET request to Jira and returns the parsed JSON body.
 */
async function jiraRequest(env, path) {
  const baseUrl = env.JIRA_BASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, { headers: jiraHeaders(env) });

  if (!response.ok) {
    throw new Error(`Jira request failed (${response.status}): ${await response.text()}`);
  }

  return response.json();
}

/**
 * Fetches the minimum Jira issue fields needed for the current sync path.
 */
export async function fetchJiraIssue(env, issueKey) {
  const fields = ['summary', 'status', 'project'];
  return jiraRequest(
    env,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields.join(','))}`
  );
}

/**
 * Converts the Jira issue payload into the small plain object that the
 * Notion sync code expects.
 */
export function toIssueRecord(env, issue) {
  const fields = issue.fields || {};
  const project = fields.project || {};

  return {
    issueKey: issue.key || '',
    name: fields.summary || '',
    status: (fields.status || {}).name || '',
    projectKey: project.key || '',
    projectName: project.name || '',
    jiraUrl: `${String(env.JIRA_BASE_URL || '').replace(/\/+$/, '')}/browse/${issue.key || ''}`,
  };
}
