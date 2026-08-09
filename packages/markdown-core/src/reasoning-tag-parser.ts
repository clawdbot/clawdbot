// Markdown Core owns provider-tag scanning and CommonMark/GFM ownership.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

export type ReasoningTagTextDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string };

export const REASONING_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "reasoning",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "antml:reasoning",
  "mm:think",
  "mm:thinking",
  "mm:thought",
  "mm:reasoning",
] as const;
export const REASONING_TAG_NAME_SET = new Set<string>(REASONING_TAG_NAMES);
const DISABLE_HTML_MARKDOWN = {
  disable: { null: ["htmlFlow", "htmlText"] },
};

type ReasoningTagMatch = {
  index: number;
  text: string;
  isClose: boolean;
  isSelfClosing: boolean;
};

type ReasoningTagScan = {
  tags: ReasoningTagMatch[];
  pendingStart?: number;
};

/** Scans quote-aware provider reasoning tags with iterative malformed recovery. */
export function scanReasoningTags(text: string, final = true): ReasoningTagScan {
  const tags: ReasoningTagMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start === -1) {
      break;
    }
    const parsed = parseReasoningTagAt(text, start, final);
    if (parsed.kind === "tag") {
      tags.push(parsed.tag);
      cursor = parsed.tag.index + parsed.tag.text.length;
      continue;
    }
    if (parsed.kind === "pending") {
      return { tags, pendingStart: start };
    }
    cursor = parsed.next;
  }
  return { tags };
}

type ParsedReasoningTag =
  | { kind: "tag"; tag: ReasoningTagMatch }
  | { kind: "pending" }
  | { kind: "invalid"; next: number };

export function parseReasoningTagAt(
  text: string,
  start: number,
  final: boolean,
): ParsedReasoningTag {
  let cursor = skipTagWhitespace(text, start + 1);
  let isClose = false;
  if (text.charAt(cursor) === "/") {
    isClose = true;
    cursor = skipTagWhitespace(text, cursor + 1);
  }

  const nameStart = cursor;
  while (cursor < text.length && isTagNameCharacter(text.charCodeAt(cursor))) {
    cursor += 1;
  }
  const partialName = text.slice(nameStart, cursor).toLowerCase();
  if (!partialName) {
    return cursor === text.length && !final ? { kind: "pending" } : invalidTag(text, start);
  }
  if (!REASONING_TAG_NAME_SET.has(partialName)) {
    const canBecomeKnown = REASONING_TAG_NAMES.some((name) => name.startsWith(partialName));
    return cursor === text.length && !final && canBecomeKnown
      ? { kind: "pending" }
      : invalidTag(text, start);
  }
  if (cursor === text.length) {
    return final ? invalidTag(text, start) : { kind: "pending" };
  }
  const boundary = text.charAt(cursor);
  if (!isTagWhitespace(boundary) && boundary !== "/" && boundary !== ">") {
    return invalidTag(text, start);
  }

  let quote: '"' | "'" | undefined;
  let lastSignificant = "";
  for (; cursor < text.length; cursor += 1) {
    const char = text.charAt(cursor);
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "<") {
      return invalidTag(text, start);
    }
    if (char === ">") {
      const end = cursor + 1;
      return {
        kind: "tag",
        tag: {
          index: start,
          text: text.slice(start, end),
          isClose,
          isSelfClosing: !isClose && lastSignificant === "/",
        },
      };
    }
    if (!isTagWhitespace(char)) {
      lastSignificant = char;
    }
  }
  return final ? invalidTag(text, start) : { kind: "pending" };
}

function invalidTag(text: string, start: number): ParsedReasoningTag {
  const nested = text.indexOf("<", start + 1);
  return { kind: "invalid", next: nested === -1 ? text.length : nested };
}

export function skipTagWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && isTagWhitespace(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

export function isTagWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

export function isTagNameCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x3a
  );
}

export function findNextLineEnding(text: string, start: number): number {
  const carriageReturn = text.indexOf("\r", start);
  const lineFeed = text.indexOf("\n", start);
  if (carriageReturn === -1) {
    return lineFeed;
  }
  return lineFeed === -1 ? carriageReturn : Math.min(carriageReturn, lineFeed);
}

type PositionedNode = {
  type?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: PositionedNode[];
};

type MarkdownOwnership = {
  codeSpans: Array<[number, number]>;
  retainStart: number;
};

export function parseMarkdownOwnership(text: string): MarkdownOwnership {
  if (!text) {
    return { codeSpans: [], retainStart: 0 };
  }
  const tree = fromMarkdown(text, {
    extensions: [DISABLE_HTML_MARKDOWN, gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as PositionedNode;
  const spans: Array<[number, number]> = [];
  const pending: PositionedNode[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        spans.push([start, end]);
      }
    }
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push(child);
      }
    }
  }
  const rootChildren = tree.children ?? [];
  return {
    codeSpans: spans.toSorted((left, right) => left[0] - right[0]),
    retainStart: rootChildren.at(-1)?.position?.start?.offset ?? text.length,
  };
}

/** Returns parser-owned CommonMark/GFM code ranges, including their delimiters. */
export function findMarkdownCodeSpans(text: string): Array<[number, number]> {
  return parseMarkdownOwnership(text).codeSpans;
}

