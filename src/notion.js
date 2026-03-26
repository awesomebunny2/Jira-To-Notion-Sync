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
 * Converts a Notion rich-text array into a plain string.
 */
function richTextToPlain(richText) {
  if (!Array.isArray(richText)) {
    return '';
  }

  return richText
    .map((item) => {
      if (typeof item?.plain_text === 'string') {
        return item.plain_text;
      }
      return item?.text?.content || '';
    })
    .join('')
    .trim();
}

/**
 * Looks up a Notion property name case-insensitively.
 */
function getSchemaKeyByName(schema, wantedNames) {
  const names = Array.isArray(wantedNames) ? wantedNames : [wantedNames];
  const lowered = new Map(Object.keys(schema || {}).map((key) => [key.toLowerCase(), key]));

  for (const wantedName of names) {
    const match = lowered.get(String(wantedName || '').toLowerCase());
    if (match) {
      return match;
    }
  }

  return null;
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
 * Creates a Notion date-property payload.
 */
function date(value) {
  return value ? { date: { start: value } } : { date: null };
}

/**
 * Creates a Notion multi-select-property payload from a comma-separated list.
 */
function multiSelectCsv(value) {
  if (!value) {
    return { multi_select: [] };
  }

  return {
    multi_select: String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((name) => ({ name })),
  };
}

/**
 * Creates a Notion URL-property payload.
 */
function url(value) {
  return { url: value || null };
}

/**
 * Describes the Jira-backed Notion properties supported by the lean sync.
 */
const PROPERTY_DEFINITIONS = [
  { aliases: ['Name'], type: 'title', issueKey: 'name' },
  { aliases: ['Issue Key'], type: 'rich_text', issueKey: 'issueKey' },
  { aliases: ['Status'], type: 'select', issueKey: 'status' },
  { aliases: ['Priority'], type: 'select', issueKey: 'priority' },
  { aliases: ['Assignee'], type: 'rich_text', issueKey: 'assignee' },
  { aliases: ['Updated'], type: 'date', issueKey: 'updated' },
  { aliases: ['Description'], type: 'rich_text', issueKey: 'description' },
  { aliases: ['Reporter'], type: 'rich_text', issueKey: 'reporter' },
  { aliases: ['Labels'], type: 'multi_select_csv', issueKey: 'labels' },
  { aliases: ['Due date', 'Due Date'], type: 'date', issueKey: 'dueDate' },
  { aliases: ['Start date', 'Start Date'], type: 'date', issueKey: 'startDate' },
  { aliases: ['Original estimate', 'Original Estimate'], type: 'rich_text', issueKey: 'originalEstimate' },
  { aliases: ['Time Spent'], type: 'rich_text', issueKey: 'timeSpent' },
  { aliases: ['Time Remaining'], type: 'rich_text', issueKey: 'timeRemaining' },
  { aliases: ['Project Key'], type: 'rich_text', issueKey: 'projectKey' },
  { aliases: ['Project Name'], type: 'rich_text', issueKey: 'projectName' },
  { aliases: ['Epic Key'], type: 'rich_text', issueKey: 'epicKey' },
  { aliases: ['Epic Name'], type: 'rich_text', issueKey: 'epicName' },
  { aliases: ['Jira URL'], type: 'url', issueKey: 'jiraUrl' },
];

/**
 * Builds one Notion property payload from a type definition.
 */
function buildPropertyValue(type, value) {
  switch (type) {
    case 'title':
      return title(value);
    case 'rich_text':
      return richText(value);
    case 'select':
      return select(value);
    case 'date':
      return date(value);
    case 'multi_select_csv':
      return multiSelectCsv(value);
    case 'url':
      return url(value);
    default:
      return null;
  }
}

/**
 * Fetches the Notion database schema so optional properties can be written only
 * when they exist in the current database.
 */
async function fetchDatabaseSchema(env) {
  const database = await notionRequest(env, `/databases/${env.NOTION_DATABASE_ID}`);
  return database.properties || {};
}

/**
 * Maps the current Jira issue record into the Notion properties we want to sync.
 */
function buildProperties(issue, schema) {
  const properties = {};

  for (const definition of PROPERTY_DEFINITIONS) {
    const propertyName = getSchemaKeyByName(schema, definition.aliases);
    if (!propertyName) {
      continue;
    }

    const propertyValue = buildPropertyValue(definition.type, issue[definition.issueKey]);
    if (propertyValue) {
      properties[propertyName] = propertyValue;
    }
  }

  return properties;
}

/**
 * Returns the matching Notion property object for a set of aliases.
 */
function getPageProperty(page, aliases) {
  const properties = page?.properties || {};
  const propertyName = getSchemaKeyByName(properties, aliases);
  return propertyName ? properties[propertyName] : undefined;
}

/**
 * Reads a plain string from a title or rich-text property.
 */
function readTextProperty(property) {
  if (property === undefined) {
    return undefined;
  }

  if (Array.isArray(property?.title)) {
    return richTextToPlain(property.title);
  }

  if (Array.isArray(property?.rich_text)) {
    return richTextToPlain(property.rich_text);
  }

  return '';
}

/**
 * Reads a string from a select-style property.
 */
function readSelectProperty(property) {
  if (property === undefined) {
    return undefined;
  }

  if (property.select?.name) {
    return String(property.select.name).trim();
  }

  if (property.status?.name) {
    return String(property.status.name).trim();
  }

  return '';
}

/**
 * Reads a date start value from a Notion date property.
 */
function readDateProperty(property) {
  if (property === undefined) {
    return undefined;
  }

  return property.date?.start || null;
}

/**
 * Reads a list of labels from a Notion multi-select property.
 */
function readMultiSelectProperty(property) {
  if (property === undefined) {
    return undefined;
  }

  if (Array.isArray(property.multi_select)) {
    return property.multi_select.map((item) => String(item?.name || '').trim()).filter(Boolean);
  }

  const text = readTextProperty(property);
  return typeof text === 'string' ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
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
 * Fetches a single Notion page by page id.
 */
export async function fetchNotionPage(env, pageId) {
  return notionRequest(env, `/pages/${pageId}`);
}

/**
 * Reads the Issue Key property from a Notion page.
 */
export function getNotionIssueKey(page) {
  const properties = page?.properties || {};
  return richTextToPlain((properties['Issue Key'] || {}).rich_text);
}

/**
 * Reads the current Status name from either a select or status property.
 */
export function getNotionStatus(page) {
  return readSelectProperty(getPageProperty(page, ['Status'])) || '';
}

/**
 * Reads the subset of Notion page fields that are allowed to write back into Jira.
 */
export function getNotionWritableIssueFields(page) {
  return {
    name: readTextProperty(getPageProperty(page, ['Name'])),
    description: readTextProperty(getPageProperty(page, ['Description'])),
    status: readSelectProperty(getPageProperty(page, ['Status'])),
    priority: readSelectProperty(getPageProperty(page, ['Priority'])),
    labels: readMultiSelectProperty(getPageProperty(page, ['Labels'])),
    originalEstimate: readTextProperty(getPageProperty(page, ['Original estimate', 'Original Estimate'])),
    startDate: readDateProperty(getPageProperty(page, ['Start date', 'Start Date'])),
  };
}

/**
 * Updates the existing Notion page for this Jira issue, or creates it if it
 * does not exist yet.
 */
export async function upsertIssuePage(env, issue, knownPageId = null) {
  const schema = await fetchDatabaseSchema(env);
  const pageId = knownPageId || (await findPageByIssueKey(env, issue.issueKey))?.id;
  const properties = buildProperties(issue, schema);

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
