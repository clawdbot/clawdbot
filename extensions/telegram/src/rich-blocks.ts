// Markdown → Bot API 10.2 InputRichBlock[] for Telegram rich messages.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  FormatCapabilityProfile,
  isAutoLinkedFileRef,
  markdownToIRWithMeta,
  renderMarkdownWithMarkers,
  sliceMarkdownIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  type MarkdownStyle,
  type MarkdownTableCell,
  type MarkdownTableMeta,
} from "openclaw/plugin-sdk/text-chunking";
import {
  countInputRichBlocks,
  inputRichBlocksToPlainText,
  maxInputRichBlockNesting,
  normalizeRichText,
  type InputRichBlock,
  type InputRichBlockParagraph,
  type RichBlockTableCell,
  type RichText,
  type TelegramRichBlocksDegradationReason,
} from "./rich-block-model.js";
import { findTelegramHtmlIslands } from "./rich-blocks-html-map.js";
import { parseInlineHtmlIslands } from "./rich-blocks-html.js";
import {
  collectMarkdownRichListSources,
  renderMarkdownRichListSource,
  type MarkdownRichListSource,
} from "./rich-blocks-list.js";

const TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT = 20;

const TELEGRAM_RICH_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "blocks",
  chunk: { limit: 32_768, unit: "chars" },
});

const INLINE_STYLE_RANK: Record<string, number> = {
  spoiler: 0,
  bold: 1,
  italic: 2,
  strikethrough: 3,
  code: 4,
};

const TELEGRAM_RICH_LINK_HREF_RE = /^(?:https?:\/\/|tg:\/\/|mailto:|tel:)/i;

type InlineStyleKind = "bold" | "italic" | "strikethrough" | "code" | "spoiler";

type StructuralSegment =
  | { kind: "heading"; start: number; end: number; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "code_block"; start: number; end: number; language?: string }
  | { kind: "blockquote"; start: number; end: number }
  | { kind: "list"; start: number; end: number; source: MarkdownRichListSource }
  | { kind: "table"; start: number; end: number; table: MarkdownTableMeta };

function isTelegramRichLinkHref(href: string): boolean {
  return TELEGRAM_RICH_LINK_HREF_RE.test(href);
}

function resolveHeadingSize(style: MarkdownStyle): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  switch (style) {
    case "heading_1":
      return 1;
    case "heading_2":
      return 2;
    case "heading_3":
      return 3;
    case "heading_4":
      return 4;
    case "heading_5":
      return 5;
    case "heading_6":
      return 6;
    default:
      return undefined;
  }
}

function isInlineStyle(style: MarkdownStyle): style is InlineStyleKind {
  return (
    style === "bold" ||
    style === "italic" ||
    style === "strikethrough" ||
    style === "code" ||
    style === "spoiler"
  );
}

type TelegramLinkAction =
  | { kind: "url"; href: string }
  | { kind: "anchor"; name: string }
  | { kind: "code" };

function resolveTelegramLinkAction(
  link: MarkdownLinkSpan,
  source: string,
  context: { origin: "authored" | "linkify" },
): TelegramLinkAction | null {
  const href = link.href.trim();
  if (!href || link.start === link.end) {
    return null;
  }
  const label = source.slice(link.start, link.end);
  if (context.origin === "linkify" && isAutoLinkedFileRef(href, label)) {
    // Bare file refs (README.md, openclaw.json) must render as code, not links:
    // Telegram's server-side entity detection would otherwise re-linkify them
    // and show spurious domain previews for TLD-like extensions.
    return { kind: "code" };
  }
  if (href.startsWith("#")) {
    // In-message fragments are RichTextAnchorLink, not RichTextUrl.
    return { kind: "anchor", name: href.slice(1) };
  }
  if (!isTelegramRichLinkHref(href)) {
    return null;
  }
  return { kind: "url", href };
}

function collectTelegramLinkActions(
  ir: MarkdownIR,
): Array<{ start: number; end: number; action: TelegramLinkAction }> {
  const links: Array<{ start: number; end: number; action: TelegramLinkAction }> = [];
  renderMarkdownWithMarkers(
    ir,
    {
      styleMarkers: {},
      escapeText: (text) => text,
      buildLink: (link, source, context) => {
        const action = resolveTelegramLinkAction(link, source, context);
        if (action) {
          links.push({ start: link.start, end: link.end, action });
        }
        return null;
      },
    },
    TELEGRAM_RICH_FORMAT_PROFILE,
  );
  return links;
}

