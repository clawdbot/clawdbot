// Markdown Core module implements ir behavior.
import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import { HTML_TAG_RE } from "markdown-it/lib/common/html_re.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { visibleWidth } from "../../terminal-core/src/ansi.js";
import {
  ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE,
  markdownItAssistantTranscriptRoles,
  type AssistantTranscriptRoleImageMeta,
  type AssistantTranscriptRoleTokenMeta,
} from "./assistant-transcript.js";
import { chunkText } from "./chunk-text.js";
import { tokenizeHtmlTags } from "./html-tags.js";
import {
  appendAssistantTranscriptRoleImage,
  appendAssistantTranscriptRoleText,
} from "./ir-annotations.js";
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

const OPEN_MARKDOWN_HTML_TAG_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9-]*\b[^<>]*$/;

type RenderEnv = {
  assistantTranscriptRoleHeaders?: boolean;
  assistantTranscriptRolePreserveLinks?: boolean;
  listStack: ListState[];
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

export type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
  annotations?: MarkdownAnnotationSpan[];
  listItems?: MarkdownListItemMarker[];
};

type MarkdownTableAlignment = "left" | "center" | "right";

export type MarkdownTableData = {
  headers: string[];
  rows: string[][];
  aligns?: (MarkdownTableAlignment | undefined)[];
};

export type MarkdownTableCell = {
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
  listItems: MarkdownListItemMarker[];
  openListItems: MarkdownListItemMarker[];
  nextListId: number;
};

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
};

function appendHeadingSeparator(state: RenderState, nextBlockStart: number | undefined) {
  const newlineCount = sourceBlockNewlineCount(
    state.preserveSourceBlockSpacing,
    nextBlockStart,
    state.headingLineEnd,
  );
  if (newlineCount === undefined) {
    appendParagraphSeparator(state);
    return;
  }
  if (newlineCount > 0) {
    state.text += "\n".repeat(newlineCount);
  }
  state.headingLineEnd = undefined;
}

function createMarkdownIt(options: MarkdownParseOptions): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: options.linkify ?? true,
    breaks: false,
    typographer: false,
  });
  md.use(markdownItCjkFriendly);
  md.use(markdownItAssistantTranscriptRoles);
  if (options.enableTaskLists) {
    md.core.ruler.before("inline", "markdown_core_task_lists", protectTaskListMarkers);
  }
  if (options.enableHtmlUnderline) {
    md.inline.ruler.before("html_inline", "markdown_core_html_underline", parseHtmlUnderline);
  }
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
  } else {
    md.disable("table");
  }
  if (options.autolink === false) {
    md.disable("autolink");
  }
  return md;
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

