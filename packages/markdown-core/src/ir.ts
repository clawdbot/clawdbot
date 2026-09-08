import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import MarkdownIt, {
  type MarkdownIt as MarkdownItParser,
  type StateCore,
  type StateInline,
} from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import {
  ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE,
  markdownItAssistantTranscriptRoles,
  type AssistantTranscriptRoleImageMeta,
  type AssistantTranscriptRoleTokenMeta,
} from "./assistant-transcript.js";
import { chunkText } from "./chunk-text.js";
import { matchMarkdownHtmlTag, tokenizeHtmlTags } from "./html-tags.js";
import { appendAssistantTranscriptRoleText, appendImageAlternative } from "./ir-annotations.js";
import {
  appendHtmlTags,
  copyHtmlTags,
  defineMetadata,
  RAW_HTML_TOKEN_TYPE,
  type MarkdownHtmlMetadata,
} from "./ir-metadata.js";
import { computeNextMappedBlockStarts, sourceBlockNewlineCount } from "./ir-source-spacing.js";
import {
  clampAnnotationSpans,
  clampLinkSpans,
  clampStyleSpans,
  copyMarkdownLinkSpan,
  createMarkdownLinkSpan,
  createStyleSpan,
  mergeAnnotationSpans,
  mergeStyleSpans,
  sliceAnnotationSpans,
  sliceLinkSpans,
  sliceStyleSpans,
  type MarkdownAnnotationSpan,
  type MarkdownLinkSpan,
  type MarkdownStyle,
  type MarkdownStyleSpan,
} from "./ir-spans.js";
import { renderMarkdownCodeTable, renderMarkdownTableBullets } from "./table-layout.js";
import type { MarkdownTableMode } from "./types.js";

