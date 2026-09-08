/**
 * web_fetch extraction utilities.
 *
 * Converts lightweight HTML into bounded markdown/text without pulling in a full renderer.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInvisibleUnicode } from "../../infra/unicode-visibility.js";
import { decodeHtmlEntities } from "../../shared/html-entities.js";
import {
  RAW_TEXT_TAGS,
  isAsciiWhitespace,
  isTagNameChar,
  readRawTextOpenTagName,
  findRawTextOpenTagStart,
  startsLikeHtmlTag,
  readTagToken,
  closeRawTextTagEnd,
  skipRawTextElement,
} from "./web-fetch-html-tag.js";
import { sanitizeHtml } from "./web-fetch-visibility.js";

/** Output mode requested by web_fetch extraction. */
export type ExtractMode = "markdown" | "text";

const BLOCK_BREAK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "table",
  "tr",
  "ul",
  "ol",
]);
// Keep malformed nested markup from making end-of-document context unwind quadratic.
// web_fetch favors bounded, auditable text over preserving deep broken HTML structure.
const MAX_RENDER_CONTEXT_DEPTH = 32;

type RenderContext =
  | { kind: "root"; parts: string[] }
  | { kind: "title"; parts: string[] }
  | { kind: "anchor"; href: string | undefined; hasText: boolean; parts: string[] }
  | { kind: "heading"; level: number; parts: string[] }
  | { kind: "list-item"; parts: string[] };

function decodeEntities(value: string): string {
  // Display extraction historically accepted mixed-case &nbsp; and treats non-breaking spaces as
  // ordinary collapsible whitespace. Normalize it before the shared decoder to stay single-pass.
  return decodeHtmlEntities(value.replace(/&nbsp;/gi, "\u00a0")).replaceAll("\u00a0", " ");
}

function readAttributeValue(rawTag: string, name: string): string | undefined {
  const target = name.toLowerCase();
  let pos = 0;
  while (pos < rawTag.length && !isAsciiWhitespace(rawTag.charAt(pos))) {
    pos += 1;
  }
  while (pos < rawTag.length) {
    while (
      pos < rawTag.length &&
      (isAsciiWhitespace(rawTag.charAt(pos)) || rawTag.charAt(pos) === "/")
    ) {
      pos += 1;
    }
    const attrStart = pos;
    while (pos < rawTag.length && isTagNameChar(rawTag.charAt(pos))) {
      pos += 1;
    }
    if (pos === attrStart) {
      pos = skipUnsupportedAttribute(rawTag, pos);
      continue;
    }
    const attrName = rawTag.slice(attrStart, pos).toLowerCase();
    while (pos < rawTag.length && isAsciiWhitespace(rawTag.charAt(pos))) {
      pos += 1;
    }
    let value = "";
    if (rawTag[pos] === "=") {
      pos += 1;
      while (pos < rawTag.length && isAsciiWhitespace(rawTag.charAt(pos))) {
        pos += 1;
      }
      const quote = rawTag[pos];
      if (quote === '"' || quote === "'") {
        const valueStart = pos + 1;
        const valueEnd = rawTag.indexOf(quote, valueStart);
        if (valueEnd === -1) {
          value = rawTag.slice(valueStart);
          pos = rawTag.length;
        } else {
          value = rawTag.slice(valueStart, valueEnd);
          pos = valueEnd + 1;
        }
      } else {
        const valueStart = pos;
        while (
          pos < rawTag.length &&
          !isAsciiWhitespace(rawTag.charAt(pos)) &&
          rawTag[pos] !== '"' &&
          rawTag[pos] !== "'" &&
          rawTag[pos] !== "=" &&
          rawTag[pos] !== "<" &&
          rawTag[pos] !== ">" &&
          rawTag[pos] !== "`"
        ) {
          pos += 1;
        }
        value = rawTag.slice(valueStart, pos);
      }
    }
    if (attrName === target) {
      return decodeEntities(value);
    }
  }
  return undefined;
}

