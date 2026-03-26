function notionHeaders(env) {
  if (!env.NOTION_TOKEN) {
    throw new Error("Missing NOTION_TOKEN secret/variable.");
  }
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": env.NOTION_VERSION || "2022-06-28",
    "Content-Type": "application/json",
  };
}

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

  const text = await response.text();
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

function notionRichTextToPlain(richText) {
  if (!Array.isArray(richText)) {
    return "";
  }

  return richText
    .map((item) => {
      if (typeof item?.plain_text === "string") {
        return item.plain_text;
      }
      return item?.text?.content || "";
    })
    .join("")
    .trim();
}

function richTextValue(value) {
  const text = value || "";
  if (!text) {
    return { rich_text: [] };
  }

  return {
    rich_text: [
      {
        text: {
          content: text.slice(0, 2000),
        },
      },
    ],
  };
}

function titleValue(value) {
  return {
    title: [
      {
        text: {
          content: (value || "").slice(0, 2000),
        },
      },
    ],
  };
}

function dateValue(value) {
  return value ? { date: { start: value } } : { date: null };
}

function selectValue(value) {
  return value ? { select: { name: value } } : { select: null };
}

function multiSelectFromCsv(value) {
  if (!value) {
    return { multi_select: [] };
  }

  return {
    multi_select: value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((name) => ({ name })),
  };
}

function urlValue(value) {
  return { url: value || null };
}

function getSchemaKeyByName(schema, wantedNames) {
  const names = Array.isArray(wantedNames) ? wantedNames : [wantedNames];
  const lowered = new Map(Object.keys(schema).map((key) => [key.toLowerCase(), key]));

  for (const wanted of names) {
    const exact = lowered.get(String(wanted).toLowerCase());
    if (exact) {
      return exact;
    }
  }

  return null;
}

const PROPERTY_DEFINITIONS = [
  { aliases: ["Name"], type: "title", rowKey: "name" },
  { aliases: ["Issue Key"], type: "rich_text", rowKey: "key" },
  { aliases: ["Status"], type: "select", rowKey: "status" },
  { aliases: ["Priority"], type: "select", rowKey: "priority" },
  { aliases: ["Assignee"], type: "rich_text", rowKey: "assignee" },
  { aliases: ["Updated"], type: "date", rowKey: "updated" },
  { aliases: ["Jira URL"], type: "url", rowKey: "jira_url" },
  { aliases: ["Description"], type: "rich_text", rowKey: "Description" },
  { aliases: ["Reporter"], type: "rich_text", rowKey: "Reporter" },
  { aliases: ["Labels"], type: "multi_select_csv", rowKey: "Labels" },
  { aliases: ["Due date"], type: "date", rowKey: "Due date" },
  { aliases: ["Other PRs", "Pull Request Link"], type: "rich_text", rowKey: "Pull Request Link" },
  { aliases: ["Project Key"], type: "rich_text", rowKey: "Project Key" },
  { aliases: ["Project Name"], type: "rich_text", rowKey: "Project Name" },
  { aliases: ["Epic Key"], type: "rich_text", rowKey: "Epic Key" },
  { aliases: ["Epic Name"], type: "rich_text", rowKey: "Epic Name" },
];

export async function fetchDatabaseSchema(env) {
  if (!env.NOTION_DATABASE_ID) {
    throw new Error("Missing NOTION_DATABASE_ID secret/variable.");
  }

  const database = await notionRequest(env, `/databases/${env.NOTION_DATABASE_ID}`);
  return database.properties || {};
}

export async function fetchNotionPage(env, pageId) {
  return notionRequest(env, `/pages/${pageId}`);
}

export async function fetchNotionComment(env, commentId) {
  return notionRequest(env, `/comments/${commentId}`);
}

export function getNotionCommentText(comment) {
  return notionRichTextToPlain(comment?.rich_text || []);
}

export function getNotionCommentAuthorType(comment) {
  return ((comment?.created_by || {}).type || "").trim();
}

export function getNotionIssueKey(page) {
  const properties = page.properties || {};
  const issueKeyProperty = properties["Issue Key"] || {};
  return notionRichTextToPlain(issueKeyProperty.rich_text);
}

export function getNotionStatus(page) {
  const properties = page.properties || {};
  const statusProperty = properties.Status || {};

  if (statusProperty.select?.name) {
    return String(statusProperty.select.name).trim();
  }

  if (statusProperty.status?.name) {
    return String(statusProperty.status.name).trim();
  }

  return "";
}