export type { MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir-spans.js";

type ListState = {
  type: "bullet" | "ordered";
  index: number;
  openLevel: number;
  id: number;
  parentId?: number;
};

type LinkState = {
  href: string;
  labelStart: number;
  autoLinked: boolean;
};

const INLINE_STYLE_BY_TOKEN = new Map<string, MarkdownStyle>([
  ["underline_open", "underline"],
  ["underline_close", "underline"],
  ["em_open", "italic"],
  ["em_close", "italic"],
  ["strong_open", "bold"],
  ["strong_close", "bold"],
  ["s_open", "strikethrough"],
  ["s_close", "strikethrough"],
  ["spoiler_open", "spoiler"],
  ["spoiler_close", "spoiler"],
]);

const HEADING_STYLE_BY_TAG = new Map<string, MarkdownStyle>([
  ["h1", "heading_1"],
  ["h2", "heading_2"],
  ["h3", "heading_3"],
  ["h4", "heading_4"],
  ["h5", "heading_5"],
  ["h6", "heading_6"],
]);

type RenderEnv = {
  assistantTranscriptRoleHeaders?: boolean;
  assistantTranscriptRolePreserveLinks?: boolean;
  listStack: ListState[];
  tableSourceColumns?: Map<number, number>;
};

type MarkdownToken = {
  type: string;
  tag?: string;
  content?: string;
  info?: string;
  children?: MarkdownToken[];
  attrs?: [string, string][];
  attrGet?: (name: string) => string | null;
  hidden?: boolean;
  level?: number;
  map?: [number, number] | null;
  markup?: string;
  meta?: unknown;
  taskListMarker?: boolean;
};

type MarkdownListItemMarker = {
  kind: "bullet" | "ordered";
  listMarker?: { start: number; end: number };
  task?: true;
  taskMarker?: { start: number; end: number };
  /** Parser-owned identity and rendered span for block-native list emitters. */
  listId?: number;
  parentListId?: number;
  depth?: number;
  start?: number;
  end?: number;
};

type MarkdownListItemMetadata = {
  /** Rendered content owned by this item after its native marker. */
  contentStart?: number;
  contentEnd?: number;
  /** True when the source marker line itself contains no item content. */
  markerOnly?: true;
  /** Original Markdown source ownership, attached without changing legacy serialization. */
  sourceMarker?: { start: number; end: number };
  sourceContent?: { start: number; end: number };
  sourceIndent?: number;
  sourceStartLine?: number;
  sourceEndLine?: number;
};

type MarkdownListItemWithMetadata = MarkdownListItemMarker & MarkdownListItemMetadata;

type MarkdownBlockSpan = {
  kind: "blockquote" | "code_block" | "heading" | "thematic_break";
  start: number;
  end: number;
  /** Parser-owned container nesting depth, starting at one. */
  depth: number;
  blockquoteDepth?: number;
  codeOrigin?: "fenced" | "indented";
  codeClosed?: boolean;
  headingLevel?: number;
  headingOrigin?: "atx" | "setext";
  language?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
};

export type MarkdownIR = MarkdownHtmlMetadata & {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
  annotations?: MarkdownAnnotationSpan[];
  listItems?: MarkdownListItemMarker[];
};

type MarkdownIRWithMetadata = MarkdownIR & {
  /** Parser-owned block metadata, attached without changing legacy serialization. */
  blocks?: MarkdownBlockSpan[];
};

type MarkdownTableAlignment = "left" | "center" | "right";

export type MarkdownTableData = {
  headers: string[];
  rows: string[][];
  aligns?: (MarkdownTableAlignment | undefined)[];
};

export type MarkdownTableCell = MarkdownHtmlMetadata & {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
  annotations?: MarkdownAnnotationSpan[];
};

export type MarkdownTableMeta = MarkdownTableData & {
  placeholderOffset: number;
  headerCells: MarkdownTableCell[];
  rowCells: MarkdownTableCell[][];
};

type MarkdownTableSource = {
  start: number;
  end: number;
  prefix: string;
  headers: string[];
  rows: string[][];
};
type MarkdownTableWithSource = MarkdownTableMeta & { source?: MarkdownTableSource };

/** Private source coordinates do not change the serialized native-table payload. */
export function getMarkdownTableSource(table: MarkdownTableWithSource) {
  return table.source;
}

type OpenStyle = {
  style: MarkdownStyle;
  start: number;
};

type RenderTarget = {
  text: string;
  styles: MarkdownStyleSpan[];
  openStyles: OpenStyle[];
  links: MarkdownLinkSpan[];
  linkStack: LinkState[];
  annotations: MarkdownAnnotationSpan[];
};

type TableCell = MarkdownTableCell;

type TableState = {
  sourceLines?: [number, number];
  sourceHeaders: string[];
  sourceRows: string[][];
  currentSourceRow: string[];
  headers: TableCell[];
  rows: TableCell[][];
  aligns: (MarkdownTableAlignment | undefined)[];
  currentRow: TableCell[];
  currentCell: RenderTarget | null;
  inHeader: boolean;
};

type RenderState = RenderTarget & {
  env: RenderEnv;
  headingStyle: "none" | "bold" | "rich";
  blockquotePrefix: string;
  enableSpoilers: boolean;
  tableMode: MarkdownTableMode;
  table: TableState | null;
  hasTables: boolean;
  collectedTables: MarkdownTableMeta[];
  horizontalRuleText: string;
  preserveSourceBlockSpacing: boolean;
  headingLineEnd: number | undefined;
  listItems: MarkdownListItemWithMetadata[];
  openListItems: MarkdownListItemWithMetadata[];
  nextListId: number;
  blocks: MarkdownBlockSpan[];
  headingBlock: MarkdownBlockSpan | undefined;
  blockquoteStack: Array<{
    start: number;
    depth: number;
    blockquoteDepth: number;
    sourceStartLine?: number;
    sourceEndLine?: number;
  }>;
  source: string;
  sourceIndex: ReturnType<typeof indexSourceLines> | undefined;
};

function attachListItemMetadata(
  item: MarkdownListItemMarker,
  metadata: MarkdownListItemMetadata,
): MarkdownListItemWithMetadata {
  const itemWithMetadata = item as MarkdownListItemWithMetadata;
  for (const key of [
    "contentStart",
    "contentEnd",
    "markerOnly",
    "sourceMarker",
    "sourceContent",
    "sourceIndent",
    "sourceStartLine",
    "sourceEndLine",
  ] as const) {
    defineMetadata(itemWithMetadata, key, metadata[key]);
  }
  return itemWithMetadata;
}

function attachBlockMetadata(ir: MarkdownIR, blocks: MarkdownBlockSpan[]): MarkdownIR {
  if (blocks.length > 0) {
    defineMetadata(ir as MarkdownIRWithMetadata, "blocks", blocks);
  }
  return ir;
}

export type MarkdownParseOptions = {
  /** Mark assistant-authored transcript-role headers after Markdown parsing. */
  assistantTranscriptRoleHeaders?: boolean;
  linkify?: boolean;
  enableSpoilers?: boolean;
  /** Parse authored HTML <u>/<ins> tags into underline spans. */
  enableHtmlUnderline?: boolean;
  /** Preserve task-list checkboxes as semantic list markers. */
  enableTaskLists?: boolean;
  headingStyle?: "none" | "bold" | "rich";
  blockquotePrefix?: string;
  autolink?: boolean;
  /** How to render tables (off|bullets|code|block). Default: off. */
  tableMode?: MarkdownTableMode;
  /** Visible text emitted for a thematic break. Default: ───. */
  horizontalRuleText?: string;
  /** Preserve source line spacing after headings and code blocks. */
  preserveSourceBlockSpacing?: boolean;
  /**
   * Treat Python-style `__name__` member, call, argument, and index identifiers as literal text
   * instead of emphasis delimiters. Disabled by default.
   */
  preserveDunderIdentifiers?: boolean;
};

function appendHeadingSeparator(state: RenderState, nextBlockStart: number | undefined) {
  const newlineCount = sourceBlockNewlineCount(
    state.preserveSourceBlockSpacing,
    nextBlockStart,
    state.headingLineEnd,
  );
  if (newlineCount === undefined) {
    appendParagraphSeparator(state, undefined, nextBlockStart);
    return;
  }
  if (newlineCount > 0) {
    state.text += "\n".repeat(newlineCount);
  }
  state.headingLineEnd = undefined;
}

// These seven parser switches bound the prepared configurations to 128 entries.
// Parse state and rendered options remain local to each markdownToIRWithMeta call.
const markdownParsers = new Map<number, MarkdownItParser>();

function createMarkdownIt(options: MarkdownParseOptions): MarkdownItParser {
  const key =
    ((options.linkify ?? true) ? 1 : 0) |
    (options.preserveDunderIdentifiers ? 2 : 0) |
    (options.enableTaskLists ? 4 : 0) |
    (options.enableHtmlUnderline ? 8 : 0) |
    (options.enableSpoilers ? 16 : 0) |
    (options.tableMode && options.tableMode !== "off" ? 32 : 0) |
    (options.autolink === false ? 64 : 0);
  const prepared = markdownParsers.get(key);
  if (prepared) {
    return prepared;
  }
  const md = new MarkdownIt({
    html: false,
    linkify: options.linkify ?? true,
    breaks: false,
    typographer: false,
  });
  md.linkify.set({ fuzzyLink: true });
  md.use(markdownItCjkFriendly);
  md.use(markdownItAssistantTranscriptRoles);
  if (options.preserveDunderIdentifiers) {
    md.inline.ruler.before(
      "emphasis",
      "markdown_core_dunder_identifiers",
      preserveDunderIdentifier,
    );
  }
  if (options.enableTaskLists) {
    md.core.ruler.before("inline", "markdown_core_task_lists", protectTaskListMarkers);
  }
  const enableHtmlUnderline = options.enableHtmlUnderline === true;
  md.inline.ruler.before("html_inline", RAW_HTML_TOKEN_TYPE, (state, silent) =>
    parseHtmlLexeme(state, silent, enableHtmlUnderline),
  );
  if (options.enableSpoilers) {
    // Spoiler delimiters can surround a line-leading role header. Normalize
    // them before semantic detection so later rendering cannot expose a role
    // boundary that the assistant annotation pass never saw.
    md.core.ruler.before("assistant_transcript_roles", "markdown_core_spoilers", (state) => {
      applySpoilerTokens(state.tokens as MarkdownToken[]);
    });
  }
  md.enable("strikethrough");
  if (options.tableMode && options.tableMode !== "off") {
    md.enable("table");
    md.block.ruler.before("table", "markdown_core_table_source", (state, line, _end, silent) => {
      // SAFETY: markdownToIRWithMeta creates and passes this parser's RenderEnv.
      const env = state.env as RenderEnv;
      if (!silent && env.tableSourceColumns) {
        const start = (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0);
        env.tableSourceColumns.set(line, start - state.src.lastIndexOf("\n", start - 1) - 1);
      }
      return false;
    });
  } else {
    md.disable("table");
  }
  if (options.autolink === false) {
    md.disable("autolink");
  }
  markdownParsers.set(key, md);
  return md;
}

function preserveDunderIdentifier(state: StateInline, silent: boolean): boolean {
  const match = /^__[\p{L}_][\p{L}\p{N}_]*__/u.exec(state.src.slice(state.pos, state.posMax));
  if (!match) {
    return false;
  }
  const identifier = match[0];
  const end = state.pos + identifier.length;
  const before = state.src[state.pos - 1];
  const beforeBefore = state.src[state.pos - 2];
  const after = end < state.posMax ? state.src[end] : undefined;
  const member = before === ".";
  const call = after === "(";
  const functionArgument = before === "(" && /[\p{L}\p{N}_]/u.test(beforeBefore ?? "");
  const index = after === "[";
  if (!member && !call && !functionArgument && !index) {
    return false;
  }
  // markdown-it also invokes matching rules silently while scanning labels;
  // both modes must consume the same source span.
  if (!silent) {
    state.push("text", "", 0).content = identifier;
  }
  state.pos = end;
  return true;
}

function protectTaskListMarkers(state: StateCore): void {
  const stack: Array<{ contentStarted: boolean }> = [];
  for (const token of state.tokens as MarkdownToken[]) {
    if (token.type === "list_item_open") {
      stack.push({ contentStarted: false });
      continue;
    }
    if (token.type === "list_item_close") {
      stack.pop();
      continue;
    }
    const item = stack.at(-1);
    if (!item || item.contentStarted) {
      continue;
    }
    if (token.type === "inline") {
      item.contentStarted = true;
      if (/^\[[ xX]\](?:[ \t]|\n|$)/u.test(token.content ?? "")) {
        token.taskListMarker = true;
        token.content = `\\${token.content}`;
      }
      continue;
    }
    if (token.type !== "paragraph_open") {
      item.contentStarted = true;
    }
  }
}

function parseHtmlLexeme(state: StateInline, silent: boolean, enableUnderline: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c) {
    return false;
  }
  const raw = matchMarkdownHtmlTag(state.src.slice(state.pos));
  if (!raw) {
    return false;
  }
  const tag = tokenizeHtmlTags(raw).next().value;
  const underlineTag =
    enableUnderline && tag && (tag.name === "u" || tag.name === "ins") ? tag : undefined;
  if (!silent) {
    const token = state.push(
      !underlineTag || underlineTag.selfClosing
        ? RAW_HTML_TOKEN_TYPE
        : underlineTag.closing
          ? "underline_close"
          : "underline_open",
      "",
      0,
    );
    if (!underlineTag || underlineTag.selfClosing) {
      // Preserve the complete lexeme before entity decoding or text joining; raw
      // anchors intentionally leave linkLevel unchanged so their bodies still linkify.
      token.content = raw;
      if (tag) {
        defineMetadata(token, "htmlTags", [tag]);
      }
    }
  }
  state.pos += raw.length;
  return true;
}