function skipUnsupportedAttribute(rawTag: string, start: number): number {
  let pos = start;
  while (pos < rawTag.length && !isAsciiWhitespace(rawTag.charAt(pos))) {
    const quote = rawTag.charAt(pos);
    if (quote === '"' || quote === "'") {
      const valueEnd = rawTag.indexOf(quote, pos + 1);
      pos = valueEnd === -1 ? rawTag.length : valueEnd + 1;
      continue;
    }
    pos += 1;
  }
  return pos;
}

function contextText(context: RenderContext): string {
  return context.parts.join("");
}

function appendText(stack: RenderContext[], value: string): void {
  const context = stack[stack.length - 1];
  context?.parts.push(value);
  if (context?.kind === "anchor" && /\S/.test(value)) {
    context.hasText = true;
  }
}

function closeContext(
  context: RenderContext,
  parent: RenderContext,
  state: { title?: string },
): void {
  const label = normalizeWhitespace(contextText(context));
  if (!label && context.kind !== "title" && !(context.kind === "anchor" && context.href)) {
    return;
  }
  switch (context.kind) {
    case "title":
      state.title ??= label || undefined;
      return;
    case "anchor":
      if (parent.kind === "title") {
        parent.parts.push(label);
      } else {
        parent.parts.push(
          context.href && label ? `[${label}](${context.href})` : label || context.href || "",
        );
      }
      return;
    case "heading":
      if (parent.kind === "title") {
        parent.parts.push(label);
      } else if (parent.kind === "anchor") {
        parent.parts.push(label);
        parent.hasText ||= Boolean(label);
      } else {
        parent.parts.push(`\n${"#".repeat(context.level)} ${label}\n`);
      }
      return;
    case "list-item":
      if (parent.kind === "title") {
        parent.parts.push(label);
      } else {
        if (parent.kind === "anchor") {
          parent.hasText ||= Boolean(label);
        }
        parent.parts.push(`\n- ${label}`);
      }
      return;
    case "root":
      parent.parts.push(label);
  }
}

function closeTopContext(stack: RenderContext[], state: { title?: string }): boolean {
  if (stack.length < 2) {
    return false;
  }
  const context = stack.pop();
  const parent = stack[stack.length - 1];
  if (!context || !parent) {
    return false;
  }
  closeContext(context, parent, state);
  return true;
}

function closeThroughContext(
  stack: RenderContext[],
  kind: RenderContext["kind"],
  state: { title?: string },
): boolean {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i]?.kind === kind) {
      while (stack.length > i) {
        closeTopContext(stack, state);
      }
      return true;
    }
  }
  return false;
}

function pushContext(
  stack: RenderContext[],
  context: Exclude<RenderContext, { kind: "root" }>,
  state: { title?: string },
): void {
  while (stack.length >= MAX_RENDER_CONTEXT_DEPTH) {
    closeTopContext(stack, state);
  }
  stack.push(context);
}

function closeOpenAnchorWithText(stack: RenderContext[], state: { title?: string }): boolean {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    const context = stack[i];
    if (context?.kind === "anchor") {
      if (!context.hasText) {
        return false;
      }
      while (stack.length > i) {
        closeTopContext(stack, state);
      }
      return true;
    }
  }
  return false;
}

