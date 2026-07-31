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
import { createReceiptCard, toFlexMessage, type FlexBubble } from "./flex-templates.js";
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
}

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

function parseLineMarkdown(text: string, tableMode: "block" | "off" = "block") {
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
    code: ir.text.slice(span.start, span.end).trim(),
  };
}

type PlainTextInsertion = { position: number; text: string };

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

function projectPlainText(ir: MarkdownIR, omitted: MarkdownStyleSpan[] = []): string {
  const insertions: PlainTextInsertion[] = [];
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
  let cursor = 0;
  let insertionIndex = 0;
  const appendRange = (end: number) => {
    while (insertionIndex < insertions.length) {
      const insertion = insertions[insertionIndex];
      if (!insertion || insertion.position > end) {
        break;
      }
      if (insertion.position >= cursor) {
        output += ir.text.slice(cursor, insertion.position) + insertion.text;
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
  return output.trim();
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
    block.code.length > 2000 ? truncateUtf16Safe(block.code, 2000) + "\n..." : block.code;

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
  return {
    text: projectPlainText(ir, codeSpans),
    flexMessages: [
      ...tables.map((table) =>
        toFlexMessage("Table", convertTableToFlexBubble(toMarkdownTable(table))),
      ),
      ...codeSpans.map((span) =>
        toFlexMessage("Code", convertCodeBlockToFlexBubble(toCodeBlock(ir, span))),
      ),
    ],
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