function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) {
    return token.attrGet(name);
  }
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) {
        return value;
      }
    }
  }
  return null;
}

function markdownTableAlignmentFromToken(token: MarkdownToken): MarkdownTableAlignment | undefined {
  const value = getAttr(token, "style") ?? "";
  if (/text-align\s*:\s*left/i.test(value)) {
    return "left";
  }
  if (/text-align\s*:\s*center/i.test(value)) {
    return "center";
  }
  if (/text-align\s*:\s*right/i.test(value)) {
    return "right";
  }
  return undefined;
}

function createTextToken(base: MarkdownToken, content: string): MarkdownToken {
  return { ...base, type: "text", content, children: undefined };
}

function applySpoilerTokens(tokens: MarkdownToken[]): void {
  for (const token of tokens) {
    if (token.children && token.children.length > 0) {
      token.children = injectSpoilersIntoInline(token.children);
    }
  }
}

function injectSpoilersIntoInline(tokens: MarkdownToken[]): MarkdownToken[] {
  let totalDelims = 0;
  for (const token of tokens) {
    if (token.type !== "text") {
      continue;
    }
    const content = token.content ?? "";
    let i = 0;
    while (i < content.length) {
      const next = content.indexOf("||", i);
      if (next === -1) {
        break;
      }
      totalDelims += 1;
      i = next + 2;
    }
  }

  if (totalDelims < 2) {
    return tokens;
  }
  const usableDelims = totalDelims - (totalDelims % 2);

  const result: MarkdownToken[] = [];
  const state = { spoilerOpen: false };
  let consumedDelims = 0;

  for (const token of tokens) {
    if (token.type !== "text") {
      result.push(token);
      continue;
    }

    const content = token.content ?? "";
    if (!content.includes("||")) {
      result.push(token);
      continue;
    }

    let index = 0;
    while (index < content.length) {
      const next = content.indexOf("||", index);
      if (next === -1) {
        if (index < content.length) {
          result.push(createTextToken(token, content.slice(index)));
        }
        break;
      }
      if (consumedDelims >= usableDelims) {
        result.push(createTextToken(token, content.slice(index)));
        break;
      }
      if (next > index) {
        result.push(createTextToken(token, content.slice(index, next)));
      }
      consumedDelims += 1;
      state.spoilerOpen = !state.spoilerOpen;
      result.push({
        type: state.spoilerOpen ? "spoiler_open" : "spoiler_close",
      });
      index = next + 2;
    }
  }

  return result;
}

function initRenderTarget(): RenderTarget {
  return {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
    annotations: [],
  };
}

function resolveRenderTarget(state: RenderState): RenderTarget {
  return state.table?.currentCell ?? state;
}

function appendText(state: RenderState, value: string, provenance?: object) {
  if (!value) {
    return;
  }
  const target = resolveRenderTarget(state);
  appendHtmlTags(target, provenance, target.text.length);
  target.text += value;
}

function openStyle(state: RenderState, style: MarkdownStyle) {
  const target = resolveRenderTarget(state);
  target.openStyles.push({ style, start: target.text.length });
}

function closeStyle(
  state: RenderState,
  style: MarkdownStyle,
  options?: { trimTrailingParagraphSeparator?: boolean },
) {
  const target = resolveRenderTarget(state);
  for (let i = target.openStyles.length - 1; i >= 0; i -= 1) {
    const open = target.openStyles.at(i);
    if (open?.style === style) {
      const start = open.start;
      target.openStyles.splice(i, 1);
      const end =
        options?.trimTrailingParagraphSeparator && target.text.endsWith("\n\n")
          ? target.text.length - 2
          : target.text.length;
      if (end > start) {
        target.styles.push({ start, end, style });
      }
      return;
    }
  }
}

function appendParagraphSeparator(
  state: RenderState,
  token?: MarkdownToken,
  nextBlockStart?: number,
) {
  if (state.table) {
    return;
  } // Don't add paragraph separators inside tables
  if (state.env.listStack.length > 0) {
    const currentList = state.env.listStack[state.env.listStack.length - 1];
    const directListParagraphLevel = (currentList?.openLevel ?? 0) + 2;
    const itemEnd = state.openListItems.at(-1)?.sourceEndLine;
    // Tight wrappers still separate sibling blocks inside their owning item.
    // Item transitions keep their existing spacing at list_item_close.
    const hasFollowingBlock =
      nextBlockStart !== undefined && itemEnd !== undefined && nextBlockStart < itemEnd;
    if (
      !hasFollowingBlock &&
      (token?.type !== "paragraph_close" ||
        token.hidden ||
        token.level !== directListParagraphLevel)
    ) {
      return;
    }
  }
  state.text += token?.hidden ? "\n" : "\n\n";
}

