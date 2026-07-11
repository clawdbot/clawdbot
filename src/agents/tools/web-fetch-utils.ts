/**
 * web_fetch extraction utilities.
 *
 * Converts lightweight HTML into bounded markdown/text without pulling in a full renderer.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { decodeHtmlEntityAt } from "../utils/html.js";
import { sanitizeHtml, stripInvisibleUnicode } from "./web-fetch-visibility.js";

/** Output mode requested by web_fetch extraction. */
export type ExtractMode = "markdown" | "text";

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript"]);
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

type HtmlTagToken = {
  closing: boolean;
  name: string;
  raw: string;
  selfClosing: boolean;
};

type ReadTagResult = {
  token: HtmlTagToken | null;
  next: number;
};

type TagEndResult = {
  end: number;
  rawTextStart?: number;
};

// Decode entities through the canonical shared decoder (agents/utils/html.ts) so web_fetch and the
// renderer share one entity contract — the divergent hand-rolled copy here was what truncated astral
// entities. A single left-to-right pass also avoids double-decoding "&amp;#39;" into "'", because the
// "&amp;" is consumed before its following "#39;" is ever seen as an entity.
function decodeEntities(value: string): string {
  if (!value.includes("&")) {
    return value;
  }
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "&") {
      // &nbsp; is not an escapable entity in the shared decoder; render it as a space.
      if (value.slice(i, i + 6).toLowerCase() === "&nbsp;") {
        out += " ";
        i += 5;
        continue;
      }
      const decoded = decodeHtmlEntityAt(value, i);
      if (decoded) {
        out += decoded.text;
        i += decoded.length - 1;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

function isAsciiWhitespace(value: string): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t" || value === "\f";
}

function isTagNameChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "." ||
    value === "-" ||
    value === "_" ||
    value === ":"
  );
}

function isTagNameStartChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagBoundary(value: string | undefined): boolean {
  return !value || isAsciiWhitespace(value) || value === ">" || value === "/";
}

function asciiLower(value: string): string {
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value;
}

function startsWithClosingTag(html: string, start: number, tagName: string): boolean {
  if (html[start] !== "<" || html[start + 1] !== "/") {
    return false;
  }
  for (let offset = 0; offset < tagName.length; offset += 1) {
    if (asciiLower(html[start + 2 + offset] ?? "") !== tagName[offset]) {
      return false;
    }
  }
  return isTagBoundary(html[start + 2 + tagName.length]);
}

function readRawTextOpenTagName(html: string, start: number): string | undefined {
  if (html[start] !== "<" || html[start + 1] === "/") {
    return undefined;
  }
  for (const tagName of RAW_TEXT_TAGS) {
    let matches = true;
    for (let offset = 0; offset < tagName.length; offset += 1) {
      if (asciiLower(html[start + 1 + offset] ?? "") !== tagName[offset]) {
        matches = false;
        break;
      }
    }
    if (matches && isTagBoundary(html[start + 1 + tagName.length])) {
      return tagName;
    }
  }
  return undefined;
}

function findRawTextOpenTagStart(html: string, start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (readRawTextOpenTagName(html, i)) {
      return i;
    }
  }
  return -1;
}

function startsLikeHtmlTag(html: string, start: number): boolean {
  const next = html[start + 1];
  return next === "!" || next === "?" || next === "/" || isTagNameStartChar(next ?? "");
}

function findTagEnd(html: string, start: number): TagEndResult {
  let quote: string | null = null;
  let afterEquals = false;
  let rawTextStartInQuote: number | undefined;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (rawTextStartInQuote === undefined && readRawTextOpenTagName(html, i)) {
        rawTextStartInQuote = i;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (afterEquals && isAsciiWhitespace(ch)) {
      continue;
    }
    if (afterEquals && (ch === '"' || ch === "'")) {
      quote = ch;
      afterEquals = false;
      continue;
    }
    afterEquals = false;
    if (readRawTextOpenTagName(html, i)) {
      return { end: -1, rawTextStart: i };
    }
    if (ch === ">") {
      return { end: i };
    }
    if (ch === "=") {
      afterEquals = true;
    }
  }
  return { end: -1, rawTextStart: rawTextStartInQuote };
}

function isSelfClosingTagRaw(raw: string): boolean {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith("/")) {
    return false;
  }
  const beforeSlash = trimmed[trimmed.length - 2];
  const tagBody = trimmed.slice(0, -1);
  let hasAttributeSeparator = false;
  for (const ch of tagBody) {
    if (isAsciiWhitespace(ch)) {
      hasAttributeSeparator = true;
      break;
    }
  }
  return (
    !beforeSlash ||
    isAsciiWhitespace(beforeSlash) ||
    beforeSlash === '"' ||
    beforeSlash === "'" ||
    !hasAttributeSeparator
  );
}

