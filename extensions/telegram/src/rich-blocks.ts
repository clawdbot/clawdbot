// Markdown → Bot API 10.3 InputRichBlock[] for Telegram rich messages.
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
  inputRichBlocksToPlainText,
  maxInputRichBlockNesting,
  normalizeRichText,
  type InputRichBlock,
  type InputRichBlockParagraph,
  type RichBlockTableCell,
  type RichText,
  type TelegramRichBlocksDegradationReason,
} from "./rich-block-model.js";
import { findTelegramHtmlIslands, renderTelegramHtmlIsland } from "./rich-blocks-html-map.js";
import { htmlNodesToRichText, parseHtmlFragment, type HtmlNode } from "./rich-blocks-html.js";
import {
  collectMarkdownRichListSources,
  renderMarkdownRichListSource,
  type MarkdownRichListSource,
} from "./rich-blocks-list.js";
import { renderTelegramMonospaceGrid } from "./text-width.js";

const TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT = 20;

const TELEGRAM_RICH_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "blocks",
  chunk: { limit: 32_768, unit: "chars" },
});

const INLINE_STYLE_RANK: Record<InlineStyleKind, number> = {
  spoiler: 0,
  bold: 1,
  italic: 2,
  strikethrough: 3,
  code: 4,
};

const TELEGRAM_RICH_LINK_HREF_RE = /^(?:https?:\/\/|tg:\/\/|mailto:|tel:)/i;

type InlineStyleKind = "bold" | "italic" | "strikethrough" | "code" | "spoiler";

type StructuralSegment =
  | { kind: "html"; start: number; end: number; node: Extract<HtmlNode, { kind: "element" }> }
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
  if (context.origin === "linkify") {
    // File refs need code to suppress false links. Other bare links stay plain
    // because Telegram typed URLs escape query separators (observed 2026-08).
    return isAutoLinkedFileRef(href, label) ? { kind: "code" } : null;
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
  const slice = sliceMarkdownIR(ir, rangeStart, rangeEnd);
  const text = slice.text;
  if (!text) {
    return "";
  }

  type Active = { start: number; end: number } & (
    | { kind: "style"; style: InlineStyleKind }
    | { kind: "annotation" }
    | { kind: "html"; wrap: (text: RichText) => RichText }
    | { kind: "link"; target: { kind: "url"; href: string } | { kind: "anchor"; name: string } }
  );
  const spans: Active[] = [];
  for (const span of slice.styles) {
    if (isInlineStyle(span.style)) {
      spans.push({ start: span.start, end: span.end, kind: "style", style: span.style });
    }
  }
  for (const span of slice.annotations ?? []) {
    spans.push({ start: span.start, end: span.end, kind: "annotation" });
  }
  for (const link of collectTelegramLinkActions(slice)) {
    spans.push(
      link.action.kind === "code"
        ? { start: link.start, end: link.end, kind: "style", style: "code" }
        : { start: link.start, end: link.end, kind: "link", target: link.action },
    );
  }
  type Leaf = { start: number; end: number } & (
    | { kind: "text" }
    | { kind: "atom"; value: RichText }
  );
  const leaves: Leaf[] = [];
  const nodes = text.includes("<") ? parseHtmlFragment(slice) : [];
  const hasElement = (children: readonly HtmlNode[]): boolean =>
    children.some((node) => node.kind === "element" && (node.closed || hasElement(node.children)));
  if (hasElement(nodes)) {
    // Keep HTML wrappers and atomic islands on the same source axis as Markdown.
    // One sweep can then apply annotation dominance without breaking authored HTML.
    const recordText = ({ start, end }: { start: number; end: number }) => {
      leaves.push({ kind: "text", start, end });
      return "";
    };
    htmlNodesToRichText(nodes, {
      text: recordText,
      literal: recordText,
      wrap: ({ start, end }, wrap, children) => {
        spans.push({ kind: "html", start, end, wrap });
        return children();
      },
      atom: ({ start, end }, value) => {
        // An indivisible replacement must not hide a protected source annotation.
        const annotated = slice.annotations?.some((span) => span.start < end && span.end > start);
        leaves.push(annotated ? { kind: "text", start, end } : { kind: "atom", start, end, value });
        return "";
      },
    });
  } else {
    leaves.push({ kind: "text", start: 0, end: text.length });
  }
  const rank = (span: Active) =>
    span.kind === "style" ? INLINE_STYLE_RANK[span.style] : span.kind === "annotation" ? 0 : 50;
  spans.sort(
    (left, right) => left.start - right.start || right.end - left.end || rank(left) - rank(right),
  );
  const points = [
    ...new Set([...spans, ...leaves].flatMap((span) => [span.start, span.end])),
  ].toSorted((left, right) => left - right);
  const stack: Active[] = [];
  const root: RichText[] = [];
  const frameStack: RichText[][] = [root];

  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] ?? 0;
    const leaf = leaves.find((entry) => entry.start <= start && entry.end > start);
    if (!leaf || (leaf.kind === "atom" && leaf.start !== start)) {
      continue;
    }
    const end = leaf.kind === "atom" ? leaf.end : (points[i + 1] ?? start);
    const covering = spans.filter((span) => span.start <= start && span.end >= end);
    const annotation = covering.find((span) => span.kind === "annotation");
    // Dominance applies only to the covered range. Surrounding formatting resumes
    // after a transcript header. Code is already literal in IR; its merged range
    // may contain independently authored styles and clickable links.
    const active = annotation ? [annotation] : covering;
    let shared = 0;
    while (shared < stack.length && stack[shared] === active[shared]) {
      shared += 1;
    }
    // Retain unchanged containers; rebuild the suffix when an ancestor expires,
    // even if its child continues, so crossed ranges cannot leak formatting.
    stack.length = shared;
    frameStack.length = shared + 1;
    for (const item of active.slice(shared)) {
      const container: RichText[] = [];
      const node: RichText =
        item.kind === "html"
          ? item.wrap(container)
          : item.kind === "link"
            ? item.target.kind === "url"
              ? { type: "url", text: container, url: item.target.href }
              : { type: "anchor_link", text: container, anchor_name: item.target.name }
            : { type: item.kind === "annotation" ? "code" : item.style, text: container };
      frameStack.at(-1)?.push(node);
      stack.push(item);
      frameStack.push(container);
    }
    if (end > start) {
      // Unlike Bot API HTML mode, rich paragraphs preserve bare newlines verbatim.
      frameStack.at(-1)?.push(leaf.kind === "atom" ? leaf.value : text.slice(start, end));
    }
  }

  return normalizeRichText(root);
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