function parseHtmlUnderline(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c) {
    return false;
  }
  const raw = HTML_TAG_RE.exec(state.src.slice(state.pos))?.[0];
  if (!raw) {
    return false;
  }
  const tag = tokenizeHtmlTags(raw).next().value;
  const underlineTag =
    tag && tag.start === 0 && (tag.name === "u" || tag.name === "ins") ? tag : undefined;
  if (!silent) {
    const token = state.push(
      !underlineTag || underlineTag.selfClosing
        ? "text"
        : underlineTag.closing
          ? "underline_close"
          : "underline_open",
      "",
      0,
    );
    if (!underlineTag || underlineTag.selfClosing) {
      token.content = raw;
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

function appendText(state: RenderState, value: string) {
  if (!value) {
    return;
  }
  const target = resolveRenderTarget(state);
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

function appendParagraphSeparator(state: RenderState, token?: MarkdownToken) {
  if (state.table) {
    return;
  } // Don't add paragraph separators inside tables
  if (state.env.listStack.length > 0) {
    const currentList = state.env.listStack[state.env.listStack.length - 1];
    const directListParagraphLevel = (currentList?.openLevel ?? 0) + 2;
    if (
      token?.type !== "paragraph_close" ||
      token.hidden ||
      token.level !== directListParagraphLevel
    ) {
      return;
    }
  }
  state.text += "\n\n";
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

function appendListPrefix(state: RenderState, isTask: boolean): MarkdownListItemMarker | undefined {
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
) {
  let code = content ?? "";
  if (!code.endsWith("\n")) {
    code = `${code}\n`;
  }
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  target.text += code;
  target.styles.push(
    createStyleSpan({
      start,
      end: start + code.length,
      style: "code_block",
      language: resolveFenceLanguage(info),
    }),
  );
  if (state.env.listStack.length === 0) {
    const extraNewlines =
      sourceNewlineCount === undefined ? 1 : Math.max(0, sourceNewlineCount - 1);
    target.text += "\n".repeat(extraNewlines);
  }
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

function headingStyleFromToken(token: MarkdownToken): MarkdownStyle | null {
  switch (token.tag) {
    case "h1":
      return "heading_1";
    case "h2":
      return "heading_2";
    case "h3":
      return "heading_3";
    case "h4":
      return "heading_4";
    case "h5":
      return "heading_5";
    case "h6":
      return "heading_6";
    default:
      return null;
  }
}

function isInsideMarkdownHtmlTag(text: string): boolean {
  const openTagStart = text.lastIndexOf("<");
  if (openTagStart === -1) {
    return false;
  }
  return (
    text.lastIndexOf(">") < openTagStart &&
    OPEN_MARKDOWN_HTML_TAG_PATTERN.test(text.slice(openTagStart))
  );
}

function initTableState(): TableState {
  return {
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
  return {
    text: cell.text,
    styles: cell.styles,
    links: cell.links,
    ...(cell.annotations.length > 0 ? { annotations: cell.annotations } : {}),
  };
}

function trimCell(cell: TableCell): TableCell {
  const text = cell.text;
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) {
    start += 1;
  }
  while (end > start && /\s/.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  if (start === 0 && end === text.length) {
    return cell;
  }
  const trimmedText = text.slice(start, end);
  const trimmedLength = trimmedText.length;
  const trimmedStyles: MarkdownStyleSpan[] = [];
  for (const span of cell.styles) {
    const sliceStart = Math.max(0, span.start - start);
    const sliceEnd = Math.min(trimmedLength, span.end - start);
    if (sliceEnd > sliceStart) {
      trimmedStyles.push({ start: sliceStart, end: sliceEnd, style: span.style });
    }
  }
  const trimmedLinks: MarkdownLinkSpan[] = [];
  for (const span of cell.links) {
    const sliceStart = Math.max(0, span.start - start);
    const sliceEnd = Math.min(trimmedLength, span.end - start);
    if (sliceEnd > sliceStart) {
      trimmedLinks.push(copyMarkdownLinkSpan(span, { start: sliceStart, end: sliceEnd }));
    }
  }
  const trimmedAnnotations = sliceAnnotationSpans(cell.annotations ?? [], start, end);
  return {
    text: trimmedText,
    styles: trimmedStyles,
    links: trimmedLinks,
    ...(trimmedAnnotations.length > 0 ? { annotations: trimmedAnnotations } : {}),
  };
}

function appendCell(state: RenderState, cell: TableCell) {
  if (!cell.text) {
    return;
  }
  const start = state.text.length;
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

function appendCellTextOnly(state: RenderState, cell: TableCell) {
  if (!cell.text) {
    return;
  }
  state.text += cell.text;
  // Do not append styles - this is used for code blocks where inner styles would overlap
}

function collectTableBlock(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headerCells = state.table.headers.map(trimCell);
  const rowCells = state.table.rows.map((row) => row.map(trimCell));
  const table = {
    headers: headerCells.map((cell) => cell.text),
    rows: rowCells.map((row) => row.map((cell) => cell.text)),
    headerCells,
    rowCells,
    placeholderOffset: state.text.length,
    ...(state.table.aligns.some(Boolean) ? { aligns: [...state.table.aligns] } : {}),
  };
  state.collectedTables.push(table);
}

function appendTableBulletValue(
  state: RenderState,
  params: {
    header?: TableCell;
    value?: TableCell;
    columnIndex: number;
    includeColumnFallback: boolean;
  },
) {
  const { header, value, columnIndex, includeColumnFallback } = params;
  if (!value?.text) {
    return;
  }
  state.text += "• ";
  if (header?.text) {
    appendCell(state, header);
    state.text += ": ";
  } else if (includeColumnFallback) {
    state.text += `Column ${columnIndex}: `;
  }
  appendCell(state, value);
  state.text += "\n";
}

function renderTableAsBullets(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  // If no headers or rows, skip
  if (headers.length === 0 && rows.length === 0) {
    return;
  }

  // Determine if first column should be used as row labels
  // (common pattern: first column is category/feature name)
  const useFirstColAsLabel = headers.length > 1 && rows.length > 0;

  if (useFirstColAsLabel) {
    // Format: each row becomes a section with header as row[0], then key:value pairs
    for (const row of rows) {
      if (row.length === 0) {
        continue;
      }

      const rowLabel = row[0];
      if (rowLabel?.text) {
        const labelStart = state.text.length;
        appendCell(state, rowLabel);
        const labelEnd = state.text.length;
        if (labelEnd > labelStart) {
          state.styles.push({ start: labelStart, end: labelEnd, style: "bold" });
        }
        state.text += "\n";
      }

      // Add each column as a bullet point
      for (let i = 1; i < row.length; i++) {
        appendTableBulletValue(state, {
          header: headers[i],
          value: row[i],
          columnIndex: i,
          includeColumnFallback: true,
        });
      }
      state.text += "\n";
    }
  } else {
    // Simple table: just list headers and values
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        appendTableBulletValue(state, {
          header: headers[i],
          value: row[i],
          columnIndex: i,
          includeColumnFallback: false,
        });
      }
      state.text += "\n";
    }
  }
}

function renderTableAsCode(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length));
  if (columnCount === 0) {
    return;
  }

  const widths = Array.from({ length: columnCount }, () => 0);
  const updateWidths = (cells: TableCell[]) => {
    for (const [i, currentWidth] of widths.entries()) {
      const cell = cells[i];
      const width = visibleWidth(cell?.text ?? "");
      if (currentWidth < width) {
        widths[i] = width;
      }
    }
  };
  updateWidths(headers);
  for (const row of rows) {
    updateWidths(row);
  }

  const codeStart = state.text.length;

  const appendRow = (cells: TableCell[]) => {
    state.text += "|";
    for (const [i, width] of widths.entries()) {
      state.text += " ";
      const cell = cells[i];
      if (cell) {
        // Use text-only append to avoid overlapping styles with code_block
        appendCellTextOnly(state, cell);
      }
      const pad = width - visibleWidth(cell?.text ?? "");
      if (pad > 0) {
        state.text += " ".repeat(pad);
      }
      state.text += " |";
    }
    state.text += "\n";
  };

  const appendDivider = () => {
    state.text += "|";
    for (const width of widths) {
      const dashCount = Math.max(3, width);
      state.text += ` ${"-".repeat(dashCount)} |`;
    }
    state.text += "\n";
  };

  appendRow(headers);
  appendDivider();
  for (const row of rows) {
    appendRow(row);
  }

  const codeEnd = state.text.length;
  if (codeEnd > codeStart) {
    state.styles.push({ start: codeStart, end: codeEnd, style: "code_block" });
  }
  if (state.env.listStack.length === 0) {
    state.text += "\n";
  }
}

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  const nextMappedBlockStarts = computeNextMappedBlockStarts(tokens);
  for (const [tokenIndex, token] of tokens.entries()) {
    switch (token.type) {
      case "inline":
        if (token.children) {
          renderTokens(token.children, state);
        }
        break;
      case "text":
        recordTaskMarker(state, token.content ?? "");
        appendText(state, token.content ?? "");
        break;
      case "underline_open":
        openStyle(state, "underline");
        break;
      case "underline_close":
        closeStyle(state, "underline");
        break;
      case ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE: {
        const meta = (token.meta as AssistantTranscriptRoleTokenMeta | undefined)
          ?.assistantTranscriptRoleHeader;
        if (meta) {
          appendAssistantTranscriptRoleText(resolveRenderTarget(state), token.content ?? "", meta);
        } else {
          appendText(state, token.content ?? "");
        }
        break;
      }
      case "em_open":
        openStyle(state, "italic");
        break;
      case "em_close":
        closeStyle(state, "italic");
        break;
      case "strong_open":
        openStyle(state, "bold");
        break;
      case "strong_close":
        closeStyle(state, "bold");
        break;
      case "s_open":
        openStyle(state, "strikethrough");
        break;
      case "s_close":
        closeStyle(state, "strikethrough");
        break;
      case "code_inline":
        renderInlineCode(state, token.content ?? "");
        break;
      case "spoiler_open":
        if (state.enableSpoilers) {
          openStyle(state, "spoiler");
        }
        break;
      case "spoiler_close":
        if (state.enableSpoilers) {
          closeStyle(state, "spoiler");
        }
        break;
      case "link_open": {
        const target = resolveRenderTarget(state);
        const href = isInsideMarkdownHtmlTag(target.text) ? "" : (getAttr(token, "href") ?? "");
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
        if (meta) {
          appendAssistantTranscriptRoleImage(resolveRenderTarget(state), meta);
        } else {
          appendText(state, token.content ?? "");
        }
        break;
      }
      case "softbreak":
      case "hardbreak":
        appendText(state, "\n");
        break;
      case "paragraph_close":
        appendParagraphSeparator(state, token);
        break;
      case "heading_open":
        state.headingLineEnd = token.map?.[1];
        if (state.headingStyle === "bold") {
          openStyle(state, "bold");
        } else if (state.headingStyle === "rich") {
          const style = headingStyleFromToken(token);
          if (style) {
            openStyle(state, style);
          }
        }
        break;
      case "heading_close":
        if (state.headingStyle === "bold") {
          closeStyle(state, "bold");
        } else if (state.headingStyle === "rich") {
          const style = headingStyleFromToken(token);
          if (style) {
            closeStyle(state, style);
          }
        }
        appendHeadingSeparator(state, nextMappedBlockStarts[tokenIndex]);
        break;
      case "blockquote_open":
        if (state.blockquotePrefix) {
          state.text += state.blockquotePrefix;
        }
        openStyle(state, "blockquote");
        break;
      case "blockquote_close":
        closeStyle(state, "blockquote", { trimTrailingParagraphSeparator: true });
        break;
      case "bullet_list_open":
        // Add newline before nested list starts (so nested items appear on new line)
        if (state.env.listStack.length > 0) {
          appendNestedListSeparator(state);
        }
        state.env.listStack.push({
          type: "bullet",
          index: 0,
          openLevel: token.level ?? 0,
          id: state.nextListId++,
          ...(state.env.listStack.at(-1)?.id !== undefined
            ? { parentId: state.env.listStack.at(-1)?.id }
            : {}),
        });
        break;
      case "bullet_list_close":
        state.env.listStack.pop();
        if (state.env.listStack.length === 0) {
          appendTopLevelListSeparator(state);
        }
        break;
      case "ordered_list_open": {
        // Add newline before nested list starts (so nested items appear on new line)
        if (state.env.listStack.length > 0) {
          appendNestedListSeparator(state);
        }
        const start = Number(getAttr(token, "start") ?? "1");
        state.env.listStack.push({
          type: "ordered",
          index: start - 1,
          openLevel: token.level ?? 0,
          id: state.nextListId++,
          ...(state.env.listStack.at(-1)?.id !== undefined
            ? { parentId: state.env.listStack.at(-1)?.id }
            : {}),
        });
        break;
      }
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
          state.openListItems.push(item);
        }
        break;
      }
      case "list_item_close": {
        const item = state.openListItems.pop();
        if (item) {
          state.listItems.push({
            kind: item.kind,
            ...(item.listMarker ? { listMarker: item.listMarker } : {}),
            ...(item.task ? { task: true } : {}),
            ...(item.taskMarker ? { taskMarker: item.taskMarker } : {}),
            ...(item.listId !== undefined ? { listId: item.listId } : {}),
            ...(item.parentListId !== undefined ? { parentListId: item.parentListId } : {}),
            ...(item.depth !== undefined ? { depth: item.depth } : {}),
            ...(item.start !== undefined ? { start: item.start } : {}),
            end: state.text.length,
          });
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
        );
        break;
      case "html_block":
      case "html_inline":
        appendText(state, token.content ?? "");
        break;

      // Table handling
      case "table_open":
        if (state.tableMode !== "off") {
          state.table = initTableState();
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
        }
        break;
      case "tr_close":
        if (state.table) {
          if (state.table.inHeader) {
            state.table.headers = state.table.currentRow;
          } else {
            state.table.rows.push(state.table.currentRow);
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
        if (state.horizontalRuleText) {
          state.text += `${state.horizontalRuleText}\n\n`;
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
  const annotations = sliceAnnotationSpans(ir.annotations ?? [], start, end);
  const listItems = (ir.listItems ?? []).flatMap((item) => {
    const listMarker = item.listMarker ? sliceListMarker(item.listMarker, start, end) : undefined;
    const taskMarker = item.taskMarker ? sliceListMarker(item.taskMarker, start, end) : undefined;
    return listMarker || taskMarker
      ? [
          {
            kind: item.kind,
            ...(listMarker ? { listMarker } : {}),
            ...(item.task ? { task: true as const } : {}),
            ...(taskMarker ? { taskMarker } : {}),
            ...(item.listId !== undefined ? { listId: item.listId } : {}),
            ...(item.parentListId !== undefined ? { parentListId: item.parentListId } : {}),
            ...(item.depth !== undefined ? { depth: item.depth } : {}),
            ...(item.start !== undefined ? { start: Math.max(item.start, start) - start } : {}),
            ...(item.end !== undefined ? { end: Math.min(item.end, end) - start } : {}),
          },
        ]
      : [];
  });
  const sliced: MarkdownIR = {
    text: ir.text.slice(start, end),
    styles: sliceStyleSpans(ir.styles, start, end),
    links: sliceLinkSpans(ir.links, start, end),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(listItems.length > 0 ? { listItems } : {}),
  };
  return sliced;
}

export function markdownToIR(markdown: string, options: MarkdownParseOptions = {}): MarkdownIR {
  return markdownToIRWithMeta(markdown, options).ir;
}

export function markdownToIRWithMeta(
  markdown: string,
  options: MarkdownParseOptions = {},
): { ir: MarkdownIR; hasTables: boolean; tables: MarkdownTableMeta[] } {
  const env: RenderEnv = {
    listStack: [],
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders === true,
    assistantTranscriptRolePreserveLinks: options.assistantTranscriptRoleHeaders === true,
  };
  const md = createMarkdownIt(options);
  const tokens = md.parse(markdown ?? "", env as unknown as object);

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
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  const trimmedText = state.text.trimEnd();
  const trimmedLength = trimmedText.length;
  let codeBlockEnd = 0;
  for (const span of state.styles) {
    if (span.style !== "code_block") {
      continue;
    }
    if (span.end > codeBlockEnd) {
      codeBlockEnd = span.end;
    }
  }
  const finalLength = Math.max(trimmedLength, codeBlockEnd);
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
        ]
      : [];
  });

  const ir: MarkdownIR = {
    text: finalText,
    styles: mergeStyleSpans(clampStyleSpans(state.styles, finalLength)),
    links: clampLinkSpans(state.links, finalLength),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(listItems.length > 0 ? { listItems } : {}),
  };
  return {
    ir,
    hasTables: state.hasTables,
    tables: state.collectedTables.map((table) =>
      Object.assign({}, table, {
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