function appendTopLevelListSeparator(state: RenderState) {
  const trailingNewlines = state.text.match(/\n*$/)?.[0].length ?? 0;
  if (trailingNewlines < 2) {
    state.text += "\n";
  }
}

function appendNestedListSeparator(state: RenderState) {
  if (!state.text.endsWith("\n")) {
    state.text += "\n";
  }
}

function appendListPrefix(
  state: RenderState,
  isTask: boolean,
): MarkdownListItemWithMetadata | undefined {
  const stack = state.env.listStack;
  const top = stack[stack.length - 1];
  if (!top) {
    return undefined;
  }
  top.index += 1;
  const itemStart = state.text.length;
  const indent = "  ".repeat(Math.max(0, stack.length - 1));
  const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
  state.text += indent;
  const markerStart = state.text.length;
  state.text += prefix;
  return {
    kind: top.type,
    listMarker: { start: markerStart, end: state.text.length },
    listId: top.id,
    ...(top.parentId !== undefined ? { parentListId: top.parentId } : {}),
    depth: stack.length - 1,
    start: itemStart,
    ...(isTask ? { task: true as const } : {}),
  };
}

function recordTaskMarker(state: RenderState, content: string): void {
  const item = state.openListItems.at(-1);
  if (!item?.task || item.taskMarker) {
    return;
  }
  const marker = /^\[[ xX]\][ \t]?/u.exec(content)?.[0];
  if (marker) {
    const start = resolveRenderTarget(state).text.length;
    item.taskMarker = { start, end: start + marker.length };
  }
}

function recordListSourceMetadata(
  state: RenderState,
  item: MarkdownListItemWithMetadata,
  token: MarkdownToken,
): void {
  if (!token.map) {
    return;
  }
  const { lines, starts, openedByLine } = (state.sourceIndex ??= indexSourceLines(state.source));
  const [startLine, endLine] = token.map;
  item.sourceStartLine = startLine;
  item.sourceEndLine = endLine;
  const line = lines[startLine] ?? "";
  const candidates = [...line.matchAll(/(?:^|[\t >])([-*+]|\d{1,9}[.)])(?=[\t ]|$)/gu)];
  const markerIndex = openedByLine.get(startLine) ?? 0;
  openedByLine.set(startLine, markerIndex + 1);
  const candidate = candidates[Math.min(markerIndex, candidates.length - 1)];
  const marker = candidate?.[1];
  if (!candidate || !marker) {
    return;
  }
  const markerOffset = candidate.index + candidate[0].lastIndexOf(marker);
  const markerEnd = markerOffset + marker.length;
  let paddingEnd = markerEnd;
  while (paddingEnd < line.length && /[\t ]/u.test(line[paddingEnd] ?? "")) {
    paddingEnd += 1;
  }
  const markerColumn = markdownSourceColumn(line.slice(0, markerEnd));
  const paddingColumns = markdownSourceColumn(line.slice(0, paddingEnd)) - markerColumn;
  item.sourceIndent =
    markerColumn + (paddingColumns === 0 || paddingColumns > 4 ? 1 : paddingColumns);
  const contentOffset = paddingColumns > 4 ? Math.min(markerEnd + 1, paddingEnd) : paddingEnd;
  const lineStart = starts[startLine] ?? 0;
  item.sourceMarker = {
    start: lineStart + markerOffset,
    end: lineStart + markerOffset + marker.length,
  };
  item.sourceContent = {
    start: lineStart + contentOffset,
    end: starts[endLine] ?? state.source.length,
  };
  if (!line.slice(contentOffset).replace(/[ \t\r\n]/gu, "")) {
    item.markerOnly = true;
  }
}

function renderInlineCode(state: RenderState, content: string) {
  if (!content) {
    return;
  }
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  target.text += content;
  target.styles.push({ start, end: start + content.length, style: "code" });
}

function resolveFenceLanguage(info: string | undefined): string | undefined {
  const language = info?.trim().split(/\s+/, 1)[0]?.trim();
  return language || undefined;
}

function renderCodeBlock(
  state: RenderState,
  content: string,
  info: string | undefined,
  sourceNewlineCount: number | undefined,
  origin: "fenced" | "indented",
  sourceMap?: [number, number] | null,
  codeClosed?: boolean,
) {
  let code = content ?? "";
  if (!code.endsWith("\n")) {
    code = `${code}\n`;
  }
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  const language = resolveFenceLanguage(info);
  target.text += code;
  target.styles.push(
    createStyleSpan({
      start,
      end: start + code.length,
      style: "code_block",
      language,
    }),
  );
  state.blocks.push({
    kind: "code_block",
    start,
    end: start + code.length,
    depth: state.env.listStack.length + state.blockquoteStack.length + 1,
    blockquoteDepth: state.blockquoteStack.length,
    codeOrigin: origin,
    ...(codeClosed !== undefined ? { codeClosed } : {}),
    ...(language ? { language } : {}),
    ...(sourceMap ? { sourceStartLine: sourceMap[0], sourceEndLine: sourceMap[1] } : {}),
  });
  if (state.env.listStack.length === 0) {
    const extraNewlines =
      sourceNewlineCount === undefined ? 1 : Math.max(0, sourceNewlineCount - 1);
    target.text += "\n".repeat(extraNewlines);
  }
}

function isFenceClosed(token: MarkdownToken): boolean {
  const sourceLines = (token.map?.[1] ?? 0) - (token.map?.[0] ?? 0);
  const content = token.content ?? "";
  const payloadLines =
    (content.match(/\n/gu)?.length ?? 0) + (content && !content.endsWith("\n") ? 1 : 0);
  return sourceLines >= payloadLines + 2;
}

