/**
 * Builds the headers needed for Notion API requests.
 */
function notionHeaders(env) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) {
    throw new Error('Missing Notion configuration. Expected NOTION_TOKEN and NOTION_DATABASE_ID.');
  }

  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': env.NOTION_VERSION || '2022-06-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Sends a Notion API request and returns the parsed JSON body.
 */
async function notionRequest(env, path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      ...notionHeaders(env),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Notion request failed (${response.status}): ${await response.text()}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/**
 * Creates a Notion title-property payload.
 */
function title(content) {
  return { title: [{ text: { content: String(content || '').slice(0, 2000) } }] };
}

/**
 * Creates a Notion rich-text property payload.
 */
function richText(content) {
  if (!content) {
    return { rich_text: [] };
  }

  return { rich_text: [{ text: { content: String(content).slice(0, 2000) } }] };
}

/**
 * Creates a Notion select-property payload.
 */
function select(name) {
  return name ? { select: { name } } : { select: null };
}

/**
 * Creates a Notion URL-property payload.
 */
function url(value) {
  return { url: value || null };
}

/**
 * Maps the current Jira issue record into the Notion properties we want to sync.
 */
function buildProperties(issue) {
  return {
    Name: title(issue.name),
    'Issue Key': richText(issue.issueKey),
    Status: select(issue.status),
    'Project Key': richText(issue.projectKey),
    'Project Name': richText(issue.projectName),
    'Jira URL': url(issue.jiraUrl),
  };
}

/**
 * Looks up an existing Notion page by its Jira Issue Key.
 */
async function findPageByIssueKey(env, issueKey) {
  const response = await notionRequest(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      page_size: 1,
      filter: {
        property: 'Issue Key',
        rich_text: { equals: issueKey },
      },
    }),
  });

  return response.results?.[0] || null;
}

/**
 * Updates the existing Notion page for this Jira issue, or creates it if it
 * does not exist yet.
 */
export async function upsertIssuePage(env, issue, knownPageId = null) {
  const pageId = knownPageId || (await findPageByIssueKey(env, issue.issueKey))?.id;
  const properties = buildProperties(issue);

  if (pageId) {
    await notionRequest(env, `/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    return pageId;
  }

  const created = await notionRequest(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });

  return created.id;
}