export async function findPageByIssueKey(env, issueKey) {
  if (!env.NOTION_DATABASE_ID || !issueKey) {
    return null;
  }

  const result = await notionRequest(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      page_size: 1,
      filter: {
        property: "Issue Key",
        rich_text: {
          equals: issueKey,
        },
      },
    }),
  });

  return (result.results || [])[0] || null;
}

export async function queryIssuePages(env, { startCursor = null, pageSize = 25 } = {}) {
  if (!env.NOTION_DATABASE_ID) {
    throw new Error("Missing NOTION_DATABASE_ID secret/variable.");
  }

  const payload = {
    page_size: Math.max(1, Math.min(100, Number(pageSize) || 25)),
    sorts: [
      {
        property: "Issue Key",
        direction: "ascending",
      },
    ],
    filter: {
      property: "Issue Key",
      rich_text: {
        is_not_empty: true,
      },
    },
  };

  if (startCursor) {
    payload.start_cursor = startCursor;
  }

  const result = await notionRequest(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return {
    results: result.results || [],
    hasMore: Boolean(result.has_more),
    nextCursor: result.next_cursor || null,
  };
}

export async function countIssuePages(env) {
  let count = 0;
  let cursor = null;

  while (true) {
    const batch = await queryIssuePages(env, {
      startCursor: cursor,
      pageSize: 100,
    });
    count += batch.results.length;
    if (!batch.hasMore) {
      break;
    }
    cursor = batch.nextCursor;
  }

  return count;
}

function normalizeFieldSelection(selectedFields) {
  if (!Array.isArray(selectedFields) || selectedFields.length === 0) {
    return null;
  }

  const wanted = new Set(selectedFields.map((field) => String(field).trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) {
    return null;
  }

  return wanted;
}

function shouldIncludeField(definition, normalizedSelection, { forCreate }) {
  if (!normalizedSelection) {
    return true;
  }

  if (forCreate && definition.aliases.some((alias) => alias.toLowerCase() === "name")) {
    return true;
  }

  if (forCreate && definition.aliases.some((alias) => alias.toLowerCase() === "issue key")) {
    return true;
  }

  return definition.aliases.some((alias) => normalizedSelection.has(alias.toLowerCase()));
}

function buildPropertyValue(type, value) {
  switch (type) {
    case "title":
      return titleValue(value);
    case "rich_text":
      return richTextValue(value);
    case "select":
      return selectValue(value);
    case "date":
      return dateValue(value);
    case "url":
      return urlValue(value);
    case "multi_select_csv":
      return multiSelectFromCsv(value);
    default:
      return null;
  }
}

function buildProperties(row, schema, { forCreate = false, selectedFields = null } = {}) {
  const properties = {};
  const normalizedSelection = normalizeFieldSelection(selectedFields);

  const addIfPresent = (definition) => {
    if (!shouldIncludeField(definition, normalizedSelection, { forCreate })) {
      return;
    }

    const actualName = getSchemaKeyByName(schema, definition.aliases);
    if (actualName) {
      const propertyValue = buildPropertyValue(definition.type, row[definition.rowKey]);
      if (propertyValue) {
        properties[actualName] = propertyValue;
      }
    }
  };

  for (const definition of PROPERTY_DEFINITIONS) {
    if (!forCreate && definition.aliases.some((alias) => alias.toLowerCase() === "issue key")) {
      continue;
    }
    addIfPresent(definition);
  }

  return properties;
}

export async function upsertIssuePage(
  env,
  row,
  existingPageId = null,
  schemaOverride = null,
  selectedFields = null
) {
  const schema = schemaOverride || (await fetchDatabaseSchema(env));
  let pageId = existingPageId;

  if (!pageId) {
    const existingPage = await findPageByIssueKey(env, row.key);
    pageId = existingPage?.id || null;
  }

  if (pageId) {
    await notionRequest(env, `/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: buildProperties(row, schema, { forCreate: false, selectedFields }),
      }),
    });
    return pageId;
  }

  const created = await notionRequest(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        database_id: env.NOTION_DATABASE_ID,
      },
      properties: buildProperties(row, schema, { forCreate: true, selectedFields }),
    }),
  });

  return created.id;
}

function blockRichTextToPlain(block, type) {
  const payload = block?.[type] || {};
  return notionRichTextToPlain(payload.rich_text || []);
}

async function notionListBlockChildren(env, blockId) {
  const children = [];
  let startCursor = null;

  while (true) {
    const params = new URLSearchParams({ page_size: "100" });
    if (startCursor) {
      params.set("start_cursor", startCursor);
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

function chunkBlocks(blocks, size = 100) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) {
    chunks.push(blocks.slice(i, i + size));
  }
  return chunks;
}

async function notionAppendBlocks(env, blockId, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [];
  }

  const createdIds = [];
  for (const chunk of chunkBlocks(blocks, 100)) {
    const result = await notionRequest(env, `/blocks/${blockId}/children`, {
      method: "PATCH",
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

function isArchivedBlock(block) {
  return Boolean(block?.archived || block?.in_trash);
}

async function notionDeleteBlock(env, block) {
  if (!block?.id || isArchivedBlock(block)) {
    return false;
  }

  try {
    await notionRequest(env, `/blocks/${block.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.includes("Can't edit block that is archived")) {
      return false;
    }
    throw error;
  }

  return true;
}

function formatHumanDateTime(isoString) {
  if (!isoString) {
    return "Unknown time";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(date);
}

function makeTextNode(content, annotations = {}) {
  return {
    type: "text",
    text: { content },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
      ...annotations,
    },
  };
}

function splitCommentBody(body) {
  const normalized = String(body || "").replace(/\r\n/g, "\n").trim() || "(no text)";
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const output = [];

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized]) {
    for (let i = 0; i < paragraph.length; i += 1800) {
      output.push(paragraph.slice(i, i + 1800));
    }
  }

  return output.length > 0 ? output : ["(no text)"];
}

function formatCommentBlocks(comment) {
  const blocks = [
    {
      type: "paragraph",
      paragraph: {
        rich_text: [
          makeTextNode(comment.author || "Unknown", { bold: true }),
          makeTextNode(`  ${formatHumanDateTime(comment.created)}`, { italic: true, color: "gray" }),
        ],
      },
    },
  ];

  for (const chunk of splitCommentBody(comment.body)) {
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: [makeTextNode(chunk)],
      },
    });
  }

  blocks.push({ type: "divider", divider: {} });
  return blocks;
}