/**
 * Build nested RichText from IR spans over [rangeStart, rangeEnd).
 * Spans that partially overlap are split at shared boundaries (IR contract).
 */
function irRangeToRichText(ir: MarkdownIR, rangeStart: number, rangeEnd: number): RichText {
  if (rangeEnd <= rangeStart) {
    return "";
  }
  const slice = sliceMarkdownIR(ir, rangeStart, rangeEnd);
  const text = slice.text;
  if (!text) {
    return "";
  }

  const dominantAnnotationRanges = (slice.annotations ?? [])
    .filter((span) => span.type === "assistant_transcript_role")
    .map((span) => ({ start: span.start, end: span.end }));

  const suppressed = (start: number, end: number) =>
    dominantAnnotationRanges.some((range) => start < range.end && end > range.start);

  const styleSpans = slice.styles.filter(
    (span) => isInlineStyle(span.style) && !suppressed(span.start, span.end),
  );
  const annotationSpans = (slice.annotations ?? []).filter(
    (span) => span.type === "assistant_transcript_role",
  );
  const links = collectTelegramLinkActions({
    text,
    styles: [],
    links: slice.links.filter((link) => !suppressed(link.start, link.end)),
  });

  const boundaries = new Set<number>([0, text.length]);
  for (const span of styleSpans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const span of annotationSpans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const link of links) {
    boundaries.add(link.start);
    boundaries.add(link.end);
  }
  const points = [...boundaries].toSorted((a, b) => a - b);

  type Active =
    | { kind: "style"; style: InlineStyleKind; end: number }
    | { kind: "annotation"; end: number }
    | {
        kind: "link";
        target: { kind: "url"; href: string } | { kind: "anchor"; name: string };
        end: number;
      };

  const stack: Active[] = [];
  const root: RichText[] = [];
  const frameStack: RichText[][] = [root];

  const pushNode = (node: RichText) => {
    frameStack.at(-1)?.push(node);
  };

  const openStyleNode = (style: InlineStyleKind, end: number) => {
    const container: RichText[] = [];
    pushNode({ type: style, text: container });
    stack.push({ kind: "style", style, end });
    frameStack.push(container);
  };

  const openAnnotationNode = (end: number) => {
    const container: RichText[] = [];
    pushNode({ type: "code", text: container });
    stack.push({ kind: "annotation", end });
    frameStack.push(container);
  };

  const openLinkNode = (
    target: { kind: "url"; href: string } | { kind: "anchor"; name: string },
    end: number,
  ) => {
    const container: RichText[] = [];
    pushNode(
      target.kind === "url"
        ? { type: "url", text: container, url: target.href }
        : { type: "anchor_link", text: container, anchor_name: target.name },
    );
    stack.push({ kind: "link", target, end });
    frameStack.push(container);
  };

  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? start;
    while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= start) {
      stack.pop();
      frameStack.pop();
    }

    const opening: Active[] = [];
    for (const span of annotationSpans) {
      if (span.start === start) {
        opening.push({ kind: "annotation", end: span.end });
      }
    }
    for (const link of links) {
      if (link.start !== start) {
        continue;
      }
      if (link.action.kind === "url" || link.action.kind === "anchor") {
        opening.push({ kind: "link", target: link.action, end: link.end });
      } else {
        opening.push({ kind: "style", style: "code", end: link.end });
      }
    }
    for (const span of styleSpans) {
      if (span.start === start && isInlineStyle(span.style)) {
        opening.push({ kind: "style", style: span.style, end: span.end });
      }
    }
    opening.sort((left, right) => {
      if (left.end !== right.end) {
        return right.end - left.end;
      }
      const leftRank =
        left.kind === "style"
          ? (INLINE_STYLE_RANK[left.style] ?? 99)
          : left.kind === "link"
            ? 50
            : 0;
      const rightRank =
        right.kind === "style"
          ? (INLINE_STYLE_RANK[right.style] ?? 99)
          : right.kind === "link"
            ? 50
            : 0;
      return leftRank - rightRank;
    });

    const inCode =
      stack.some((entry) => entry.kind === "style" && entry.style === "code") ||
      stack.some((entry) => entry.kind === "annotation");

    for (const item of opening) {
      if (item.kind === "annotation") {
        openAnnotationNode(item.end);
      } else if (item.kind === "link") {
        if (!inCode && !stack.some((entry) => entry.kind === "link")) {
          openLinkNode(item.target, item.end);
        }
      } else if (!inCode || item.style === "code") {
        if (!(item.style === "code" && inCode)) {
          openStyleNode(item.style, item.end);
        }
      }
    }

    if (end > start) {
      // Unlike Bot API html mode, blocks preserve bare `\n` inside paragraph
      // RichText verbatim (live-verified 2026-07-15 via sendRichMessage echo).
      pushNode(text.slice(start, end));
    }
  }

  while (stack.length > 0) {
    stack.pop();
    frameStack.pop();
  }

  return normalizeRichText(applyInlineHtmlIslands(root));
}

