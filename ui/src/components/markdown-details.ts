import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/reasoning-tags.js";

export const MAX_MARKDOWN_DETAILS_DEPTH = 32;
const DISCLOSURE_TAG_RE = /<\/?(?:details|summary)(?=[\s>])[^>]*>/gi;
const DETAILS_OPEN_RE = /^<details( open)?>$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;
const SUMMARY_OPEN_RE = /^<summary>$/i;
const SUMMARY_CLOSE_RE = /^<\/summary>$/i;
const DETAILS_STACK = Symbol("markdownDetailsStack");

type DetailsFrame = { hasSummary: boolean };
type DetailsBlockState = StateBlock & { [DETAILS_STACK]?: DetailsFrame[] };

type MarkdownDisclosureTag = {
  end: number;
  raw: string;
  start: number;
};

type MarkdownDisclosureTagKind =
  | "details_open"
  | "details_open_expanded"
  | "details_close"
  | "summary_open"
  | "summary_close";

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isInsideMarkdownCode(
  index: number,
  codeSpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  return codeSpans.some(([start, end]) => index >= start && index < end);
}

export function markdownDisclosureTagKind(raw: string): MarkdownDisclosureTagKind | null {
  const detailsOpen = DETAILS_OPEN_RE.exec(raw);
  if (detailsOpen) {
    return detailsOpen[1] ? "details_open_expanded" : "details_open";
  }
  if (DETAILS_CLOSE_RE.test(raw)) {
    return "details_close";
  }
  if (SUMMARY_OPEN_RE.test(raw)) {
    return "summary_open";
  }
  return SUMMARY_CLOSE_RE.test(raw) ? "summary_close" : null;
}

/** Disclosure markup is structural only when it starts the current Markdown block line. */
export function scanMarkdownDisclosureLine(
  line: string,
  codeSpans: ReadonlyArray<readonly [number, number]> = findMarkdownCodeSpans(line),
  lineOffset = 0,
): MarkdownDisclosureTag[] | null {
  const first = /^[ \t]*<\/?(?:details|summary)(?=[\s>])/i.exec(line);
  if (!first) {
    return null;
  }
  const tags: MarkdownDisclosureTag[] = [];
  for (const match of line.matchAll(DISCLOSURE_TAG_RE)) {
    const start = match.index ?? 0;
    if (
      isEscapedMarkdownCharacter(line, start) ||
      isInsideMarkdownCode(lineOffset + start, codeSpans)
    ) {
      continue;
    }
    tags.push({ end: start + match[0].length, raw: match[0], start });
  }
  return tags.length > 0 ? tags : null;
}

function pushInlineParagraph(state: StateBlock, content: string, line: number): void {
  if (!content.trim()) {
    return;
  }
  const open = state.push("paragraph_open", "p", 1);
  open.map = [line, line + 1];
  const inline = state.push("inline", "", 0);
  inline.content = content;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push("paragraph_close", "p", -1);
}

function pushSummary(state: StateBlock, label: string, line: number): void {
  const open = state.push("summary_open", "summary", 1);
  open.map = [line, line + 1];
  const inline = state.push("inline", "", 0);
  inline.content = label;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push("summary_close", "summary", -1);
}

function detailsBlockRule(
  state: DetailsBlockState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) {
    return false;
  }
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  const end = state.eMarks[startLine] ?? state.src.length;
  const line = state.src.slice(start, end);
  const tags = scanMarkdownDisclosureLine(line);
  if (!tags) {
    return false;
  }
  if (silent) {
    return true;
  }

  const stack = (state[DETAILS_STACK] ??= []);
  const kinds = tags.map((tag) => markdownDisclosureTagKind(tag.raw));
  const nextSummaryClose = Array.from({ length: tags.length }, () => -1);
  let nearestSummaryClose = -1;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    nextSummaryClose[index] = nearestSummaryClose;
    if (kinds[index] === "summary_close") {
      nearestSummaryClose = index;
    }
  }
  let cursor = 0;
  let pendingText = "";
  const flushText = () => {
    pushInlineParagraph(state, pendingText, startLine);
    pendingText = "";
  };

  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag) {
      continue;
    }
    pendingText += line.slice(cursor, tag.start);

    const kind = kinds[index];
    if (
      (kind === "details_open" || kind === "details_open_expanded") &&
      stack.length < MAX_MARKDOWN_DETAILS_DEPTH
    ) {
      flushText();
      const token = state.push("details_open", "details", 1);
      if (kind === "details_open_expanded") {
        token.attrSet("open", "");
      }
      stack.push({ hasSummary: false });
    } else if (kind === "details_close" && stack.length > 0) {
      flushText();
      state.push("details_close", "details", -1);
      stack.pop();
    } else if (kind === "summary_open") {
      const frame = stack.at(-1);
      const closeIndex = nextSummaryClose[index] ?? -1;
      const close = closeIndex >= 0 ? tags[closeIndex] : undefined;
      if (frame && !frame.hasSummary && close) {
        flushText();
        pushSummary(state, line.slice(tag.end, close.start), startLine);
        frame.hasSummary = true;
        cursor = close.end;
        index = closeIndex;
        continue;
      }
      pendingText += tag.raw;
    } else {
      pendingText += tag.raw;
    }
    cursor = tag.end;
  }
  pendingText += line.slice(cursor);
  flushText();
  state.line = startLine + 1;
  return true;
}

export function installMarkdownDetails(markdownParser: MarkdownIt): void {
  markdownParser.block.ruler.before("html_block", "details_block", detailsBlockRule, {
    alt: ["paragraph", "reference", "blockquote"],
  });

  // Streaming can end with open details; balance only our structured tokens at EOF.
  markdownParser.core.ruler.after("block", "details_balance", (state) => {
    let depth = 0;
    for (const token of state.tokens) {
      if (token.type === "details_open") {
        depth += 1;
      } else if (token.type === "details_close") {
        depth = Math.max(0, depth - 1);
      }
    }
    while (depth > 0) {
      const token = new state.Token("details_close", "details", -1);
      token.block = true;
      state.tokens.push(token);
      depth -= 1;
    }
  });

  markdownParser.renderer.rules.details_open = (tokens, index) =>
    tokens[index]?.attrGet("open") === null ? "<details>" : "<details open>";
  markdownParser.renderer.rules.details_close = () => "</details>\n";
  markdownParser.renderer.rules.summary_open = () => "<summary>";
  markdownParser.renderer.rules.summary_close = () => "</summary>";
}
