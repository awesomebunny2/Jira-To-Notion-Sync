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
 * Creates a rich-text payload that preserves clickable hyperlinks for any full
 * URLs embedded in the text.
 */
function richTextWithLinks(content) {
  const text = String(content || '').slice(0, 2000);
  if (!text) {
    return { rich_text: [] };
  }

  const richTextItems = [];
  const urlPattern = /https?:\/\/[^\s]+/g;
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    const url = match[0];
    const start = match.index || 0;
    const leadingText = text.slice(lastIndex, start);
    if (leadingText) {
      richTextItems.push({ text: { content: leadingText } });
    }

    richTextItems.push({
      text: {
        content: url,
        link: { url },
      },
    });

    lastIndex = start + url.length;
  }

  const trailingText = text.slice(lastIndex);
  if (trailingText) {
    richTextItems.push({ text: { content: trailingText } });
  }

  return { rich_text: richTextItems.length > 0 ? richTextItems : [{ text: { content: text } }] };
}

/**
 * Ensures the Pull Requests field always ends with one blank line in Notion so
 * adding another entry stays visually easy in the UI.
 */
function formatPullRequestsForNotion(content) {
  const text = String(content || '').replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  return text ? `${text}\n\n` : '';
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
  { aliases: ['Jira Read Only Props'], type: 'rich_text', issueKey: 'jiraReadOnlyProps' },
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
  { aliases: ['Pull Requests', 'Pull Request Link'], type: 'rich_text_with_links', issueKey: 'pullRequests' },
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
    case 'rich_text_with_links':
      return richTextWithLinks(formatPullRequestsForNotion(value));
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

  if (typeof property?.formula?.string === 'string') {
    return String(property.formula.string).trim();
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
 * Lists all direct child blocks for one Notion page or block.
 */
async function listBlockChildren(env, blockId) {
  const children = [];
  let startCursor = null;

  while (true) {
    const params = new URLSearchParams({ page_size: '100' });
    if (startCursor) {
      params.set('start_cursor', startCursor);
    }

    const result = await notionRequest(env, `/blocks/${blockId}/children?${params.toString()}`);
    children.push(...(result.results || []));
    if (!result.has_more) {
      break;
    }
    startCursor = result.next_cursor || null;
  }

  return children;
}

/**
 * Splits a block list into API-sized chunks for Notion append calls.
 */
function chunkBlocks(blocks, size = 100) {
  const chunks = [];
  for (let index = 0; index < blocks.length; index += size) {
    chunks.push(blocks.slice(index, index + size));
  }
  return chunks;
}

/**
 * Appends top-level child blocks and returns the created block ids.
 */
async function appendBlocks(env, blockId, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [];
  }

  const createdIds = [];
  for (const chunk of chunkBlocks(blocks)) {
    const result = await notionRequest(env, `/blocks/${blockId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: chunk }),
    });

    for (const created of result.results || []) {
      if (created?.id) {
        createdIds.push(created.id);
      }
    }
  }

  return createdIds;
}

/**
 * Returns true when a Notion block is already archived.
 */
function isArchivedBlock(block) {
  return Boolean(block?.archived || block?.in_trash);
}

/**
 * Archives one Notion block if it is still active.
 */
async function deleteBlock(env, block) {
  if (!block?.id || isArchivedBlock(block)) {
    return false;
  }

  try {
    await notionRequest(env, `/blocks/${block.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes("Can't edit block that is archived")) {
      return false;
    }
    throw error;
  }

  return true;
}

/**
 * Formats one timestamp for the mirrored Jira comments header line.
 */
function formatCommentDateTime(env, isoString) {
  if (!isoString) {
    return 'Unknown time';
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return String(isoString);
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: String(env.READ_ONLY_PROPS_TIMEZONE || 'America/New_York').trim() || 'America/New_York',
    timeZoneName: 'short',
  }).format(date);
}

/**
 * Creates a Notion rich-text node used in mirrored Jira comment blocks.
 */
function makeTextNode(content, annotations = {}) {
  return {
    type: 'text',
    text: { content: String(content || '').slice(0, 2000) },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
      ...annotations,
    },
  };
}

/**
 * Splits a comment body into Notion-sized paragraph chunks.
 */
function splitCommentBody(body) {
  const normalized = String(body || '').replace(/\r\n/g, '\n').trim() || '(no text)';
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const output = [];

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized]) {
    for (let index = 0; index < paragraph.length; index += 1800) {
      output.push(paragraph.slice(index, index + 1800));
    }
  }

  return output.length > 0 ? output : ['(no text)'];
}

