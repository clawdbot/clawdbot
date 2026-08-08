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

function extractInteractiveElementText(
  element: unknown,
  variables: Map<string, string>,
): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const tag = typeof element.tag === "string" ? element.tag : "";
  const text = isRecord(element.text) ? element.text : undefined;

  if (tag === "div" && typeof text?.content === "string") {
    return applyCardTemplateVariables(text.content, variables);
  }
  if ((tag === "markdown" || tag === "lark_md") && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  if (tag === "plain_text" && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  return undefined;
}

function extractInteractiveElementsText(
  elements: unknown[],
  variables: Map<string, string>,
): string {
  const texts: string[] = [];
  for (const element of elements) {
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

export function parseInteractiveCardContent(parsed: unknown): string {
  if (!isRecord(parsed)) {
    return INTERACTIVE_CARD_FALLBACK_TEXT;
  }

  const variables = readCardTemplateVariables(parsed);
  for (const elements of readInteractiveElementArrays(parsed)) {
    const text = extractInteractiveElementsText(elements, variables);
    if (text) {
      return text;
    }
  }

  const postText = parsePostContent(JSON.stringify(parsed)).textContent.trim();
  return postText && postText !== POST_FALLBACK_TEXT ? postText : INTERACTIVE_CARD_FALLBACK_TEXT;
}