function markdownSourceColumn(text: string): number {
  let column = 0;
  for (const character of text) {
    column += character === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

function handleLinkClose(state: RenderState) {
  const target = resolveRenderTarget(state);
  const link = target.linkStack.pop();
  if (!link?.href) {
    return;
  }
  const href = link.href.trim();
  if (!href) {
    return;
  }
  const start = link.labelStart;
  const end = target.text.length;
  const span = createMarkdownLinkSpan({ start, end, href }, { autoLinked: link.autoLinked });
  target.links.push(span);
}

function initTableState(): TableState {
  return {
    sourceHeaders: [],
    sourceRows: [],
    currentSourceRow: [],
    headers: [],
    rows: [],
    aligns: [],
    currentRow: [],
    currentCell: null,
    inHeader: false,
  };
}

function finishTableCell(cell: RenderTarget): TableCell {
  closeRemainingStyles(cell);
  return copyHtmlTags(cell, {
    text: cell.text,
    styles: cell.styles,
    links: cell.links,
    ...(cell.annotations.length > 0 ? { annotations: cell.annotations } : {}),
  });
}

function trimCell(cell: TableCell): TableCell {
  const text = cell.text;
  let start = text.length - text.trimStart().length;
  let end = text.trimEnd().length;
  // Code owns its edge whitespace; only surrounding cell padding may be trimmed.
  for (const span of cell.styles) {
    if (span.style === "code") {
      start = Math.min(start, span.start);
      end = Math.max(end, span.end);
    }
  }
  return start === 0 && end === text.length ? cell : sliceMarkdownIR(cell, start, end);
}

function appendCell(state: RenderState, cell: TableCell) {
  if (!cell.text) {
    return;
  }
  const start = state.text.length;
  appendHtmlTags(state, cell, start);
  state.text += cell.text;
  for (const span of cell.styles) {
    state.styles.push({
      start: start + span.start,
      end: start + span.end,
      style: span.style,
    });
  }
  for (const link of cell.links) {
    state.links.push(
      copyMarkdownLinkSpan(link, {
        start: start + link.start,
        end: start + link.end,
      }),
    );
  }
  for (const annotation of cell.annotations ?? []) {
    state.annotations.push({
      ...annotation,
      start: start + annotation.start,
      end: start + annotation.end,
    });
  }
}

function collectTableBlock(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headerCells = state.table.headers.map(trimCell);
  const rowCells = state.table.rows.map((row) => row.map(trimCell));
  const table: MarkdownTableWithSource = {
    headers: headerCells.map((cell) => cell.text),
    rows: rowCells.map((row) => row.map((cell) => cell.text)),
    headerCells,
    rowCells,
    placeholderOffset: state.text.length,
    ...(state.table.aligns.some(Boolean) ? { aligns: [...state.table.aligns] } : {}),
  };
  state.collectedTables.push(table);
  if (state.table.sourceLines) {
    const [first, after] = state.table.sourceLines;
    const { lines, starts } = (state.sourceIndex ??= indexSourceLines(state.source));
    const column = state.env.tableSourceColumns?.get(first) ?? 0;
    defineMetadata(table, "source", {
      start: (starts[first] ?? 0) + column,
      end: (starts[after - 1] ?? 0) + (lines[after - 1]?.length ?? 0),
      // Continue list markers as indentation while retaining enclosing quote markers.
      prefix: (lines[first] ?? "").slice(0, column).replace(/[^\t >]/gu, " "),
      headers: state.table.sourceHeaders,
      rows: state.table.sourceRows,
    });
  }
}

function renderTableAsBullets(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));
  renderMarkdownTableBullets(
    headers,
    rows,
    (text) => {
      state.text += text;
    },
    (cell, rowLabel) => {
      const start = state.text.length;
      appendCell(state, cell);
      if (rowLabel) {
        state.styles.push({ start, end: state.text.length, style: "bold" });
      }
    },
  );
}