/**
 * Builds the Notion block payload for one mirrored Jira comment.
 */
function formatCommentBlocks(env, comment) {
  const blocks = [
    {
      type: 'paragraph',
      paragraph: {
        rich_text: [
          makeTextNode(comment.author || 'Unknown', { bold: true }),
          makeTextNode(`  ${formatCommentDateTime(env, comment.created)}`, { italic: true, color: 'gray' }),
        ],
      },
    },
  ];

  for (const chunk of splitCommentBody(comment.body)) {
    blocks.push({
      type: 'paragraph',
      paragraph: {
        rich_text: [makeTextNode(chunk)],
      },
    });
  }

  blocks.push({ type: 'divider', divider: {} });
  return blocks;
}

/**
 * Finds a pre-existing Jira Comments heading in case tracked block ids were not
 * saved yet for an older page.
 */
function findCommentsSectionStart(children) {
  for (let index = 0; index < children.length; index += 1) {
    const block = children[index];
    if (isArchivedBlock(block) || block?.type !== 'heading_2') {
      continue;
    }

    const title = richTextToPlain(block?.heading_2?.rich_text || []).trim().toLowerCase();
    if (title !== 'jira comments') {
      continue;
    }

    if (index > 0 && !isArchivedBlock(children[index - 1]) && children[index - 1]?.type === 'divider') {
      return index - 1;
    }

    return index;
  }

  return -1;
}

/**
 * Returns true when a block is the managed Jira Comments container.
 */
function isJiraCommentsContainer(block) {
  if (isArchivedBlock(block)) {
    return false;
  }

  const richText =
    block?.type === 'callout'
      ? block?.callout?.rich_text || []
      : block?.type === 'toggle'
        ? block?.toggle?.rich_text || []
        : [];
  if (richText.length === 0) {
    return false;
  }

  const title = richTextToPlain(richText).trim().toLowerCase();
  return title === 'jira comments';
}

/**
 * Replaces the managed Jira Comments container on a Notion page.
 */
export async function replaceJiraCommentsSection(env, pageId, comments, trackedBlockIds = []) {
  const children = (await listBlockChildren(env, pageId)).filter((block) => !isArchivedBlock(block));
  const childById = new Map(children.map((block) => [String(block?.id || '').trim(), block]));
  const sectionStart = findCommentsSectionStart(children);
  const containerBlocks = children.filter(isJiraCommentsContainer);
  let blocksToDelete = [];

  // Prefer a dedicated container when present. This keeps refresh cheap:
  // one delete for the old container instead of deleting every mirrored block.
  if (containerBlocks.length > 0) {
    blocksToDelete = containerBlocks;
  } else if (sectionStart >= 0) {
    // Fall back to cleaning the old heading-based tail section once so older
    // pages migrate into the cheaper single-container layout.
    blocksToDelete = children.slice(sectionStart);
  } else {
    const trackedIds = Array.isArray(trackedBlockIds) ? trackedBlockIds.filter(Boolean) : [];
    blocksToDelete = trackedIds.map((blockId) => childById.get(String(blockId).trim())).filter(Boolean);
  }

  for (let index = blocksToDelete.length - 1; index >= 0; index -= 1) {
    await deleteBlock(env, blocksToDelete[index]);
  }

  const normalizedComments = Array.isArray(comments) ? comments : [];
  if (normalizedComments.length === 0) {
    return {
      commentCount: 0,
      blockIds: [],
    };
  }

  const containerIds = await appendBlocks(env, pageId, [
    {
      type: 'callout',
      callout: {
        rich_text: [makeTextNode('Jira Comments')],
        icon: {
          type: 'emoji',
          emoji: '💬',
        },
        color: 'default',
      },
    },
  ]);
  const containerId = containerIds[0] || null;
  const commentBlocks = [];

  for (const comment of normalizedComments) {
    commentBlocks.push(...formatCommentBlocks(env, comment));
  }

  if (containerId && commentBlocks.length > 0) {
    await appendBlocks(env, containerId, commentBlocks);
  }

  return {
    commentCount: normalizedComments.length,
    blockIds: containerId ? [containerId] : [],
  };
}

/**
 * Reads the Issue Key property from a Notion page.
 */
export function getNotionIssueKey(page) {
  return readTextProperty(getPageProperty(page, ['Issue Key'])) || '';
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
    pullRequests: readTextProperty(getPageProperty(page, ['Pull Requests', 'Pull Request Link'])),
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