function readTagToken(html: string, start: number): ReadTagResult | null {
  if (html.startsWith("<!--", start)) {
    if (html[start + 4] === ">") {
      return {
        token: null,
        next: start + 5,
      };
    }
    if (html.startsWith("->", start + 4)) {
      return {
        token: null,
        next: start + 6,
      };
    }
    const commentEnd = html.indexOf("-->", start + 4);
    return {
      token: null,
      next: commentEnd === -1 ? html.length : commentEnd + 3,
    };
  }

  const tagEnd = findTagEnd(html, start);
  const end = tagEnd.end;
  if (end === -1) {
    if (tagEnd.rawTextStart !== undefined) {
      return {
        token: null,
        next: tagEnd.rawTextStart,
      };
    }
    return null;
  }

  let pos = start + 1;
  while (pos < end && isAsciiWhitespace(html[pos])) {
    pos += 1;
  }
  const closing = html[pos] === "/";
  if (closing) {
    pos += 1;
    while (pos < end && isAsciiWhitespace(html[pos])) {
      pos += 1;
    }
  }

  if (pos >= end || html[pos] === "!" || html[pos] === "?") {
    return {
      token: null,
      next: end + 1,
    };
  }

  const nameStart = pos;
  while (pos < end && isTagNameChar(html[pos])) {
    pos += 1;
  }
  if (pos === nameStart || !isTagNameStartChar(html[nameStart] ?? "")) {
    const rawTextStart = findRawTextOpenTagStart(html, start + 1, end + 1);
    if (rawTextStart !== -1) {
      return {
        token: null,
        next: rawTextStart,
      };
    }
    return {
      token: null,
      next: end + 1,
    };
  }

  const raw = html.slice(start + 1, end);
  return {
    token: {
      closing,
      name: html.slice(nameStart, pos).toLowerCase(),
      raw,
      selfClosing: isSelfClosingTagRaw(raw),
    },
    next: end + 1,
  };
}

function readAttributeValue(rawTag: string, name: string): string | undefined {
  const target = name.toLowerCase();
  let pos = 0;
  while (pos < rawTag.length && !isAsciiWhitespace(rawTag[pos])) {
    pos += 1;
  }
  while (pos < rawTag.length) {
    while (pos < rawTag.length && (isAsciiWhitespace(rawTag[pos]) || rawTag[pos] === "/")) {
      pos += 1;
    }
    const attrStart = pos;
    while (pos < rawTag.length && isTagNameChar(rawTag[pos])) {
      pos += 1;
    }
    if (pos === attrStart) {
      pos = skipUnsupportedAttribute(rawTag, pos);
      continue;
    }
    const attrName = rawTag.slice(attrStart, pos).toLowerCase();
    while (pos < rawTag.length && isAsciiWhitespace(rawTag[pos])) {
      pos += 1;
    }
    let value = "";
    if (rawTag[pos] === "=") {
      pos += 1;
      while (pos < rawTag.length && isAsciiWhitespace(rawTag[pos])) {
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
          !isAsciiWhitespace(rawTag[pos]) &&
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
  while (pos < rawTag.length && !isAsciiWhitespace(rawTag[pos])) {
    const quote = rawTag[pos];
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

function closeRawTextTagEnd(html: string, tagName: string, contentStart: number): number {
  let closeStart = html.indexOf("</", contentStart);
  while (closeStart !== -1) {
    if (startsWithClosingTag(html, closeStart, tagName)) {
      const closeEnd = findTagEnd(html, closeStart).end;
      return closeEnd === -1 ? html.length : closeEnd + 1;
    }
    closeStart = html.indexOf("</", closeStart + 2);
  }
  return html.length;
}

function skipRawTextElement(html: string, start: number, tagName: string): number {
  const openerEnd = findTagEnd(html, start);
  const contentStart = openerEnd.end === -1 ? start + tagName.length + 1 : openerEnd.end + 1;
  return closeRawTextTagEnd(html, tagName, contentStart);
}

function htmlFragmentToMarkdown(html: string): { text: string; title?: string } {
  const root: RenderContext = { kind: "root", parts: [] };
  const stack: RenderContext[] = [root];
  const state: { title?: string } = {};

  for (let i = 0; i < html.length; ) {
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

function stripTags(value: string): string {
  return htmlFragmentToMarkdown(value).text;
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
export function truncateText(
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
      stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)));
    return text ? { text, title: rendered.title } : null;
  }
  const text = stripInvisibleUnicode(rendered.text) || stripInvisibleUnicode(rendered.title ?? "");
  return text ? { text, title: rendered.title } : null;
}