function renderTableAsCode(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map((cell) => trimCell(cell).text);
  const rows = state.table.rows.map((row) => row.map((cell) => trimCell(cell).text));
  const code = renderMarkdownCodeTable(headers, rows);
  if (!code) {
    return;
  }
  const start = state.text.length;
  state.text += code;
  state.styles.push({ start, end: state.text.length, style: "code_block" });
  if (state.env.listStack.length === 0) {
    state.text += "\n";
  }
}

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  const nextMappedBlockStarts = computeNextMappedBlockStarts(tokens);
  for (const [tokenIndex, token] of tokens.entries()) {
    const inlineStyle = INLINE_STYLE_BY_TOKEN.get(token.type);
    if (inlineStyle) {
      if (inlineStyle !== "spoiler" || state.enableSpoilers) {
        if (token.type.endsWith("_open")) {
          openStyle(state, inlineStyle);
        } else {
          closeStyle(state, inlineStyle);
        }
      }
      continue;
    }
    switch (token.type) {
      case "inline":
        if (state.table?.currentCell) {
          state.table.currentSourceRow.push(token.content ?? "");
        }
        if (token.children) {
          renderTokens(token.children, state);
        }
        break;
      case "text":
        recordTaskMarker(state, token.content ?? "");
        appendText(state, token.content ?? "", token);
        break;
      case ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE: {
        const meta = (token.meta as AssistantTranscriptRoleTokenMeta | undefined)
          ?.assistantTranscriptRoleHeader;
        if (meta) {
          const target = resolveRenderTarget(state);
          appendHtmlTags(target, token, target.text.length);
          appendAssistantTranscriptRoleText(target, token.content ?? "", meta);
        } else {
          appendText(state, token.content ?? "", token);
        }
        break;
      }
      case "code_inline":
        renderInlineCode(state, token.content ?? "");
        break;
      case "link_open": {
        const target = resolveRenderTarget(state);
        const href = getAttr(token, "href") ?? "";
        target.linkStack.push({
          href,
          labelStart: target.text.length,
          autoLinked: token.markup === "linkify",
        });
        break;
      }
      case "link_close":
        handleLinkClose(state);
        break;
      case "image": {
        const meta = (token.meta as AssistantTranscriptRoleImageMeta | undefined)
          ?.assistantTranscriptRoleImage;
        appendImageAlternative(
          resolveRenderTarget(state),
          meta ?? { text: token.content ?? "", spans: [] },
        );
        break;
      }
      case "softbreak":
      case "hardbreak":
        appendText(state, "\n");
        break;
      case "paragraph_close":
        appendParagraphSeparator(state, token, nextMappedBlockStarts[tokenIndex]);
        break;
      case "heading_open":
        state.headingLineEnd = token.map?.[1];
        state.headingBlock = {
          kind: "heading",
          start: state.text.length,
          end: state.text.length,
          depth: state.env.listStack.length + state.blockquoteStack.length + 1,
          blockquoteDepth: state.blockquoteStack.length,
          headingLevel: Number.parseInt(token.tag?.slice(1) ?? "", 10),
          headingOrigin: token.markup?.startsWith("#") ? "atx" : "setext",
          ...(token.map ? { sourceStartLine: token.map[0], sourceEndLine: token.map[1] } : {}),
        };
        if (state.headingStyle === "bold") {
          openStyle(state, "bold");
        } else if (state.headingStyle === "rich") {
          const style = HEADING_STYLE_BY_TAG.get(token.tag ?? "");
          if (style) {
            openStyle(state, style);
          }
        }
        break;
      case "heading_close":
        if (state.headingStyle === "bold") {
          closeStyle(state, "bold");
        } else if (state.headingStyle === "rich") {
          const style = HEADING_STYLE_BY_TAG.get(token.tag ?? "");
          if (style) {
            closeStyle(state, style);
          }
        }
        if (state.headingBlock) {
          state.blocks.push({ ...state.headingBlock, end: state.text.length });
        }
        state.headingBlock = undefined;
        appendHeadingSeparator(state, nextMappedBlockStarts[tokenIndex]);
        break;
      case "blockquote_open":
        if (state.blockquotePrefix) {
          state.text += state.blockquotePrefix;
        }
        state.blockquoteStack.push({
          start: state.text.length,
          depth: state.env.listStack.length + state.blockquoteStack.length + 1,
          blockquoteDepth: state.blockquoteStack.length + 1,
          ...(token.map ? { sourceStartLine: token.map[0], sourceEndLine: token.map[1] } : {}),
        });
        openStyle(state, "blockquote");
        break;
      case "blockquote_close": {
        closeStyle(state, "blockquote", { trimTrailingParagraphSeparator: true });
        const blockquote = state.blockquoteStack.pop();
        const end = Math.max(
          blockquote?.start ?? 0,
          state.text.endsWith("\n\n") ? state.text.length - 2 : state.text.length,
        );
        if (blockquote) {
          state.blocks.push({ kind: "blockquote", ...blockquote, end });
        }
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        if (state.env.listStack.length > 0) {
          appendNestedListSeparator(state);
        }
        const ordered = token.type === "ordered_list_open";
        state.env.listStack.push({
          type: ordered ? "ordered" : "bullet",
          index: ordered ? Number(getAttr(token, "start") ?? "1") - 1 : 0,
          openLevel: token.level ?? 0,
          id: state.nextListId++,
          ...(state.env.listStack.at(-1)?.id !== undefined
            ? { parentId: state.env.listStack.at(-1)?.id }
            : {}),
        });
        break;
      }
      case "bullet_list_close":
      case "ordered_list_close":
        state.env.listStack.pop();
        if (state.env.listStack.length === 0) {
          appendTopLevelListSeparator(state);
        }
        break;
      case "list_item_open": {
        const leadingInline =
          tokens[tokenIndex + 1]?.type === "paragraph_open" ? tokens[tokenIndex + 2] : undefined;
        const isTask = leadingInline?.type === "inline" && leadingInline.taskListMarker === true;
        const item = appendListPrefix(state, isTask);
        if (item) {
          recordListSourceMetadata(state, item, token);
          state.openListItems.push(item);
        }
        break;
      }
      case "list_item_close": {
        const item = state.openListItems.pop();
        if (item) {
          const end = state.text.length;
          const markerEnd = item.listMarker?.end ?? item.start ?? end;
          let contentStart = markerEnd;
          while (contentStart < end && /[ \t\r\n]/u.test(state.text[contentStart] ?? "")) {
            contentStart += 1;
          }
          let contentEnd = end;
          while (contentEnd > contentStart && /[ \t\r\n]/u.test(state.text[contentEnd - 1] ?? "")) {
            contentEnd -= 1;
          }
          const markerLineEnd = state.text.indexOf("\n", markerEnd);
          const markerContentEnd = markerLineEnd === -1 ? end : Math.min(markerLineEnd, end);
          const markerOnly = !state.text
            .slice(markerEnd, markerContentEnd)
            .replace(/[ \t\r\n]/gu, "");
          const listItem: MarkdownListItemMarker = {
            kind: item.kind,
            ...(item.listMarker ? { listMarker: item.listMarker } : {}),
            ...(item.task ? { task: true } : {}),
            ...(item.taskMarker ? { taskMarker: item.taskMarker } : {}),
            ...(item.listId !== undefined ? { listId: item.listId } : {}),
            ...(item.parentListId !== undefined ? { parentListId: item.parentListId } : {}),
            ...(item.depth !== undefined ? { depth: item.depth } : {}),
            ...(item.start !== undefined ? { start: item.start } : {}),
            end,
          };
          state.listItems.push(
            attachListItemMetadata(listItem, {
              ...(contentEnd > contentStart ? { contentStart, contentEnd } : {}),
              ...((item.sourceMarker ? item.markerOnly : markerOnly)
                ? { markerOnly: true as const }
                : {}),
              sourceMarker: item.sourceMarker,
              sourceContent: item.sourceContent,
              sourceIndent: item.sourceIndent,
              sourceStartLine: item.sourceStartLine,
              sourceEndLine: item.sourceEndLine,
            }),
          );
        }
        // Avoid double newlines (nested list's last item already added newline)
        if (!state.text.endsWith("\n")) {
          state.text += "\n";
        }
        break;
      }
      case "code_block":
      case "fence":
        renderCodeBlock(
          state,
          token.content ?? "",
          token.info,
          sourceBlockNewlineCount(
            state.preserveSourceBlockSpacing,
            nextMappedBlockStarts[tokenIndex],
            token.map?.[1],
          ),
          token.type === "fence" ? "fenced" : "indented",
          token.map,
          token.type === "fence" ? isFenceClosed(token) : undefined,
        );
        break;
      case "html_block":
      case "html_inline":
      case RAW_HTML_TOKEN_TYPE:
        appendText(state, token.content ?? "", token);
        break;

      // Table handling
      case "table_open":
        if (state.tableMode !== "off") {
          state.table = initTableState();
          state.table.sourceLines = token.map ?? undefined;
          state.hasTables = true;
        }
        break;
      case "table_close":
        if (state.table) {
          if (state.tableMode === "bullets") {
            renderTableAsBullets(state);
          } else if (state.tableMode === "code") {
            renderTableAsCode(state);
          } else if (state.tableMode === "block") {
            collectTableBlock(state);
          }
        }
        state.table = null;
        break;
      case "thead_open":
        if (state.table) {
          state.table.inHeader = true;
        }
        break;
      case "thead_close":
        if (state.table) {
          state.table.inHeader = false;
        }
        break;
      case "tbody_open":
      case "tbody_close":
        break;
      case "tr_open":
        if (state.table) {
          state.table.currentRow = [];
          state.table.currentSourceRow = [];
        }
        break;
      case "tr_close":
        if (state.table) {
          if (state.table.inHeader) {
            state.table.headers = state.table.currentRow;
            state.table.sourceHeaders = state.table.currentSourceRow;
          } else {
            state.table.rows.push(state.table.currentRow);
            state.table.sourceRows.push(state.table.currentSourceRow);
          }
          state.table.currentRow = [];
        }
        break;
      case "th_open":
      case "td_open":
        if (state.table) {
          state.table.currentCell = initRenderTarget();
          if (token.type === "th_open" && state.table.inHeader) {
            state.table.aligns[state.table.currentRow.length] =
              markdownTableAlignmentFromToken(token);
          }
        }
        break;
      case "th_close":
      case "td_close":
        if (state.table?.currentCell) {
          state.table.currentRow.push(finishTableCell(state.table.currentCell));
          state.table.currentCell = null;
        }
        break;

      case "hr":
        {
          const start = state.text.length;
          if (state.horizontalRuleText) {
            state.text += `${state.horizontalRuleText}\n\n`;
          }
          state.blocks.push({
            kind: "thematic_break",
            start,
            end: start + state.horizontalRuleText.length,
            depth: state.env.listStack.length + state.blockquoteStack.length + 1,
            blockquoteDepth: state.blockquoteStack.length,
            ...(token.map ? { sourceStartLine: token.map[0], sourceEndLine: token.map[1] } : {}),
          });
        }
        break;
      default:
        if (token.children) {
          renderTokens(token.children, state);
        }
        break;
    }
  }
}

