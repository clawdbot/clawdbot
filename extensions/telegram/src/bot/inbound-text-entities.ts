import type { MessageEntity } from "grammy/types";

type TelegramMarkdownBoundary = {
  open: string;
  close: string;
  start: number;
  end: number;
  length: number;
  priority: number;
  index: number;
};

const TELEGRAM_ENTITY_MARKDOWN_PRIORITY: Partial<Record<MessageEntity["type"], number>> = {
  blockquote: 0,
  expandable_blockquote: 0,
  bold: 10,
  italic: 20,
  underline: 30,
  strikethrough: 40,
  spoiler: 50,
  text_link: 60,
  code: 70,
  pre: 80,
};

const SPLITTABLE_FORMATTING_ENTITY_TYPES = new Set<MessageEntity["type"]>([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
]);

function isTelegramBlockquoteEntity(entity: MessageEntity): boolean {
  return entity.type === "blockquote" || entity.type === "expandable_blockquote";
}

function hasValidTelegramEntityRange(text: string, entity: MessageEntity): boolean {
  return (
    Number.isInteger(entity.offset) &&
    Number.isInteger(entity.length) &&
    entity.offset >= 0 &&
    entity.length > 0 &&
    entity.offset + entity.length <= text.length
  );
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function markdownInlineCodeDelimiters(content: string): [string, string] {
  const delimiter = "`".repeat(longestBacktickRun(content) + 1);
  // Padding keeps literal edge backticks separate from the Markdown delimiters.
  const padding = /^[ `]|[ `]$/u.test(content) ? " " : "";
  return [`${delimiter}${padding}`, `${padding}${delimiter}`];
}

function markdownPreAffixes(
  entity: Extract<MessageEntity, { type: "pre" }>,
  content: string,
): [string, string] {
  const language = entity.language?.replace(/[\s`]+/g, "").trim();
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const opener = language ? `${fence}${language}\n` : `${fence}\n`;
  const closer = content.endsWith("\n") ? fence : `\n${fence}`;
  return [opener, closer];
}

function markdownAffixesForTelegramEntity(
  entity: MessageEntity,
  content: string,
): [string, string] | null {
  switch (entity.type) {
    case "blockquote":
    case "expandable_blockquote":
      return ["> ", ""];
    case "bold":
      return ["**", "**"];
    case "italic":
      return ["_", "_"];
    case "underline":
      return ["__", "__"];
    case "strikethrough":
      return ["~~", "~~"];
    case "spoiler":
      return ["||", "||"];
    case "code":
      return markdownInlineCodeDelimiters(content);
    case "pre":
      return markdownPreAffixes(entity, content);
    case "text_link":
      return [
        "[",
        `](${entity.url.replace(/[\\()<>\s]/gu, (character) =>
          character === "(" || character === ")" ? `\\${character}` : encodeURIComponent(character),
        )})`,
      ];
    default:
      return null;
  }
}

function splitTelegramFormattingAtQuoteEdges(
  text: string,
  entity: MessageEntity,
  quoteEdges: readonly number[],
): MessageEntity[] {
  if (!SPLITTABLE_FORMATTING_ENTITY_TYPES.has(entity.type)) {
    return [entity];
  }
  const entityEnd = entity.offset + entity.length;
  const interiorEdges = quoteEdges.filter((offset) => entity.offset < offset && offset < entityEnd);
  if (interiorEdges.length === 0) {
    return [entity];
  }

  // Markdown formatting cannot cross a block boundary. Reopen it around each quote.
  const segments: MessageEntity[] = [];
  let segmentStart = entity.offset;
  for (const edge of [...interiorEdges, entityEnd]) {
    let segmentEnd = edge;
    while (segmentStart < segmentEnd && /\s/u.test(text.charAt(segmentStart))) {
      segmentStart += 1;
    }
    while (segmentEnd > segmentStart && /\s/u.test(text.charAt(segmentEnd - 1))) {
      segmentEnd -= 1;
    }
    if (segmentStart < segmentEnd) {
      segments.push({ ...entity, offset: segmentStart, length: segmentEnd - segmentStart });
    }
    segmentStart = edge;
  }
  return segments;
}

function resolveTelegramBlockquoteClose(text: string, start: number, end: number): string {
  let presentBreaks = 0;
  let offset = end;
  while (offset > start && text.charAt(offset - 1) === "\n") {
    presentBreaks += 1;
    offset -= text.charAt(offset - 2) === "\r" ? 2 : 1;
  }
  offset = end;
  while (offset < text.length) {
    if (text.charAt(offset) === "\n") {
      presentBreaks += 1;
      offset += 1;
    } else if (text.charAt(offset) === "\r" && text.charAt(offset + 1) === "\n") {
      presentBreaks += 1;
      offset += 2;
    } else {
      break;
    }
  }
  const requiredBreaks = end < text.length ? 2 : 1;
  const missingBreaks = requiredBreaks - presentBreaks;
  const lineBreak = text.charAt(end) === "\r" || text.charAt(end - 2) === "\r" ? "\r\n" : "\n";
  return lineBreak.repeat(Math.max(0, missingBreaks));
}

export function renderTelegramTextEntities(
  text: string,
  entities?: readonly MessageEntity[] | null,
): string {
  if (!text || !entities?.length) {
    return text;
  }

  const quotedLineStarts = new Set<number>();
  const quoteEdges = new Set<number>();
  for (const entity of entities) {
    if (!isTelegramBlockquoteEntity(entity) || !hasValidTelegramEntityRange(text, entity)) {
      continue;
    }
    const end = entity.offset + entity.length;
    quoteEdges.add(entity.offset);
    quoteEdges.add(end);
    for (let offset = entity.offset + 1; offset < end; offset += 1) {
      if (text[offset - 1] === "\n") {
        quotedLineStarts.add(offset);
      }
    }
  }

  const sortedQuoteEdges = [...quoteEdges].toSorted((left, right) => left - right);
  const boundaries = new Map<number, TelegramMarkdownBoundary[]>();
  const escapedLinkLabelOffsets = new Set<number>();
  const addBoundary = (offset: number, boundary: TelegramMarkdownBoundary) => {
    const entries = boundaries.get(offset);
    if (entries) {
      entries.push(boundary);
    } else {
      boundaries.set(offset, [boundary]);
    }
  };
  entities.forEach((entity, index) => {
    if (!hasValidTelegramEntityRange(text, entity)) {
      return;
    }
    for (const segment of splitTelegramFormattingAtQuoteEdges(text, entity, sortedQuoteEdges)) {
      const content = text.slice(segment.offset, segment.offset + segment.length);
      if (segment.type === "text_link") {
        for (const match of content.matchAll(/[\\[\]]/gu)) {
          escapedLinkLabelOffsets.add(segment.offset + match.index);
        }
      }
      const affixes = markdownAffixesForTelegramEntity(segment, content);
      if (!affixes) {
        continue;
      }
      const end = segment.offset + segment.length;
      if (isTelegramBlockquoteEntity(segment)) {
        affixes[1] = resolveTelegramBlockquoteClose(text, segment.offset, end);
      }
      const boundary: TelegramMarkdownBoundary = {
        open: affixes[0],
        close: affixes[1],
        start: segment.offset,
        end,
        length: segment.length,
        priority: TELEGRAM_ENTITY_MARKDOWN_PRIORITY[segment.type] ?? 100,
        index,
      };
      addBoundary(boundary.start, boundary);
      addBoundary(boundary.end, boundary);
    }
  });

  if (boundaries.size === 0) {
    return text;
  }

  let result = "";
  for (let offset = 0; offset <= text.length; offset += 1) {
    if (quotedLineStarts.has(offset)) {
      result += "> ";
    }
    const boundary = boundaries.get(offset);
    if (boundary) {
      boundary
        .filter((entity) => entity.end === offset)
        .toSorted((a, b) => a.length - b.length || b.priority - a.priority || b.index - a.index)
        .forEach((entity) => {
          result += entity.close;
        });
      boundary
        .filter((entity) => entity.start === offset)
        .toSorted((a, b) => b.length - a.length || a.priority - b.priority || a.index - b.index)
        .forEach((entity) => {
          result += entity.open;
        });
    }
    if (offset < text.length) {
      result += escapedLinkLabelOffsets.has(offset) ? `\\${text[offset]}` : text[offset];
    }
  }
  return result;
}