// Inline islands (<sup>, <tg-math>, <tg-emoji>, …) live in plain string leaves;
// code spans keep their content literal.
function applyInlineHtmlIslands(node: RichText): RichText {
  if (typeof node === "string") {
    return parseInlineHtmlIslands(node);
  }
  if (Array.isArray(node)) {
    return node.map(applyInlineHtmlIslands);
  }
  if (
    node.type === "code" ||
    node.type === "mathematical_expression" ||
    node.type === "custom_emoji"
  ) {
    return node;
  }
  return { ...node, text: applyInlineHtmlIslands(node.text) };
}

function pushParagraph(
  paragraphs: InputRichBlockParagraph[],
  ir: MarkdownIR,
  rangeStart: number,
  rangeEnd: number,
): void {
  // Trim the range (not the rendered text) so style/link offsets stay aligned;
  // gaps after structural blocks otherwise leak leading newlines into paragraphs.
  const raw = ir.text.slice(rangeStart, rangeEnd);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const absStart = rangeStart + leading;
  const absEnd = rangeEnd - trailing;
  if (absEnd <= absStart) {
    return;
  }
  const text = irRangeToRichText(ir, absStart, absEnd);
  // Inline island conversion can normalize a leaf to nothing (e.g. an anchor
  // with empty label); an empty paragraph is invalid wire content.
  if (text !== "") {
    paragraphs.push({ type: "paragraph", text });
  }
}

function splitParagraphs(ir: MarkdownIR, start: number, end: number): InputRichBlockParagraph[] {
  if (end <= start) {
    return [];
  }
  const text = ir.text.slice(start, end);
  const paragraphs: InputRichBlockParagraph[] = [];
  const blankLine = /\n[ \t]*\n+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = blankLine.exec(text)) !== null) {
    pushParagraph(paragraphs, ir, start + last, start + match.index);
    last = match.index + match[0].length;
  }
  pushParagraph(paragraphs, ir, start + last, end);
  return paragraphs;
}

// Gap emitter: agent-authored block HTML islands (details/lists/media/math/…)
// become typed blocks; the text around them stays on the paragraph path.
function emitGapBlocks(ir: MarkdownIR, start: number, end: number): InputRichBlock[] {
  if (end <= start) {
    return [];
  }
  // Code-formatted ranges keep their tags literal: `<hr/>` inside a code span
  // is an example, not a divider. Only the island's opening tag position
  // matters — code content nested inside an island body must not reject it.
  const codeRanges = ir.styles.filter(
    (span) =>
      (span.style === "code" || span.style === "code_block") &&
      span.end > start &&
      span.start < end,
  );
  const islands = findTelegramHtmlIslands(ir.text.slice(start, end)).filter(
    (island) =>
      !codeRanges.some(
        (range) => start + island.start >= range.start && start + island.start < range.end,
      ),
  );
  if (islands.length === 0) {
    return splitParagraphs(ir, start, end);
  }
  const blocks: InputRichBlock[] = [];
  let cursor = start;
  for (const island of islands) {
    blocks.push(...splitParagraphs(ir, cursor, start + island.start));
    blocks.push(...island.blocks);
    cursor = start + island.end;
  }
  blocks.push(...splitParagraphs(ir, cursor, end));
  return blocks;
}

