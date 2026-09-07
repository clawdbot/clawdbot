import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parsePostContent } from "./post.js";

const INTERACTIVE_CARD_FALLBACK_TEXT = "[Interactive Card]";
const POST_FALLBACK_TEXT = "[Rich text message]";

function normalizeCardTemplateVariable(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readCardTemplateVariables(parsed: Record<string, unknown>): Map<string, string> {
  const variables = new Map<string, string>();
  for (const source of [parsed.template_variable, parsed.template_variables]) {
    if (!isRecord(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      const normalized = normalizeCardTemplateVariable(value);
      if (normalized !== undefined) {
        variables.set(key, normalized);
      }
    }
  }
  return variables;
}

function applyCardTemplateVariables(text: string, variables: Map<string, string>): string {
  if (variables.size === 0) {
    return text;
  }
  return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
    const variableName = typeof a === "string" ? a : b;
    return variables.get(variableName) ?? match;
  });
}

function normalizeInteractiveValue(value: unknown, variables: Map<string, string>): string {
  const scalar = normalizeCardTemplateVariable(value);
  if (scalar !== undefined) {
    return applyCardTemplateVariables(scalar, variables);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeInteractiveValue(entry, variables))
      .filter(Boolean)
      .join(", ");
  }
  if (!isRecord(value)) {
    return "";
  }
  for (const key of [
    "content",
    "text",
    "label",
    "name",
    "display_name",
    "user_name",
    "user_id",
    "open_id",
    "id",
    "value",
  ]) {
    const text = normalizeInteractiveValue(value[key], variables);
    if (text) {
      return text;
    }
  }
  return "";
}

function extractInteractiveTableText(
  element: Record<string, unknown>,
  variables: Map<string, string>,
): string | undefined {
  if (!Array.isArray(element.columns) || !Array.isArray(element.rows)) {
    return undefined;
  }
  const columns = element.columns.flatMap((column) => {
    if (!isRecord(column) || typeof column.name !== "string") {
      return [];
    }
    return [
      {
        name: column.name,
        title: typeof column.display_name === "string" ? column.display_name : column.name,
      },
    ];
  });
  if (columns.length === 0) {
    return undefined;
  }

  const lines = [
    columns.map((column) => applyCardTemplateVariables(column.title, variables)).join(" | "),
  ];
  for (const row of element.rows) {
    if (!isRecord(row)) {
      continue;
    }
    const cells = columns.map((column) => normalizeInteractiveValue(row[column.name], variables));
    if (cells.some(Boolean)) {
      lines.push(cells.join(" | "));
    }
  }
  return lines.join("\n");
}

function extractInteractiveElementText(
  element: unknown,
  variables: Map<string, string>,
): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const tag = typeof element.tag === "string" ? element.tag : "";
  const text = isRecord(element.text) ? element.text : undefined;

  if (tag === "div") {
    const parts = [normalizeInteractiveValue(element.text, variables)];
    if (Array.isArray(element.fields)) {
      parts.push(extractInteractiveElementsText(element.fields, variables));
    }
    return parts.filter(Boolean).join("\n") || undefined;
  }
  if ((tag === "markdown" || tag === "lark_md") && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  if ((tag === "text" || tag === "a" || tag === "button") && element.text !== undefined) {
    return normalizeInteractiveValue(element.text, variables) || undefined;
  }
  if (tag === "at") {
    const mention = normalizeInteractiveValue(element.user_name ?? element.user_id, variables);
    return mention ? (mention.startsWith("@") ? mention : `@${mention}`) : undefined;
  }
  if (tag === "plain_text" && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  if (tag === "table") {
    return extractInteractiveTableText(element, variables);
  }

  const nestedText = [
    element.elements,
    element.columns,
    element.children,
    element.fields,
    element.actions,
  ]
    .filter(Array.isArray)
    .map((children) => extractInteractiveElementsText(children, variables))
    .filter(Boolean)
    .join("\n");
  return nestedText || (typeof text?.content === "string" ? text.content : undefined);
}

function extractInteractiveElementsText(
  elements: unknown[],
  variables: Map<string, string>,
): string {
  const texts: string[] = [];
  for (const element of elements) {
    if (Array.isArray(element)) {
      const row = element
        .map((part) => extractInteractiveElementText(part, variables))
        .filter((part): part is string => Boolean(part))
        .join(" ")
        .trim();
      if (row) {
        texts.push(row);
      }
      continue;
    }
    const text = extractInteractiveElementText(element, variables);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.join("\n").trim();
}

function readInteractiveElementArrays(parsed: Record<string, unknown>): unknown[][] {
  const body = isRecord(parsed.body) ? parsed.body : undefined;
  const elementArrays: unknown[][] = [];

  for (const candidate of [parsed.elements, body?.elements]) {
    if (Array.isArray(candidate)) {
      elementArrays.push(candidate);
    }
  }

  for (const candidate of [parsed.i18n_elements, body?.i18n_elements]) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const localeElements of Object.values(candidate)) {
      if (Array.isArray(localeElements)) {
        elementArrays.push(localeElements);
      }
    }
  }

  return elementArrays;
}

function readInteractiveCardTitle(
  parsed: Record<string, unknown>,
  variables: Map<string, string>,
): string {
  if (typeof parsed.title === "string") {
    return applyCardTemplateVariables(parsed.title, variables).trim();
  }
  const header = isRecord(parsed.header) ? parsed.header : undefined;
  const title = isRecord(header?.title) ? header.title : undefined;
  return typeof title?.content === "string"
    ? applyCardTemplateVariables(title.content, variables).trim()
    : "";
}

export function parseInteractiveCardContent(parsed: unknown): string {
  if (!isRecord(parsed)) {
    return INTERACTIVE_CARD_FALLBACK_TEXT;
  }

  const variables = readCardTemplateVariables(parsed);
  const title = readInteractiveCardTitle(parsed, variables);
  for (const elements of readInteractiveElementArrays(parsed)) {
    const text = extractInteractiveElementsText(elements, variables);
    if (text) {
      return title ? `${title}\n${text}` : text;
    }
  }

  const postText = parsePostContent(JSON.stringify(parsed)).textContent.trim();
  if (postText && postText !== POST_FALLBACK_TEXT) {
    return postText;
  }
  return title || INTERACTIVE_CARD_FALLBACK_TEXT;
}
