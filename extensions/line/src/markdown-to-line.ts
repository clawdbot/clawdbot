// Line plugin module implements markdown to line behavior.
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { uriAction } from "./actions.js";
import { createReceiptCard, toFlexMessage, type FlexBubble } from "./flex-templates.js";
export { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";

type FlexMessage = messagingApi.FlexMessage;
type FlexComponent = messagingApi.FlexComponent;
type FlexText = messagingApi.FlexText;
type FlexBox = messagingApi.FlexBox;

export interface ProcessedLineMessage {
  /** The processed text with markdown stripped */
  text: string;
  /** Flex messages extracted from tables/code blocks */
  flexMessages: FlexMessage[];
}

/**
 * Regex patterns for markdown detection
 */
const MARKDOWN_TABLE_REGEX = /^\|(.+)\|[\r\n]+\|[-:\s|]+\|[\r\n]+((?:\|.+\|[\r\n]*)+)/gm;
const MARKDOWN_CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Detect and extract markdown tables from text
 */
export function extractMarkdownTables(text: string): {
  tables: MarkdownTable[];
  textWithoutTables: string;
} {
  const tables: MarkdownTable[] = [];
  let textWithoutTables = text;

  // Reset regex state
  MARKDOWN_TABLE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  const matches: { fullMatch: string; table: MarkdownTable }[] = [];

  while ((match = MARKDOWN_TABLE_REGEX.exec(text)) !== null) {
    const fullMatch = expectDefined(match[0], "Markdown table match");
    const headerLine = expectDefined(match[1], "Markdown table header capture");
    const bodyLines = expectDefined(match[2], "Markdown table body capture");

    const headers = parseTableRow(headerLine);
    const rows = bodyLines
      .trim()
      .split(/[\r\n]+/)
      .filter((line) => line.trim())
      .map(parseTableRow);

    if (headers.length > 0 && rows.length > 0) {
      matches.push({
        fullMatch,
        table: { headers, rows },
      });
    }
  }

  // Remove tables from text in reverse order to preserve indices
  for (const { fullMatch, table } of matches.toReversed()) {
    tables.unshift(table);
    textWithoutTables = textWithoutTables.replace(fullMatch, "");
  }

  return { tables, textWithoutTables };
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/**
 * Parse a single table row (pipe-separated values)
 */
function parseTableRow(row: string): string[] {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => {
      // Filter out empty cells at start/end (from leading/trailing pipes)
      if (index === 0 && cell === "") {
        return false;
      }
      if (index === arr.length - 1 && cell === "") {
        return false;
      }
      return true;
    });
}

/**
 * Convert a markdown table to a LINE Flex Message bubble
 */
export function convertTableToFlexBubble(table: MarkdownTable): FlexBubble {
  const parseCell = (
    value: string | undefined,
  ): { text: string; bold: boolean; hasMarkup: boolean } => {
    const raw = value?.trim() ?? "";
    if (!raw) {
      return { text: "-", bold: false, hasMarkup: false };
    }

    let hasMarkup = false;
    const stripped = raw.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
      hasMarkup = true;
      return String(inner);
    });
    const text = stripped.trim() || "-";
    const bold = /^\*\*.+\*\*$/.test(raw);

    return { text, bold, hasMarkup };
  };

  const headerCells = table.headers.map((header) => parseCell(header));
  const rowCells = table.rows.map((row) => row.map((cell) => parseCell(cell)));
  const hasInlineMarkup =
    headerCells.some((cell) => cell.hasMarkup) ||
    rowCells.some((row) => row.some((cell) => cell.hasMarkup));

  // For simple 2-column tables, use receipt card format
  if (table.headers.length === 2 && !hasInlineMarkup) {
    const items = rowCells.map((row) => ({
      name: row[0]?.text ?? "-",
      value: row[1]?.text ?? "-",
    }));

    return createReceiptCard({
      title: headerCells.map((cell) => cell.text).join(" / "),
      items,
    });
  }

  // For multi-column tables, create a custom layout
  const headerRow: FlexComponent = {
    type: "box",
    layout: "horizontal",
    contents: headerCells.map((cell) => ({
      type: "text",
      text: cell.text,
      weight: "bold",
      size: "sm",
      color: "#333333",
      flex: 1,
      wrap: true,
    })) as FlexText[],
    paddingBottom: "sm",
  } as FlexBox;

  const dataRows: FlexComponent[] = rowCells.slice(0, 10).map((row, rowIndex) => {
    const rowContents = table.headers.map((_, colIndex) => {
      const cell = row[colIndex] ?? { text: "-", bold: false, hasMarkup: false };
      return {
        type: "text",
        text: cell.text,
        size: "sm",
        color: "#666666",
        flex: 1,
        wrap: true,
        weight: cell.bold ? "bold" : undefined,
      };
    }) as FlexText[];

    return {
      type: "box",
      layout: "horizontal",
      contents: rowContents,
      margin: rowIndex === 0 ? "md" : "sm",
    } as FlexBox;
  });

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