function closeRemainingStyles(target: RenderTarget) {
  for (const open of target.openStyles.toReversed()) {
    const end = target.text.length;
    if (end > open.start) {
      target.styles.push({
        start: open.start,
        end,
        style: open.style,
      });
    }
  }
  target.openStyles = [];
}

function appendSpans<T extends { start: number; end: number }>(
  into: T[],
  spans: T[],
  offset: number,
): void {
  for (const span of spans) {
    span.start += offset;
    span.end += offset;
    into.push(span);
  }
}

/** Transfers a separately owned IR slice, including its metadata, into an accumulator. */
export function appendMarkdownIR(target: MarkdownIR, source: MarkdownIR): void {
  const offset = target.text.length;
  appendHtmlTags(target, source, offset);
  target.text += source.text;
  appendSpans(target.styles, source.styles, offset);
  appendSpans(target.links, source.links, offset);
  if (source.annotations?.length) {
    appendSpans((target.annotations ??= []), source.annotations, offset);
  }
  const listItems: MarkdownListItemWithMetadata[] = source.listItems ?? [];
  for (const item of listItems) {
    for (const marker of [item.listMarker, item.taskMarker]) {
      if (marker) {
        marker.start += offset;
        marker.end += offset;
      }
    }
    // Source-coordinate metadata stays anchored to the authored Markdown.
    for (const key of ["start", "end", "contentStart", "contentEnd"] as const) {
      const value = item[key];
      if (value !== undefined) {
        item[key] = value + offset;
      }
    }
    (target.listItems ??= []).push(item);
  }
  const sourceWithMetadata: MarkdownIRWithMetadata = source;
  if (sourceWithMetadata.blocks?.length) {
    const targetWithMetadata: MarkdownIRWithMetadata = target;
    const blocks = targetWithMetadata.blocks ?? [];
    appendSpans(blocks, sourceWithMetadata.blocks, offset);
    attachBlockMetadata(target, blocks);
  }
}

function sliceListMarker(
  marker: { start: number; end: number },
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const sliceStart = Math.max(marker.start, start);
  const sliceEnd = Math.min(marker.end, end);
  return sliceEnd > sliceStart ? { start: sliceStart - start, end: sliceEnd - start } : undefined;
}

export function sliceMarkdownIR(ir: MarkdownIR, start: number, end: number): MarkdownIR {
  const textLength = ir.text.length;
  const integerStart = Math.trunc(start) || 0;
  const integerEnd = Math.trunc(end) || 0;
  let normalizedStart =
    integerStart < 0 ? Math.max(textLength + integerStart, 0) : Math.min(integerStart, textLength);
  let normalizedEnd =
    integerEnd < 0 ? Math.max(textLength + integerEnd, 0) : Math.min(integerEnd, textLength);

  if (normalizedStart < normalizedEnd) {
    // Normalize once so text, formatting, links, and structural metadata share
    // the same complete-code-point boundaries.
    const safeStart = avoidTrailingHighSurrogateBreak(ir.text, 0, normalizedStart);
    if (safeStart !== normalizedStart) {
      normalizedStart = safeStart < normalizedStart ? safeStart : normalizedStart - 1;
    }

    const safeEnd = avoidTrailingHighSurrogateBreak(ir.text, 0, normalizedEnd);
    if (safeEnd !== normalizedEnd) {
      normalizedEnd = safeEnd > normalizedEnd ? safeEnd : normalizedEnd + 1;
    }
  }

  const metadataIR = ir as MarkdownIRWithMetadata;
  const annotations = sliceAnnotationSpans(ir.annotations ?? [], normalizedStart, normalizedEnd);
  const listItems = ((ir.listItems ?? []) as MarkdownListItemWithMetadata[]).flatMap((item) => {
    const listMarker = item.listMarker
      ? sliceListMarker(item.listMarker, normalizedStart, normalizedEnd)
      : undefined;
    const taskMarker = item.taskMarker
      ? sliceListMarker(item.taskMarker, normalizedStart, normalizedEnd)
      : undefined;
    const content =
      item.contentStart !== undefined && item.contentEnd !== undefined
        ? sliceListMarker(
            { start: item.contentStart, end: item.contentEnd },
            normalizedStart,
            normalizedEnd,
          )
        : undefined;
    return listMarker || taskMarker
      ? [
          attachListItemMetadata(
            {
              kind: item.kind,
              ...(listMarker ? { listMarker } : {}),
              ...(item.task ? { task: true as const } : {}),
              ...(taskMarker ? { taskMarker } : {}),
              ...(item.listId !== undefined ? { listId: item.listId } : {}),
              ...(item.parentListId !== undefined ? { parentListId: item.parentListId } : {}),
              ...(item.depth !== undefined ? { depth: item.depth } : {}),
              ...(item.start !== undefined
                ? { start: Math.max(item.start, normalizedStart) - normalizedStart }
                : {}),
              ...(item.end !== undefined
                ? { end: Math.min(item.end, normalizedEnd) - normalizedStart }
                : {}),
            },
            {
              ...(content ? { contentStart: content.start, contentEnd: content.end } : {}),
              ...(item.markerOnly ? { markerOnly: true as const } : {}),
              sourceMarker: item.sourceMarker,
              sourceContent: item.sourceContent,
              sourceIndent: item.sourceIndent,
              sourceStartLine: item.sourceStartLine,
              sourceEndLine: item.sourceEndLine,
            },
          ),
        ]
      : [];
  });
  const blocks = (metadataIR.blocks ?? []).flatMap((block) => {
    if (block.start === block.end) {
      const containsPoint =
        normalizedStart === normalizedEnd
          ? block.start === normalizedStart
          : block.start >= normalizedStart && block.start < normalizedEnd;
      return containsPoint
        ? [{ ...block, start: block.start - normalizedStart, end: block.end - normalizedStart }]
        : [];
    }
    const sliced = sliceListMarker(block, normalizedStart, normalizedEnd);
    return sliced ? [{ ...block, ...sliced }] : [];
  });
  const sliced: MarkdownIR = {
    text: ir.text.slice(normalizedStart, normalizedEnd),
    styles: sliceStyleSpans(ir.styles, normalizedStart, normalizedEnd),
    links: sliceLinkSpans(ir.links, normalizedStart, normalizedEnd),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(listItems.length > 0 ? { listItems } : {}),
  };
  return copyHtmlTags(ir, attachBlockMetadata(sliced, blocks), normalizedStart, normalizedEnd);
}

