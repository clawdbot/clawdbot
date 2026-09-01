// Line plugin module implements markdown to line behavior.
import type { messagingApi } from "@line/bot-sdk";
import {
  markdownToIRWithMeta,
  stripMarkdown,
  type MarkdownIR,
  type MarkdownStyle,
  type MarkdownStyleSpan,
  type MarkdownTableCell,
  type MarkdownTableMeta,
} from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { LINE_FLEX_BUBBLE_MAX_BYTES, toFlexMessage } from "./flex-templates/message.js";
import { createReceiptCard } from "./flex-templates/schedule-cards.js";
import type { FlexBubble } from "./flex-templates/types.js";
export { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";

type FlexMessage = messagingApi.FlexMessage;
type FlexComponent = messagingApi.FlexComponent;
type FlexText = messagingApi.FlexText;
type FlexSpan = messagingApi.FlexSpan;
type FlexBox = messagingApi.FlexBox;

export interface ProcessedLineMessage {
  /** The processed text with markdown stripped */
  text: string;
  /** Flex messages extracted from tables/code blocks */
  flexMessages: FlexMessage[];
  /** Source-ordered delivery parts whenever Markdown contains rich blocks. */
  segments?: Array<{ type: "text"; text: string } | { type: "flex"; message: FlexMessage }>;
}

type LineMessageSegment = NonNullable<ProcessedLineMessage["segments"]>[number];

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  headerCells?: MarkdownTableCell[];
  rowCells?: MarkdownTableCell[][];
}

export interface CodeBlock {
  language?: string;
  code: string;
}

const LINE_MARKDOWN_OPTIONS = {
  assistantTranscriptRoleHeaders: true,
  autolink: false,
  blockquotePrefix: "",
  headingStyle: "none",
  horizontalRuleText: "",
  linkify: false,
  preserveSourceBlockSpacing: true,
} as const;
const TRANSCRIPT_ROLE_PREFIX = "[assistant-authored transcript] ";
// How much code one Flex card shows. Nothing in LINE caps a Flex text this low —
// it is the card's own readable budget — so a longer block is delivered as text
// rather than cut down to it.
const LINE_FLEX_CODE_CARD_MAX_CHARS = 2000;

function parseLineMarkdown(text: string, tableMode: "block" | "bullets" | "off" = "block") {
  return markdownToIRWithMeta(text, { ...LINE_MARKDOWN_OPTIONS, tableMode });
}

function toMarkdownTable(table: MarkdownTableMeta): MarkdownTable {
  return {
    headers: table.headers,
    rows: table.rows,
    headerCells: table.headerCells,
    rowCells: table.rowCells,
  };
}

function codeBlockSpans(ir: MarkdownIR): MarkdownStyleSpan[] {
  return ir.styles.filter((span) => span.style === "code_block");
}

function toCodeBlock(ir: MarkdownIR, span: MarkdownStyleSpan): CodeBlock {
  return {
    ...(span.language ? { language: span.language } : {}),
    code: ir.text.slice(span.start, span.end).trimEnd(),
  };
}

type PlainTextInsertion =
  | { position: number; text: string }
  | { position: number; message: FlexMessage };

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