export function isInsideCode(index: number, spans: Array<[number, number]>): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    if (!span) {
      return false;
    }
    if (index < span[0]) {
      high = middle - 1;
    } else if (index >= span[1]) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

type RecoveryMode = "hide" | "visible" | "static-strict" | "static-preserve";

export type ReductionState = {
  depth: number;
  visibleEver: boolean;
  pending?: {
    content: string;
    openTag: string;
    protectedClose: boolean;
    visibleBefore: boolean;
  };
};

type ReductionOptions = {
  final: boolean;
  mode: RecoveryMode;
  scope: "all" | "leading";
  start?: number;
};

export function reduceReasoningText(
  text: string,
  codeSpans: Array<[number, number]>,
  state: ReductionState,
  options: ReductionOptions,
): ReasoningTagTextDelta[] {
  const output: ReasoningTagTextDelta[] = [];
  const emit = (kind: ReasoningTagTextDelta["kind"], value: string) => {
    if (!value) {
      return;
    }
    const previous = output.at(-1);
    if (previous?.kind === kind) {
      previous.text += value;
    } else {
      output.push({ kind, text: value });
    }
    if (kind === "text" && value.trim()) {
      state.visibleEver = true;
    }
  };
  const append = (value: string) => {
    if (!value) {
      return;
    }
    if (state.depth > 0 && state.pending) {
      state.pending.content += value;
      state.pending.protectedClose ||= scanReasoningTags(value).tags.some((tag) => tag.isClose);
    } else {
      emit("text", value);
    }
  };

  const start = options.start ?? 0;
  const scan = scanReasoningTags(text.slice(start), options.final);
  const tags: ReasoningTagMatch[] = [];
  for (const scannedTag of scan.tags) {
    const tag = {
      index: scannedTag.index + start,
      isClose: scannedTag.isClose,
      isSelfClosing: scannedTag.isSelfClosing,
      text: scannedTag.text,
    };
    if (!isInsideCode(tag.index, codeSpans)) {
      tags.push(tag);
    }
  }
  const hasCloseAfter: boolean[] = [];
  if (options.scope === "leading") {
    let seenClose = false;
    for (let index = tags.length - 1; index >= 0; index -= 1) {
      hasCloseAfter[index] = seenClose;
      seenClose ||= tags[index]?.isClose === true;
    }
  }
  let cursor = start;

  for (let tagIndex = 0; tagIndex < tags.length; tagIndex += 1) {
    const tag = tags[tagIndex];
    if (!tag) {
      continue;
    }
    const beforeTag = text.slice(cursor, tag.index);
    append(beforeTag);
    const tagEnd = tag.index + tag.text.length;

    if (tag.isSelfClosing) {
      if (state.depth === 0 && options.scope === "leading" && state.visibleEver) {
        emit("text", text.slice(tag.index));
        cursor = text.length;
        break;
      }
      cursor = tagEnd;
      continue;
    }

    if (!tag.isClose) {
      if (
        state.depth === 0 &&
        options.scope === "leading" &&
        state.visibleEver &&
        !hasCloseAfter[tagIndex]
      ) {
        emit("text", text.slice(tag.index));
        cursor = text.length;
        break;
      }
      if (state.depth === 0) {
        state.pending = {
          content: "",
          openTag: tag.text,
          protectedClose: false,
          visibleBefore: state.visibleEver,
        };
      }
      state.depth += 1;
      cursor = tagEnd;
      continue;
    }

    if (state.depth > 0) {
      state.depth -= 1;
      if (state.depth === 0 && state.pending) {
        emit("thinking", state.pending.content);
        state.pending = undefined;
      } else if (state.pending) {
        state.pending.protectedClose = true;
      }
      cursor = tagEnd;
      continue;
    }

    if (options.mode === "visible") {
      append(tag.text);
    } else {
      const after = text.slice(tagEnd);
      if (beforeTag.trim() && after.trim()) {
        const thinking = output.filter((delta) => delta.kind === "thinking");
        output.splice(0, output.length, ...thinking);
        state.visibleEver = false;
      }
    }
    cursor = tagEnd;
  }

  append(text.slice(cursor));
  if (options.final && state.depth > 0 && state.pending) {
    const pending = state.pending;
    const recoverAsText =
      options.mode === "static-preserve" ||
      (options.mode === "static-strict" && !pending.visibleBefore && !pending.protectedClose) ||
      (options.mode === "visible" && !pending.protectedClose);
    if (recoverAsText) {
      const value =
        options.mode === "visible" && pending.visibleBefore
          ? pending.openTag + pending.content
          : pending.content;
      emit("text", value);
    } else {
      emit("thinking", pending.content);
    }
    state.depth = 0;
    state.pending = undefined;
  }
  return output;
}

type ReasoningTagStripOptions = {
  mode: "strict" | "preserve";
  scope: "all" | "leading";
};

/** Strips reasoning tags using the same reducer as streamed partitioning. */
export function stripReasoningTagsFromMarkdown(
  text: string,
  options: ReasoningTagStripOptions,
): string {
  const state: ReductionState = { depth: 0, visibleEver: false };
  return reduceReasoningText(text, findMarkdownCodeSpans(text), state, {
    final: true,
    mode: options.mode === "preserve" ? "static-preserve" : "static-strict",
    scope: options.scope,
  })
    .filter((delta) => delta.kind === "text")
    .map((delta) => delta.text)
    .join("");
}