/**
 * Detect and extract code blocks from text
 */
export function extractCodeBlocks(text: string): {
  codeBlocks: CodeBlock[];
  textWithoutCode: string;
} {
  const codeBlocks: CodeBlock[] = [];
  let textWithoutCode = text;

  // Reset regex state
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  const matches: { fullMatch: string; block: CodeBlock }[] = [];

  while ((match = MARKDOWN_CODE_BLOCK_REGEX.exec(text)) !== null) {
    const fullMatch = expectDefined(match[0], "Markdown code block match");
    const language = match[1] || undefined;
    const code = expectDefined(match[2], "Markdown code body capture");

    matches.push({
      fullMatch,
      block: { language, code: code.trim() },
    });
  }

  // Remove code blocks in reverse order
  for (const { fullMatch, block } of matches.toReversed()) {
    codeBlocks.unshift(block);
    textWithoutCode = textWithoutCode.replace(fullMatch, "");
  }

  return { codeBlocks, textWithoutCode };
}

export interface CodeBlock {
  language?: string;
  code: string;
}

/**
 * Convert a code block to a LINE Flex Message bubble
 */
export function convertCodeBlockToFlexBubble(block: CodeBlock): FlexBubble {
  const titleText = block.language ? `Code (${block.language})` : "Code";

  // Truncate very long code to fit LINE's limits
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

/**
 * Extract markdown links from text
 */
export function extractLinks(text: string): { links: MarkdownLink[]; textWithLinks: string } {
  const links: MarkdownLink[] = [];

  // Reset regex state
  MARKDOWN_LINK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_REGEX.exec(text)) !== null) {
    links.push({
      text: expectDefined(match[1], "Markdown link text capture"),
      url: expectDefined(match[2], "Markdown link URL capture"),
    });
  }

  // Replace markdown links with just the text (for plain text output)
  const textWithLinks = text.replace(MARKDOWN_LINK_REGEX, "$1");

  return { links, textWithLinks };
}

export interface MarkdownLink {
  text: string;
  url: string;
}

/**
 * Create a Flex Message with tappable link buttons
 */
export function convertLinksToFlexBubble(links: MarkdownLink[]): FlexBubble {
  const buttons: FlexComponent[] = links.slice(0, 4).map((link, index) => ({
    type: "button",
    action: uriAction(link.text, link.url),
    style: index === 0 ? "primary" : "secondary",
    margin: index > 0 ? "sm" : undefined,
  }));

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: "Links",
          weight: "bold",
          size: "md",
          color: "#333333",
        } as FlexText,
      ],
      paddingAll: "lg",
      paddingBottom: "sm",
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: buttons,
      paddingAll: "md",
    },
  };
}

/**
 * Main function: Process text for LINE output
 * - Extracts tables → Flex Messages
 * - Extracts code blocks → Flex Messages
 * - Strips remaining markdown
 * - Returns processed text + Flex Messages
 */
export function processLineMessage(text: string): ProcessedLineMessage {
  const flexMessages: FlexMessage[] = [];
  let processedText = text;

  // 1. Extract and convert tables
  const { tables, textWithoutTables } = extractMarkdownTables(processedText);
  processedText = textWithoutTables;

  for (const table of tables) {
    const bubble = convertTableToFlexBubble(table);
    flexMessages.push(toFlexMessage("Table", bubble));
  }

  // 2. Extract and convert code blocks
  const { codeBlocks, textWithoutCode } = extractCodeBlocks(processedText);
  processedText = textWithoutCode;

  for (const block of codeBlocks) {
    const bubble = convertCodeBlockToFlexBubble(block);
    flexMessages.push(toFlexMessage("Code", bubble));
  }

  // 3. Handle links - convert [text](url) to plain text for display
  // (We could also create link buttons, but that can get noisy)
  const { textWithLinks } = extractLinks(processedText);
  processedText = textWithLinks;

  // 4. Strip remaining markdown formatting
  processedText = stripMarkdown(processedText, { assistantTranscriptRoleHeaders: true });

  return {
    text: processedText,
    flexMessages,
  };
}

/**
 * Check if text contains markdown that needs conversion
 */
export function hasMarkdownToConvert(text: string): boolean {
  // Check for tables
  MARKDOWN_TABLE_REGEX.lastIndex = 0;
  if (MARKDOWN_TABLE_REGEX.test(text)) {
    return true;
  }

  // Check for code blocks
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;
  if (MARKDOWN_CODE_BLOCK_REGEX.test(text)) {
    return true;
  }

  // Check for other markdown patterns
  if (/\*\*[^*]+\*\*/.test(text)) {
    return true;
  } // bold
  if (/~~[^~]+~~/.test(text)) {
    return true;
  } // strikethrough
  if (/^#{1,6}\s+/m.test(text)) {
    return true;
  } // headers
  if (/^>\s+/m.test(text)) {
    return true;
  } // blockquotes

  return false;
}