function renderAsciiTableGrid(table: MarkdownTableMeta): string {
  return renderTelegramMonospaceGrid([table.headers, ...table.rows], {
    headerSeparator: true,
  });
}

function cellToRichText(cell: MarkdownTableCell | undefined): RichText | undefined {
  if (!cell?.text) {
    return undefined;
  }
  const rich = irRangeToRichText(cell, 0, cell.text.length);
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
      align: align ?? "left",
      valign: "middle",
      ...(text !== undefined ? { text } : {}),
    };
  });
  const bodyRows: RichBlockTableCell[][] = table.rowCells.map((row) =>
    Array.from({ length: columnCount }, (_value, index) => {
      const align = table.aligns?.[index];
      const text = cellToRichText(row[index]);
      return {
        align: align ?? "left",
        valign: "middle",
        ...(text !== undefined ? { text } : {}),
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
  htmlNodes: readonly HtmlNode[],
): StructuralSegment[] {
  const segments: StructuralSegment[] = [];
  const htmlIslands = findTelegramHtmlIslands(htmlNodes);
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
    if (htmlIslands.some((island) => source.start >= island.start && source.end <= island.end)) {
      continue;
    }
    segments.push({ kind: "list", start: source.start, end: source.end, source });
  }
  return segments;
}

function preserveLiteralHtmlOwners(
  ir: MarkdownIR,
  segments: readonly StructuralSegment[],
  htmlNodes: readonly HtmlNode[],
): void {
  const islands = new Set<HtmlNode>(findTelegramHtmlIslands(htmlNodes));
  const owners: Array<{ start: number; end: number }> = [];
  htmlNodesToRichText(
    htmlNodes.filter((node) => !islands.has(node)),
    {
      text: () => "",
      literal: (range) => {
        owners.push(range);
        return "";
      },
      wrap: (_range, _wrap, children) => children(),
      atom: () => "",
    },
  );
  if (!owners.length) {
    return;
  }
  // Markdown block slices must not reactivate tags whose HTML ancestor is literal.
  ir.htmlTags = ir.htmlTags?.filter(
    (tag) => !owners.some((owner) => tag.start >= owner.start && tag.end <= owner.end),
  );
  for (const segment of segments) {
    if (
      segment.kind !== "table" ||
      !owners.some((owner) => segment.start > owner.start && segment.start < owner.end)
    ) {
      continue;
    }
    // A preceding zero-width table may share the opener's offset; only body tables belong to it.
    for (const row of [segment.table.headerCells, ...segment.table.rowCells]) {
      for (const cell of row) {
        if (cell.htmlTags) {
          cell.htmlTags = [];
        }
      }
    }
  }
}

function emitSegments(
  ir: MarkdownIR,
  segments: readonly StructuralSegment[],
  rangeStart: number,
  rangeEnd: number,
  degradationReasons: Set<TelegramRichBlocksDegradationReason>,
  htmlNodes: readonly HtmlNode[] = [],
): InputRichBlock[] {
  preserveLiteralHtmlOwners(ir, segments, htmlNodes);
  const containerRank = (segment: StructuralSegment) =>
    segment.kind === "blockquote" ? 0 : segment.kind === "list" ? 1 : 2;
  const orderedSegments = [
    ...segments,
    ...findTelegramHtmlIslands(htmlNodes).map((node): StructuralSegment => ({
      kind: "html",
      start: node.start,
      end: node.end,
      node,
    })),
  ].toSorted((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    // Tables occupy no IR text. A table before an HTML opener shares its offset,
    // but Markdown quotes/lists at that offset still own their table children.
    const ownsTable = (segment: StructuralSegment) =>
      segment.kind === "blockquote" || segment.kind === "list";
    if (left.kind === "table" && right.kind !== "table" && !ownsTable(right)) {
      return -1;
    }
    if (right.kind === "table" && left.kind !== "table" && !ownsTable(left)) {
      return 1;
    }
    return right.end - left.end || containerRank(left) - containerRank(right);
  });
  const blocks: InputRichBlock[] = [];
  let cursor = rangeStart;
  let index = 0;
  while (index < orderedSegments.length) {
    const segment = orderedSegments[index];
    if (!segment) {
      break;
    }
    if (segment.start > cursor) {
      blocks.push(...splitParagraphs(ir, cursor, segment.start));
    }
    // Segments nested inside this one (fences/headings/tables in a blockquote)
    // belong to it; consuming them here prevents a second top-level emission.
    let next = index + 1;
    while (
      next < orderedSegments.length &&
      (orderedSegments[next]?.start ?? rangeEnd) < segment.end
    ) {
      next += 1;
    }
    const children = orderedSegments.slice(index + 1, next);
    switch (segment.kind) {
      case "html": {
        blocks.push(
          ...renderTelegramHtmlIsland(segment.node, (nodes) => {
            const content: InputRichBlock[] = [];
            let first = 0;
            for (let last = 0; last < nodes.length; last += 1) {
              if (nodes[last + 1]?.start === nodes[last]!.end) {
                continue;
              }
              const start = nodes[first]!.start;
              const end = nodes[last]!.end;
              // Removed summaries, credits, and checkboxes split body ranges.
              // Render the remaining tree with the same Markdown owner as the root.
              content.push(
                ...emitSegments(
                  ir,
                  children.filter((child) => child.start >= start && child.end <= end),
                  start,
                  end,
                  degradationReasons,
                  nodes.slice(first, last + 1),
                ),
              );
              first = last + 1;
            }
            return content;
          }),
        );
        break;
      }
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
    blocks.push(...splitParagraphs(ir, cursor, rangeEnd));
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
  const htmlNodes = parseHtmlFragment(ir);
  const segments = collectStructuralSegments(ir, tables, htmlNodes);
  const hasMarkdownLists = segments.some((segment) => segment.kind === "list");
  const flattenedSegments = segments.filter((segment) => segment.kind !== "list");
  let blocks = emitSegments(ir, segments, 0, ir.text.length, degradationReasons, htmlNodes);
  if (hasMarkdownLists && maxInputRichBlockNesting(blocks) > 16) {
    degradationReasons = new Set<TelegramRichBlocksDegradationReason>();
    degradationReasons.add("list-limit");
    blocks = emitSegments(ir, flattenedSegments, 0, ir.text.length, degradationReasons, htmlNodes);
  }

  if (blocks.length === 0 && ir.text.trim()) {
    blocks.push({ type: "paragraph", text: ir.text });
  }

  // Plain recovery remains byte-compatible with the pre-native-list path.
  const plainBlocks = hasMarkdownLists
    ? emitSegments(ir, flattenedSegments, 0, ir.text.length, new Set(), htmlNodes)
    : blocks;

  return {
    blocks,
    // Tables are zero-width placeholders in ir.text; project the blocks so the
    // plain fallback keeps table content instead of silently dropping it.
    plainText: inputRichBlocksToPlainText(plainBlocks),
    degradationReasons: [...degradationReasons],
  };
}