function htmlFragmentToMarkdown(html: string): { text: string; title?: string } {
  const root: RenderContext = { kind: "root", parts: [] };
  const stack: RenderContext[] = [root];
  const state: { title?: string } = {};

  for (let i = 0; i < html.length;) {
    const ch = html[i];
    if (ch !== "<") {
      const nextTag = html.indexOf("<", i);
      const end = nextTag === -1 ? html.length : nextTag;
      appendText(stack, decodeEntities(html.slice(i, end)));
      i = end;
      continue;
    }

    const rawTextTagName = readRawTextOpenTagName(html, i);
    if (rawTextTagName) {
      i = skipRawTextElement(html, i, rawTextTagName);
      continue;
    }

    if (!startsLikeHtmlTag(html, i)) {
      appendText(stack, "<");
      i += 1;
      continue;
    }

    const read = readTagToken(html, i);
    if (!read) {
      const rawTextStart = findRawTextOpenTagStart(html, i + 1, html.length);
      if (rawTextStart !== -1) {
        i = rawTextStart;
        continue;
      }
      break;
    }
    const { token, next } = read;
    i = next;
    if (!token) {
      continue;
    }

    if (token.closing) {
      if (token.name === "title") {
        closeThroughContext(stack, "title", state);
      } else if (token.name === "a") {
        closeThroughContext(stack, "anchor", state);
      } else if (/^h[1-6]$/.test(token.name)) {
        closeThroughContext(stack, "heading", state);
      } else if (token.name === "li") {
        closeThroughContext(stack, "list-item", state);
      } else if (BLOCK_BREAK_TAGS.has(token.name)) {
        appendText(stack, "\n");
      }
      continue;
    }

    if (RAW_TEXT_TAGS.has(token.name)) {
      i = closeRawTextTagEnd(html, token.name, i);
      continue;
    }
    if (BLOCK_BREAK_TAGS.has(token.name)) {
      if (closeOpenAnchorWithText(stack, state)) {
        appendText(stack, " ");
      }
    }
    if (token.name === "br" || token.name === "hr") {
      appendText(stack, "\n");
      continue;
    }
    if (token.name === "title" && !token.selfClosing) {
      pushContext(stack, { kind: "title", parts: [] }, state);
      continue;
    }
    if (token.name === "a" && !token.selfClosing) {
      closeThroughContext(stack, "anchor", state);
      pushContext(
        stack,
        { kind: "anchor", href: readAttributeValue(token.raw, "href"), hasText: false, parts: [] },
        state,
      );
      continue;
    }
    if (/^h[1-6]$/.test(token.name) && !token.selfClosing) {
      closeOpenAnchorWithText(stack, state);
      pushContext(
        stack,
        { kind: "heading", level: Number.parseInt(token.name[1] ?? "1", 10), parts: [] },
        state,
      );
      continue;
    }
    if (token.name === "li" && !token.selfClosing) {
      closeOpenAnchorWithText(stack, state);
      pushContext(stack, { kind: "list-item", parts: [] }, state);
    }
  }

  while (stack.length > 1) {
    closeTopContext(stack, state);
  }

  return {
    text: normalizeWhitespace(contextText(root)),
    title: state.title,
  };
}

/** Collapses display whitespace while preserving paragraph breaks. */
export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Converts sanitized HTML into coarse markdown plus an optional title. */
export function htmlToMarkdown(html: string): { text: string; title?: string } {
  return htmlFragmentToMarkdown(html);
}

/** Removes markdown decoration for plain text extraction. */
export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  let unfenced = "";
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("```", pos);
    if (open === -1) {
      unfenced += text.slice(pos);
      break;
    }
    unfenced += text.slice(pos, open);
    const afterOpen = open + 3;
    const close = text.indexOf("```", afterOpen);
    if (close === -1) {
      unfenced += text.slice(open);
      break;
    }
    const firstLineEnd = text.indexOf("\n", afterOpen);
    const contentStart = firstLineEnd === -1 || firstLineEnd > close ? afterOpen : firstLineEnd + 1;
    unfenced += text.slice(contentStart, close);
    pos = close + 3;
  }
  text = unfenced;
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

/** Truncates text by characters and reports whether truncation occurred. */
export function truncateWebFetchText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: truncateUtf16Safe(value, maxChars), truncated: true };
}

/** Sanitizes HTML and extracts either markdown or plain text content. */
export async function extractBasicHtmlContent(params: {
  html: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = await sanitizeHtml(params.html);
  const rendered = htmlToMarkdown(cleanHtml);
  if (params.extractMode === "text") {
    const text =
      stripInvisibleUnicode(markdownToText(rendered.text)) ||
      stripInvisibleUnicode(rendered.title ?? "") ||
      stripInvisibleUnicode(rendered.text);
    return text ? { text, title: rendered.title } : null;
  }
  const text = stripInvisibleUnicode(rendered.text) || stripInvisibleUnicode(rendered.title ?? "");
  return text ? { text, title: rendered.title } : null;
}