export function markdownToIR(markdown: string, options: MarkdownParseOptions = {}): MarkdownIR {
  return markdownToIRWithMeta(markdown, options).ir;
}

function indexSourceLines(source: string) {
  const lines: string[] = [];
  const starts: number[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character !== "\r" && character !== "\n") {
      continue;
    }
    starts.push(start);
    lines.push(source.slice(start, index));
    if (character === "\r" && source[index + 1] === "\n") {
      index += 1;
    }
    start = index + 1;
  }
  starts.push(start);
  lines.push(source.slice(start));
  return { lines, starts, openedByLine: new Map<number, number>() };
}

export function markdownToIRWithMeta(
  markdown: string,
  options: MarkdownParseOptions = {},
): { ir: MarkdownIR; hasTables: boolean; tables: MarkdownTableMeta[] } {
  const source = markdown ?? "";
  const env: RenderEnv = {
    listStack: [],
    ...(options.tableMode === "block" ? { tableSourceColumns: new Map<number, number>() } : {}),
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders === true,
    assistantTranscriptRolePreserveLinks: options.assistantTranscriptRoleHeaders === true,
  };
  const md = createMarkdownIt(options);
  const tokens = md.parse(source, env);

  const tableMode = options.tableMode ?? "off";

  const state: RenderState = {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
    annotations: [],
    env,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: options.blockquotePrefix ?? "",
    enableSpoilers: options.enableSpoilers ?? false,
    tableMode,
    table: null,
    hasTables: false,
    collectedTables: [],
    horizontalRuleText: options.horizontalRuleText ?? "───",
    preserveSourceBlockSpacing: options.preserveSourceBlockSpacing ?? false,
    headingLineEnd: undefined,
    listItems: [],
    openListItems: [],
    nextListId: 0,
    blocks: [],
    headingBlock: undefined,
    blockquoteStack: [],
    source,
    sourceIndex: undefined,
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  // Preserve trailing whitespace inside code; trim generated trailing separators.
  const trimmedText = state.text.trimEnd();
  const trimmedLength = trimmedText.length;
  let codeEnd = 0;
  for (const span of state.styles) {
    if (span.style !== "code" && span.style !== "code_block") {
      continue;
    }
    codeEnd = Math.max(codeEnd, span.end);
  }
  const finalLength = Math.max(trimmedLength, codeEnd);
  const finalText =
    finalLength === state.text.length ? state.text : state.text.slice(0, finalLength);
  const annotations = mergeAnnotationSpans(clampAnnotationSpans(state.annotations, finalLength));
  const listItems = state.listItems.flatMap((item) => {
    const listMarker = item.listMarker
      ? sliceListMarker(item.listMarker, 0, finalLength)
      : undefined;
    const taskMarker = item.taskMarker
      ? sliceListMarker(item.taskMarker, 0, finalLength)
      : undefined;
    return listMarker || taskMarker
      ? [
          attachListItemMetadata(
            {
              kind: item.kind,
              ...(listMarker ? { listMarker } : {}),
              ...(item.task ? { task: true as const } : {}),
              ...(taskMarker ? { taskMarker } : {}),
              ...(item.listId !== undefined ? { listId: item.listId } : {}),
              ...(item.parentListId !== undefined ? { parentListId: item.parentListId } : {}),
              ...(item.depth !== undefined ? { depth: item.depth } : {}),
              ...(item.start !== undefined ? { start: Math.min(item.start, finalLength) } : {}),
              ...(item.end !== undefined ? { end: Math.min(item.end, finalLength) } : {}),
            },
            {
              ...(item.contentStart !== undefined
                ? { contentStart: Math.min(item.contentStart, finalLength) }
                : {}),
              ...(item.contentEnd !== undefined
                ? { contentEnd: Math.min(item.contentEnd, finalLength) }
                : {}),
              ...(item.markerOnly ? { markerOnly: true as const } : {}),
              sourceMarker: item.sourceMarker,
              sourceContent: item.sourceContent,
              sourceIndent: item.sourceIndent,
              sourceStartLine: item.sourceStartLine,
              sourceEndLine: item.sourceEndLine,
            },
          ),
        ]
      : [];
  });
  const blocks = state.blocks
    .map((block) => {
      const start = Math.min(block.start, finalLength);
      const end = Math.min(block.end, finalLength);
      return { ...block, start, end };
    })
    .toSorted(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.depth - right.depth ||
        left.kind.localeCompare(right.kind),
    );

  const ir: MarkdownIR = {
    text: finalText,
    styles: mergeStyleSpans(clampStyleSpans(state.styles, finalLength)),
    links: clampLinkSpans(state.links, finalLength),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(listItems.length > 0 ? { listItems } : {}),
  };
  attachBlockMetadata(ir, blocks);
  copyHtmlTags(state, ir, 0, finalLength);
  return {
    ir,
    hasTables: state.hasTables,
    tables: state.collectedTables.map((table) =>
      Object.assign(table, {
        placeholderOffset: Math.min(table.placeholderOffset, finalLength),
      }),
    ),
  };
}

export function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) {
    return [];
  }
  if (limit <= 0 || ir.text.length <= limit) {
    return [ir];
  }

  const chunks = chunkText(ir.text, limit);
  const results: MarkdownIR[] = [];
  let cursor = 0;

  chunks.forEach((chunk, index) => {
    if (!chunk) {
      return;
    }
    if (index > 0) {
      while (cursor < ir.text.length && /\s/.test(ir.text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    const start = cursor;
    const end = Math.min(ir.text.length, start + chunk.length);
    const sliced = sliceMarkdownIR(ir, start, end);
    sliced.text = chunk;
    results.push(sliced);
    cursor = end;
  });

  return results;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