function findJiraCommentsSectionStart(children) {
  for (let i = 0; i < children.length; i += 1) {
    const block = children[i];
    if (isArchivedBlock(block) || block?.type !== "heading_2") {
      continue;
    }
    const title = blockRichTextToPlain(block, "heading_2").trim().toLowerCase();
    if (title !== "jira comments") {
      continue;
    }

    if (i > 0 && !isArchivedBlock(children[i - 1]) && children[i - 1]?.type === "divider") {
      return i - 1;
    }
    return i;
  }

  return -1;
}

export async function hasTrackedJiraCommentSection(env, pageId, trackedBlockIds = []) {
  const normalizedTrackedBlockIds = Array.isArray(trackedBlockIds)
    ? trackedBlockIds.filter((blockId) => typeof blockId === "string" && blockId.trim())
    : [];

  if (normalizedTrackedBlockIds.length < 2) {
    return false;
  }

  const children = (await notionListBlockChildren(env, pageId)).filter((block) => !isArchivedBlock(block));
  const ids = new Set(children.map((block) => String(block?.id || "").trim()).filter(Boolean));
  return ids.has(normalizedTrackedBlockIds[0]) && ids.has(normalizedTrackedBlockIds[1]);
}

export async function appendJiraCommentToSection(env, pageId, comment) {
  if (!comment) {
    return { commentCount: 0, blockIds: [], commentIds: [] };
  }

  const blockIds = await notionAppendBlocks(env, pageId, formatCommentBlocks(comment));
  return {
    commentCount: 1,
    blockIds,
    commentIds: comment.id ? [String(comment.id).trim()] : [],
  };
}

export async function replaceJiraCommentsSection(env, pageId, comments, trackedBlockIds = []) {
  const children = (await notionListBlockChildren(env, pageId)).filter((block) => !isArchivedBlock(block));
  for (let index = children.length - 1; index >= 0; index -= 1) {
    await notionDeleteBlock(env, children[index]);
  }

  const normalizedComments = Array.isArray(comments) ? comments : [];
  if (normalizedComments.length === 0) {
    return { replaced: children.length > 0, commentCount: 0, blockIds: [], commentIds: [] };
  }

  const blocks = [
    { type: "divider", divider: {} },
    {
      type: "heading_2",
      heading_2: {
        rich_text: [makeTextNode("Jira Comments")],
      },
    },
  ];

  for (const comment of normalizedComments) {
    blocks.push(...formatCommentBlocks(comment));
  }

  const blockIds = await notionAppendBlocks(env, pageId, blocks);
  return {
    replaced: children.length > 0,
    commentCount: normalizedComments.length,
    blockIds,
    commentIds: normalizedComments.map((comment) => String(comment?.id || '').trim()).filter(Boolean),
  };
}