function renderAsciiTableGrid(table: MarkdownTableMeta): string {
  const rows = [table.headers, ...table.rows];
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 3);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index] ?? 3, row[index]?.length ?? 0);
    }
  }
  const renderRow = (row: readonly string[]) =>
    `| ${widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(table.headers), divider, ...table.rows.map(renderRow)].join("\n");
}

function cellToRichText(cell: MarkdownTableCell | undefined): RichText | undefined {
  if (!cell?.text) {
    return undefined;
  }
  const ir: MarkdownIR = {
    text: cell.text,
    styles: cell.styles,
    links: cell.links,
    ...(cell.annotations ? { annotations: cell.annotations } : {}),
  };
  const rich = irRangeToRichText(ir, 0, cell.text.length);
  return rich === "" ? undefined : rich;
}

function renderTableBlock(table: MarkdownTableMeta): {
  block: InputRichBlock;
  degradation?: TelegramRichBlocksDegradationReason;
} {
  const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);
  if (columnCount > TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT) {
    return {
      block: { type: "pre", text: renderAsciiTableGrid(table) },
      degradation: "table-ascii",
    };
  }
  const headerRow: RichBlockTableCell[] = table.headerCells.map((cell, index) => {
    const align = table.aligns?.[index];
    const text = cellToRichText(cell);
    return {
      is_header: true,
      ...(text !== undefined ? { text } : {}),
      ...(align ? { align } : {}),
    };
  });
  const bodyRows: RichBlockTableCell[][] = table.rowCells.map((row) =>
    Array.from({ length: columnCount }, (_value, index) => {
      const align = table.aligns?.[index];
      const text = cellToRichText(row[index]);
      return {
        ...(text !== undefined ? { text } : {}),
        ...(align ? { align } : {}),
      };
    }),
  );
  const cells = headerRow.length > 0 ? [headerRow, ...bodyRows] : bodyRows;
  return {
    block: {
      type: "table",
      cells,
      is_bordered: true,
      is_striped: true,
    },
  };
}

function collectStructuralSegments(
  ir: MarkdownIR,
  tables: readonly MarkdownTableMeta[],
): StructuralSegment[] {
  const segments: StructuralSegment[] = [];
  for (const span of ir.styles) {
    if (span.end <= span.start) {
      continue;
    }
    const headingSize = resolveHeadingSize(span.style);
    if (headingSize) {
      segments.push({ kind: "heading", start: span.start, end: span.end, size: headingSize });
      continue;
    }
    if (span.style === "code_block") {
      segments.push({
        kind: "code_block",
        start: span.start,
        end: span.end,
        ...(span.language ? { language: span.language } : {}),
      });
      continue;
    }
    if (span.style === "blockquote") {
      segments.push({ kind: "blockquote", start: span.start, end: span.end });
    }
  }
  for (const table of tables) {
    const offset = Math.max(0, Math.min(table.placeholderOffset, ir.text.length));
    segments.push({ kind: "table", start: offset, end: offset, table });
  }
  for (const source of collectMarkdownRichListSources(ir)) {
    segments.push({ kind: "list", start: source.start, end: source.end, source });
  }
  // Containers sort before their children (start asc, end desc) so emitSegments
  // can consume contained segments recursively instead of double-emitting them.
  const containerRank = (segment: StructuralSegment) =>
    segment.kind === "blockquote" ? 0 : segment.kind === "list" ? 1 : 2;
  return segments.toSorted(
    (left, right) =>
      left.start - right.start ||
      right.end - left.end ||
      containerRank(left) - containerRank(right),
  );
}

function emitSegments(
  ir: MarkdownIR,
  segments: readonly StructuralSegment[],
  rangeStart: number,
  rangeEnd: number,
  degradationReasons: Set<TelegramRichBlocksDegradationReason>,
): InputRichBlock[] {
  const blocks: InputRichBlock[] = [];
  let cursor = rangeStart;
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index];
    if (!segment) {
      break;
    }
    if (segment.start > cursor) {
      blocks.push(...emitGapBlocks(ir, cursor, segment.start));
    }
    // Segments nested inside this one (fences/headings/tables in a blockquote)
    // belong to it; consuming them here prevents a second top-level emission.
    let next = index + 1;
    while (next < segments.length && (segments[next]?.start ?? rangeEnd) < segment.end) {
      next += 1;
    }
    const children = segments.slice(index + 1, next);
    switch (segment.kind) {
      case "heading": {
        const text = irRangeToRichText(ir, segment.start, segment.end);
        if (text !== "") {
          blocks.push({ type: "heading", text, size: segment.size });
        }
        break;
      }
      case "code_block": {
        const text = ir.text.slice(segment.start, segment.end).replace(/\n$/, "");
        blocks.push({
          type: "pre",
          text,
          ...(segment.language ? { language: segment.language } : {}),
        });
        break;
      }
      case "blockquote": {
        const inner = emitSegments(ir, children, segment.start, segment.end, degradationReasons);
        if (inner.length > 0) {
          blocks.push({ type: "blockquote", blocks: inner });
        }
        break;
      }
      case "list": {
        const rendered = renderMarkdownRichListSource(segment.source, (start, end) =>
          emitSegments(
            ir,
            children.filter((child) => child.start >= start && child.end <= end),
            start,
            end,
            degradationReasons,
          ),
        );
        if (rendered) {
          blocks.push(...rendered);
        } else {
          degradationReasons.add("list-limit");
          blocks.push(
            ...emitSegments(
              ir,
              children.filter((child) => child.kind !== "list"),
              segment.start,
              segment.end,
              degradationReasons,
            ),
          );
        }
        break;
      }
      case "table": {
        const rendered = renderTableBlock(segment.table);
        if (rendered.degradation) {
          degradationReasons.add(rendered.degradation);
        }
        blocks.push(rendered.block);
        break;
      }
    }
    cursor = Math.max(cursor, segment.end);
    index = next;
  }
  if (cursor < rangeEnd) {
    blocks.push(...emitGapBlocks(ir, cursor, rangeEnd));
  }
  return blocks;
}

export function markdownToTelegramRichBlocks(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; skipEntityDetection?: boolean } = {},
): {
  blocks: InputRichBlock[];
  plainText: string;
  degradationReasons: readonly TelegramRichBlocksDegradationReason[];
} {
  const tableMode = options.tableMode ?? "block";
  // The shared parse carries list markers into native blocks; `---` keeps the
  // IR's ─── text, while media/details/math stay HTML-island contracts.
  const { ir, tables } = markdownToIRWithMeta(markdown ?? "", {
    assistantTranscriptRoleHeaders: true,
    linkify: options.skipEntityDetection !== true,
    enableSpoilers: true,
    enableTaskLists: true,
    headingStyle: "rich",
    blockquotePrefix: "",
    tableMode,
  });

  let degradationReasons = new Set<TelegramRichBlocksDegradationReason>();
  const segments = collectStructuralSegments(ir, tables);
  const hasMarkdownLists = segments.some((segment) => segment.kind === "list");
  const flattenedSegments = segments.filter((segment) => segment.kind !== "list");
  let blocks = emitSegments(ir, segments, 0, ir.text.length, degradationReasons);
  if (
    hasMarkdownLists &&
    (countInputRichBlocks(blocks) > 500 || maxInputRichBlockNesting(blocks) > 16)
  ) {
    degradationReasons = new Set<TelegramRichBlocksDegradationReason>();
    degradationReasons.add("list-limit");
    blocks = emitSegments(ir, flattenedSegments, 0, ir.text.length, degradationReasons);
  }

  if (blocks.length === 0 && ir.text.trim()) {
    blocks.push({ type: "paragraph", text: ir.text });
  }

  // Plain recovery remains byte-compatible with the pre-native-list path.
  const plainBlocks = hasMarkdownLists
    ? emitSegments(ir, flattenedSegments, 0, ir.text.length, new Set())
    : blocks;

  return {
    blocks,
    // Tables are zero-width placeholders in ir.text; project the blocks so the
    // plain fallback keeps table content instead of silently dropping it.
    plainText: inputRichBlocksToPlainText(plainBlocks),
    degradationReasons: [...degradationReasons],
  };
}