function projectPlainText(
  ir: MarkdownIR,
  omitted: MarkdownStyleSpan[] = [],
  additionalInsertions: PlainTextInsertion[] = [],
  onSegment?: (segment: LineMessageSegment) => void,
): string {
  const insertions: PlainTextInsertion[] = [...additionalInsertions];
  for (const link of ir.links) {
    if (omitted.some((range) => rangesOverlap(range, link))) {
      continue;
    }
    const href = link.href.trim();
    const label = ir.text.slice(link.start, link.end).trim();
    const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
    if (href && label && label !== href && label !== comparableHref) {
      insertions.push({ position: link.end, text: ` (${href})` });
    }
  }
  for (const annotation of ir.annotations ?? []) {
    if (
      annotation.type === "assistant_transcript_role" &&
      !omitted.some((range) => rangesOverlap(range, annotation))
    ) {
      insertions.push({
        position: annotation.start,
        text: TRANSCRIPT_ROLE_PREFIX,
      });
    }
  }
  const inlineCodeSpans = ir.styles.filter(
    (span) => span.style === "code" && !omitted.some((range) => rangesOverlap(range, span)),
  );
  for (const span of inlineCodeSpans) {
    const code = ir.text.slice(span.start, span.end);
    if (
      stripMarkdown(code, { assistantTranscriptRoleHeaders: true }).startsWith(
        TRANSCRIPT_ROLE_PREFIX,
      )
    ) {
      insertions.push({ position: span.start, text: TRANSCRIPT_ROLE_PREFIX });
    }
  }
  insertions.sort((left, right) => left.position - right.position);

  const underlineTags = [...ir.text.matchAll(/<\/?u>/gi)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(
      (tag) =>
        !inlineCodeSpans.some((span) => rangesOverlap(tag, span)) &&
        !omitted.some((span) => rangesOverlap(tag, span)),
    );
  const removed = [...omitted, ...underlineTags].toSorted(
    (left, right) => left.start - right.start,
  );

  let output = "";
  let segmentStart = 0;
  let cursor = 0;
  let insertionIndex = 0;
  const appendRange = (end: number) => {
    while (insertionIndex < insertions.length) {
      const insertion = insertions[insertionIndex];
      if (!insertion || insertion.position > end) {
        break;
      }
      if (insertion.position >= cursor) {
        output += ir.text.slice(cursor, insertion.position);
        if ("text" in insertion) {
          output += insertion.text;
        } else if (onSegment) {
          const precedingText = output.slice(segmentStart).trim();
          if (precedingText) {
            onSegment({ type: "text", text: precedingText });
          }
          onSegment({ type: "flex", message: insertion.message });
          segmentStart = output.length;
        }
        cursor = insertion.position;
      }
      insertionIndex += 1;
    }
    output += ir.text.slice(cursor, end);
    cursor = end;
  };

  for (const range of removed) {
    appendRange(range.start);
    cursor = Math.max(cursor, range.end);
    while (
      insertionIndex < insertions.length &&
      (insertions[insertionIndex]?.position ?? cursor) < cursor
    ) {
      insertionIndex += 1;
    }
  }
  appendRange(ir.text.length);
  if (onSegment) {
    const trailingText = output.slice(segmentStart).trim();
    if (trailingText) {
      onSegment({ type: "text", text: trailingText });
    }
  }
  return output.trim();
}

function formatOversizedTableAsBullets(table: MarkdownTableMeta): string {
  const markdownCell = (cell: MarkdownTableCell) =>
    projectPlainText(cell)
      .replace(/[\\|`*_[\]~<>&]/gu, "\\$&")
      .replace(/\r?\n/gu, " ");
  const markdownRow = (cells: MarkdownTableCell[]) => `| ${cells.map(markdownCell).join(" | ")} |`;
  const markdown = [
    markdownRow(table.headerCells),
    `| ${table.headerCells.map(() => "---").join(" | ")} |`,
    ...table.rowCells.map(markdownRow),
  ].join("\n");

  return projectPlainText(parseLineMarkdown(markdown, "bullets").ir);
}

type RenderedCell = {
  text: string;
  contents?: FlexSpan[];
  hasMarkup: boolean;
};

function sameSpanStyle(left: FlexSpan, right: FlexSpan): boolean {
  return (
    left.weight === right.weight &&
    left.style === right.style &&
    left.decoration === right.decoration
  );
}

function renderTableCell(cell: MarkdownTableCell | undefined, fallback: string): RenderedCell {
  if (!cell?.text.trim()) {
    return { text: fallback, hasMarkup: false };
  }

  const codeSpans = cell.styles.filter((span) => span.style === "code");
  const tags = [...cell.text.matchAll(/<\/?u>/gi)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      closing: match[0][1] === "/",
    }))
    .filter((tag) => !codeSpans.some((span) => rangesOverlap(tag, span)));
  const boundaries = new Set([0, cell.text.length]);
  for (const style of cell.styles) {
    boundaries.add(style.start);
    boundaries.add(style.end);
  }
  for (const link of cell.links) {
    boundaries.add(link.end);
  }
  for (const tag of tags) {
    boundaries.add(tag.start);
    boundaries.add(tag.end);
  }
  const sortedBoundaries = [...boundaries].toSorted((left, right) => left - right);
  const spans: FlexSpan[] = [];
  let underlineDepth = 0;
  let hasMarkup = false;

  const appendSpan = (span: FlexSpan) => {
    const previous = spans.at(-1);
    if (previous && sameSpanStyle(previous, span)) {
      previous.text = `${previous.text ?? ""}${span.text ?? ""}`;
    } else {
      spans.push(span);
    }
  };

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    if (start === undefined || end === undefined) {
      continue;
    }
    const tag = tags.find((candidate) => candidate.start === start);
    if (tag) {
      underlineDepth += tag.closing ? -1 : 1;
      hasMarkup = true;
      continue;
    }
    const text = cell.text.slice(start, end);
    if (text) {
      const active = new Set<MarkdownStyle>(
        cell.styles
          .filter((style) => style.start <= start && style.end >= end)
          .map((style) => style.style),
      );
      const weight = active.has("bold") ? "bold" : undefined;
      const style = active.has("italic") ? "italic" : undefined;
      const decoration = active.has("strikethrough")
        ? "line-through"
        : underlineDepth > 0
          ? "underline"
          : undefined;
      hasMarkup ||= weight !== undefined || style !== undefined || decoration !== undefined;
      appendSpan({ type: "span", text, weight, style, decoration });
    }
    for (const link of cell.links.filter((candidate) => candidate.end === end)) {
      const href = link.href.trim();
      const label = cell.text.slice(link.start, link.end).trim();
      if (href && label && label !== href) {
        appendSpan({ type: "span", text: ` (${href})` });
        hasMarkup = true;
      }
    }
  }

  const renderedText =
    spans
      .map((span) => span.text ?? "")
      .join("")
      .trim() || fallback;
  return {
    text: renderedText,
    ...(hasMarkup ? { contents: spans } : {}),
    hasMarkup,
  };
}

function plainTableCell(text: string): MarkdownTableCell {
  return parseLineMarkdown(text, "off").ir;
}

/** Convert a markdown table to a LINE Flex Message bubble. */
export function convertTableToFlexBubble(table: MarkdownTable): FlexBubble {
  const headerCells = (table.headerCells ?? table.headers.map(plainTableCell)).map((cell) =>
    renderTableCell(cell, "-"),
  );
  const rowCells = (table.rowCells ?? table.rows.map((row) => row.map(plainTableCell))).map((row) =>
    row.map((cell) => renderTableCell(cell, "-")),
  );
  const hasInlineMarkup =
    headerCells.some((cell) => cell.hasMarkup) ||
    rowCells.some((row) => row.some((cell) => cell.hasMarkup));

  if (table.headers.length === 2 && !hasInlineMarkup) {
    return createReceiptCard({
      title: headerCells.map((cell) => cell.text).join(" / "),
      items: rowCells.map((row) => ({
        name: row[0]?.text ?? "-",
        value: row[1]?.text ?? "-",
      })),
    });
  }

  const headerRow: FlexComponent = {
    type: "box",
    layout: "horizontal",
    contents: headerCells.map((cell) => ({
      type: "text",
      text: cell.text,
      contents: cell.contents,
      weight: "bold",
      size: "sm",
      color: "#333333",
      flex: 1,
      wrap: true,
    })) as FlexText[],
    paddingBottom: "sm",
  } as FlexBox;

  const dataRows: FlexComponent[] = rowCells.slice(0, 10).map((row, rowIndex) => ({
    type: "box",
    layout: "horizontal",
    contents: table.headers.map((_, colIndex) => {
      const cell = row[colIndex] ?? { text: "-", hasMarkup: false };
      return {
        type: "text",
        text: cell.text,
        contents: cell.contents,
        size: "sm",
        color: "#666666",
        flex: 1,
        wrap: true,
      } as FlexText;
    }),
    margin: rowIndex === 0 ? "md" : "sm",
  })) as FlexBox[];

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [headerRow, { type: "separator", margin: "sm" }, ...dataRows],
      paddingAll: "lg",
    },
  };
}

/** Convert a code block to a LINE Flex Message bubble. */
export function convertCodeBlockToFlexBubble(block: CodeBlock): FlexBubble {
  const titleText = block.language ? `Code (${block.language})` : "Code";
  const displayCode =
    block.code.length > LINE_FLEX_CODE_CARD_MAX_CHARS
      ? `${truncateUtf16Safe(block.code, LINE_FLEX_CODE_CARD_MAX_CHARS)}\n...`
      : block.code;

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: titleText,
          weight: "bold",
          size: "sm",
          color: "#666666",
        } as FlexText,
        {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: displayCode,
              size: "xs",
              color: "#333333",
              wrap: true,
            } as FlexText,
          ],
          backgroundColor: "#F5F5F5",
          paddingAll: "md",
          cornerRadius: "md",
          margin: "sm",
        } as FlexBox,
      ],
      paddingAll: "lg",
    },
  };
}

/** Parse once, route existing block surfaces to Flex, and project the remainder as plain text. */
export function processLineMessage(text: string): ProcessedLineMessage {
  const { ir, tables } = parseLineMarkdown(text);
  const codeSpans = codeBlockSpans(ir);
  const plainTextInsertions: PlainTextInsertion[] = [];

  for (const table of tables) {
    // Receipt cards keep 12 plain rows; generic and styled table layouts keep only 10.
    const rowOverflow =
      table.rowCells.length > 10 &&
      (table.headers.length !== 2 ||
        table.rowCells.length > 12 ||
        [table.headerCells, ...table.rowCells].some((cells) =>
          cells.some((cell) => renderTableCell(cell, "-").hasMarkup),
        ));
    const bubble = rowOverflow ? undefined : convertTableToFlexBubble(toMarkdownTable(table));
    // LINE rejects the whole push/reply when any bubble exceeds its 30 KB UTF-8 JSON limit.
    if (!bubble || Buffer.byteLength(JSON.stringify(bubble), "utf8") > LINE_FLEX_BUBBLE_MAX_BYTES) {
      plainTextInsertions.push({
        position: table.placeholderOffset,
        text: `\n\n${formatOversizedTableAsBullets(table)}\n\n`,
      });
      continue;
    }
    const message = toFlexMessage("Table", bubble);
    plainTextInsertions.push({ position: table.placeholderOffset, message });
  }

  for (const span of codeSpans) {
    const block = toCodeBlock(ir, span);
    // An empty fence has no code to show, and LINE rejects the whole push when a
    // Flex text is blank, so it drops out instead of costing the reply.
    if (!block.code.trim()) {
      continue;
    }
    // A block the card would have to cut is delivered as the text it was written
    // as, the same way an oversized table is: the reader gets all of it, chunked
    // by the ordinary text limit, instead of a card ending in an ellipsis.
    if (block.code.length > LINE_FLEX_CODE_CARD_MAX_CHARS) {
      plainTextInsertions.push({ position: span.start, text: `\n\n${block.code}\n\n` });
      continue;
    }
    plainTextInsertions.push({
      position: span.start,
      message: toFlexMessage("Code", convertCodeBlockToFlexBubble(block)),
    });
  }

  const segments: LineMessageSegment[] = [];
  const processedText = projectPlainText(ir, codeSpans, plainTextInsertions, (segment) =>
    segments.push(segment),
  );
  return {
    text: processedText,
    flexMessages: segments.flatMap((segment) => (segment.type === "flex" ? [segment.message] : [])),
    ...(plainTextInsertions.length > 0 ? { segments } : {}),
  };
}

/** Check if text contains markdown that needs conversion. */
export function hasMarkdownToConvert(text: string): boolean {
  const { ir, tables } = parseLineMarkdown(text);
  return (
    tables.length > 0 ||
    ir.styles.length > 0 ||
    ir.links.length > 0 ||
    /<\/?u>/i.test(ir.text) ||
    ir.text !== text.trimEnd()
  );
}
