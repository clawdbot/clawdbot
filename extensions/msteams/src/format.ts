import { randomUUID } from "node:crypto";
import {
  convertMarkdownTables,
  FormatCapabilityProfile,
  type MarkdownIR,
  markdownToIR,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";
import type { MarkdownTableMode } from "../runtime-api.js";

const ESCAPED_MARKDOWN_RE = /\\[\\`*_{}[\]()#+\-.!|>~]/gu;
const MARKDOWN_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/giu;
const TOKEN_END = "\u{E002}";

// Teams supports strikethrough on desktop and iOS, but not Android.
const MSTEAMS_FORMAT_CAPABILITIES = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "fallback",
    codeLanguage: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
  },
  chunk: { limit: 80_000, unit: "utf16", hardCap: 100_000 },
});

const MSTEAMS_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  strikethrough: { open: "~~", close: "~~" },
} as const;

function createTokenPrefix(text: string, label: string): string {
  const normalized = markdownToIR(text, { autolink: false, linkify: false }).text;
  let prefix: string;
  do {
    prefix = `\u{E000}${label}-${randomUUID()}\u{E001}`;
  } while (text.includes(prefix) || normalized.includes(prefix));
  return prefix;
}

function restoreTokens(text: string, prefix: string, values: readonly string[]): string {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.replace(
    new RegExp(`${escapedPrefix}(\\d+)${TOKEN_END}`, "gu"),
    (_token, index: string) => values[Number(index)] ?? "",
  );
}

type TextEdit = { start: number; end: number; text: string };

function rewriteMarkdownIR(ir: MarkdownIR, edits: readonly TextEdit[]): MarkdownIR {
  const ordered = [...edits].toSorted((a, b) => a.start - b.start);
  let text = "";
  let cursor = 0;
  for (const edit of ordered) {
    text += ir.text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  text += ir.text.slice(cursor);

  const cumulativeDeltas: number[] = [];
  let delta = 0;
  for (const edit of ordered) {
    delta += edit.text.length - (edit.end - edit.start);
    cumulativeDeltas.push(delta);
  }
  const exactEdits = new Map(ordered.map((edit) => [`${edit.start}:${edit.end}`, edit]));
  const mapOffset = (offset: number): number => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if ((ordered[middle]?.end ?? Number.POSITIVE_INFINITY) <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return offset + (low > 0 ? (cumulativeDeltas[low - 1] ?? 0) : 0);
  };
  const mapRange = <T extends { start: number; end: number }>(range: T): T => {
    const exact = exactEdits.get(`${range.start}:${range.end}`);
    const start = mapOffset(range.start);
    return { ...range, start, end: exact ? start + exact.text.length : mapOffset(range.end) };
  };
  return {
    ...ir,
    text,
    styles: ir.styles.map(mapRange),
    links: ir.links.map(mapRange),
    ...(ir.annotations ? { annotations: ir.annotations.map(mapRange) } : {}),
    ...(ir.listItems
      ? {
          listItems: ir.listItems.map((item) => ({
            ...item,
            ...(item.listMarker ? { listMarker: mapRange(item.listMarker) } : {}),
            ...(item.taskMarker ? { taskMarker: mapRange(item.taskMarker) } : {}),
          })),
        }
      : {}),
  };
}

function prefixMSTeamsBlockquotes(ir: MarkdownIR): MarkdownIR {
  const quoteSpans = ir.styles.filter((span) => span.style === "blockquote");
  const edits = quoteSpans.flatMap((span) => {
    const positions = [span.start];
    for (let index = span.start; index < span.end; index += 1) {
      if (ir.text[index] === "\n" && index + 1 < span.end) {
        positions.push(index + 1);
      }
    }
    return positions.map((position) => ({ start: position, end: position, text: "> " }));
  });
  const rewritten = rewriteMarkdownIR(ir, edits);
  return {
    ...rewritten,
    styles: rewritten.styles.filter((span) => span.style !== "blockquote"),
  };
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/gu)?.map((run) => run.length) ?? []));
}

function renderMSTeamsCode(style: "code" | "code_block", text: string): string {
  const marker = "`".repeat(Math.max(style === "code_block" ? 3 : 1, longestBacktickRun(text) + 1));
  if (style === "code_block") {
    return `${marker}\n${text}${marker}`;
  }
  const needsPadding =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && text.trim().length > 0);
  return `${marker}${needsPadding ? " " : ""}${text}${needsPadding ? " " : ""}${marker}`;
}

function serializeMarkdownDestination(href: string): string {
  return `<${href.replace(/([\\<>])/gu, "\\$1")}>`;
}

type ImageCandidateScan = { end: number } | { next: number } | undefined;

function blankBlockEnd(text: string, index: number): number | undefined {
  const match = /^(?:\r?\n)[ \t]*(?:\r?\n)/u.exec(text.slice(index));
  return match ? index + match[0].length : undefined;
}

function scanDelimitedMarkdown(
  text: string,
  start: number,
  nestedOpener: "![" | "@[",
): ImageCandidateScan {
  let bracketDepth = 1;
  let altEnd: number | undefined;
  let fallbackNext: number | undefined;
  for (let index = start + 2; index < text.length; index += 1) {
    const blankEnd = blankBlockEnd(text, index);
    if (blankEnd !== undefined) {
      return { next: fallbackNext ?? blankEnd };
    }
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith(nestedOpener, index)) {
      fallbackNext = index;
      bracketDepth += 1;
      index += 1;
    } else if (text[index] === "[") {
      bracketDepth += 1;
    } else if (text[index] === "]" && --bracketDepth === 0) {
      altEnd = index;
      break;
    }
  }
  if (altEnd === undefined || text[altEnd + 1] !== "(") {
    const next =
      fallbackNext ?? text.indexOf(nestedOpener, altEnd === undefined ? start + 2 : altEnd + 1);
    return next < 0 ? undefined : { next };
  }
  let parenDepth = 1;
  for (let index = altEnd + 2; index < text.length; index += 1) {
    const blankEnd = blankBlockEnd(text, index);
    if (blankEnd !== undefined) {
      return { next: fallbackNext ?? blankEnd };
    }
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith(nestedOpener, index)) {
      fallbackNext = index;
    } else if (text[index] === "(") {
      parenDepth += 1;
    } else if (text[index] === ")" && --parenDepth === 0) {
      return { end: index + 1 };
    }
  }
  return fallbackNext === undefined ? undefined : { next: fallbackNext };
}

function protectMarkdownImages(text: string, tokenPrefix: string, images: string[]): string {
  let protectedText = "";
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("![", searchFrom);
    if (start < 0) {
      break;
    }
    const scan = scanDelimitedMarkdown(text, start, "![");
    if (!scan) {
      break;
    }
    if ("next" in scan) {
      searchFrom = scan.next;
      continue;
    }
    protectedText += text.slice(cursor, start);
    const index = images.push(text.slice(start, scan.end)) - 1;
    protectedText += `${tokenPrefix}i${index}${TOKEN_END}`;
    cursor = scan.end;
    searchFrom = scan.end;
  }
  return protectedText + text.slice(cursor);
}

function protectMSTeamsMentions(text: string, tokenPrefix: string, mentions: string[]): string {
  let protectedText = "";
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("@[", searchFrom);
    if (start < 0) {
      break;
    }
    const scan = scanDelimitedMarkdown(text, start, "@[");
    if (!scan) {
      break;
    }
    if ("next" in scan) {
      searchFrom = scan.next;
      continue;
    }
    protectedText += text.slice(cursor, start);
    const index = mentions.push(text.slice(start, scan.end)) - 1;
    protectedText += `${tokenPrefix}m${index}${TOKEN_END}`;
    cursor = scan.end;
    searchFrom = scan.end;
  }
  return protectedText + text.slice(cursor);
}

function parseQuotePrefix(line: string): { content: string; depth: number; prefix: string } {
  let cursor = 0;
  let depth = 0;
  while (cursor < line.length) {
    const checkpoint = cursor;
    let spaces = 0;
    while (spaces < 3 && line[cursor] === " ") {
      cursor += 1;
      spaces += 1;
    }
    if (line[cursor] !== ">") {
      cursor = checkpoint;
      break;
    }
    cursor += 1;
    depth += 1;
    if (line[cursor] === " " || line[cursor] === "\t") {
      cursor += 1;
    }
  }
  return { content: line.slice(cursor).replace(/\r$/u, ""), depth, prefix: line.slice(0, cursor) };
}

function isTableDelimiterLine(content: string): boolean {
  const trimmed = content.trim();
  const inner = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = inner.split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/u.test(cell));
}

function protectRawTablesInSegment(text: string, tokenPrefix: string, rawTables: string[]): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const header = parseQuotePrefix(line);
    const delimiter = parseQuotePrefix(lines[index + 1] ?? "");
    if (
      header.content.includes("|") &&
      delimiter.depth === header.depth &&
      isTableDelimiterLine(delimiter.content)
    ) {
      let end = index + 2;
      while (end < lines.length) {
        const row = parseQuotePrefix(lines[end] ?? "");
        if (
          row.depth !== header.depth ||
          !row.content.trim() ||
          isInterruptingBlock(lines[end] ?? "")
        ) {
          break;
        }
        end += 1;
      }
      const table = lines.slice(index, end).join("\n");
      if (convertMarkdownTables(table, "code") !== table) {
        const tableIndex = rawTables.push(table.slice(header.prefix.length)) - 1;
        output.push(`${header.prefix}${tokenPrefix}t${tableIndex}${TOKEN_END}`);
        index = end;
        continue;
      }
      for (let lineIndex = index; lineIndex < end; lineIndex += 1) {
        output.push(lines[lineIndex] ?? "");
      }
      index = end;
      continue;
    }
    output.push(line);
    index += 1;
  }
  return output.join("\n");
}

function isInterruptingBlock(line: string): boolean {
  const content = parseQuotePrefix(line).content;
  return /^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:[-+*]|\d+[.)])[ \t]+)/u.test(content);
}

function leadingQuoteDepth(line: string): number {
  return parseQuotePrefix(line).depth;
}

function parseFenceLine(
  line: string,
):
  | { marker: string; quoteDepth: number; trailing: string; listIndent: number; indent: number }
  | undefined {
  const match =
    /^((?: {0,3}>[ \t]?)*)(?:((?:[-+*]|\d+[.)])[ \t]+))?( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  const marker = match?.[4];
  const trailing = match?.[5] ?? "";
  if (!marker || (marker.startsWith("`") && trailing.includes("`"))) {
    return undefined;
  }
  return {
    marker,
    quoteDepth: match?.[1]?.match(/>/gu)?.length ?? 0,
    trailing,
    listIndent: match?.[2]?.length ?? 0,
    indent: match?.[3]?.length ?? 0,
  };
}

function protectRawTablesOutsideFences(
  text: string,
  tokenPrefix: string,
  rawTables: string[],
): string {
  let result = "";
  let outsideStart = 0;
  let fenceStart: number | undefined;
  let active: { marker: string; quoteDepth: number; listIndent: number } | undefined;
  let listContextIndent = 0;
  let offset = 0;
  while (offset <= text.length) {
    const nextNewline = text.indexOf("\n", offset);
    const lineEnd = nextNewline < 0 ? text.length : nextNewline;
    const line = text.slice(offset, lineEnd).replace(/\r$/u, "");
    let fence = parseFenceLine(line);
    const lineQuoteDepth = leadingQuoteDepth(line);
    const lineWithoutQuotes = line.replace(/^(?:[ \t]*>[ \t]?)+/u, "");
    const lineIndent = /^[ \t]*/u.exec(lineWithoutQuotes)?.[0].length ?? 0;
    const listMarkerIndent = /^((?:[-+*]|\d+[.)])[ \t]+)/u.exec(lineWithoutQuotes)?.[1]?.length;
    if (listMarkerIndent) {
      listContextIndent = listMarkerIndent;
    } else if (line.trim() && lineIndent < listContextIndent && !fence) {
      listContextIndent = 0;
    }
    if (
      fence &&
      fence.listIndent === 0 &&
      listContextIndent > 0 &&
      fence.indent >= listContextIndent
    ) {
      fence = { ...fence, listIndent: listContextIndent };
    }
    const listOutdented = Boolean(
      active?.listIndent && line.trim() && lineIndent < active.listIndent && !fence,
    );
    if (active && (active.quoteDepth > lineQuoteDepth || listOutdented)) {
      result += text.slice(fenceStart, offset);
      outsideStart = offset;
      active = undefined;
      fenceStart = undefined;
    }
    if (!active && fence) {
      result += protectRawTablesInSegment(text.slice(outsideStart, offset), tokenPrefix, rawTables);
      fenceStart = offset;
      active = {
        marker: fence.marker,
        quoteDepth: fence.quoteDepth,
        listIndent: fence.listIndent,
      };
    } else if (
      active &&
      fence &&
      fence.marker[0] === active.marker[0] &&
      fence.marker.length >= active.marker.length &&
      fence.quoteDepth === active.quoteDepth &&
      /^[ \t]*$/u.test(fence.trailing)
    ) {
      const fenceEnd = nextNewline < 0 ? lineEnd : nextNewline + 1;
      result += text.slice(fenceStart, fenceEnd);
      outsideStart = fenceEnd;
      active = undefined;
      fenceStart = undefined;
    }
    if (nextNewline < 0) {
      break;
    }
    offset = nextNewline + 1;
  }
  if (active && fenceStart !== undefined) {
    result += text.slice(fenceStart);
    return result;
  }
  return result + protectRawTablesInSegment(text.slice(outsideStart), tokenPrefix, rawTables);
}

function protectMSTeamsCode(
  ir: MarkdownIR,
  tokenPrefix: string,
  code: string[],
  protectedValues: readonly { prefix: string; values: readonly string[] }[],
): MarkdownIR {
  const codeSpans = ir.styles.filter(
    (span) => span.style === "code" || span.style === "code_block",
  );
  const codeBlocks = codeSpans.filter((span) => span.style === "code_block");
  const adjustedStyles = ir.styles.flatMap((span) => {
    if (span.style !== "blockquote") {
      return [span];
    }
    let segments = [span];
    for (const codeBlock of codeBlocks) {
      segments = segments.flatMap((segment) => {
        if (codeBlock.end <= segment.start || codeBlock.start >= segment.end) {
          return [segment];
        }
        return [
          ...(segment.start < codeBlock.start ? [{ ...segment, end: codeBlock.start }] : []),
          ...(codeBlock.end < segment.end ? [{ ...segment, start: codeBlock.end }] : []),
        ];
      });
    }
    return segments;
  });
  const rewritten = rewriteMarkdownIR(
    { ...ir, styles: adjustedStyles },
    codeSpans.map((span) => {
      const codeStyle = span.style === "code_block" ? "code_block" : "code";
      const source = protectedValues.reduce(
        (text, protectedValue) => restoreTokens(text, protectedValue.prefix, protectedValue.values),
        ir.text.slice(span.start, span.end),
      );
      const quoteDepth =
        codeStyle === "code_block"
          ? ir.styles.filter(
              (candidate) =>
                candidate.style === "blockquote" &&
                span.start >= candidate.start &&
                span.start < candidate.end,
            ).length
          : 0;
      const rendered = renderMSTeamsCode(codeStyle, source);
      let quoted =
        quoteDepth > 0
          ? `${"> ".repeat(quoteDepth)}${rendered.replaceAll("\n", `\n${"> ".repeat(quoteDepth)}`)}`
          : rendered;
      const hasTrailingQuotedText =
        codeStyle === "code_block" &&
        ir.styles.some(
          (candidate) =>
            candidate.style === "blockquote" &&
            span.start >= candidate.start &&
            candidate.end > span.end,
        );
      if (hasTrailingQuotedText && !quoted.endsWith("\n")) {
        quoted += "\n";
      }
      const index = code.push(quoted) - 1;
      return { start: span.start, end: span.end, text: `${tokenPrefix}c${index}${TOKEN_END}` };
    }),
  );
  return {
    ...rewritten,
    styles: rewritten.styles.filter((span) => span.style !== "code" && span.style !== "code_block"),
  };
}

export function formatMSTeamsMarkdown(markdown: string, tableMode: MarkdownTableMode): string {
  const rawTables: string[] = [];
  const escapedMarkdown: string[] = [];
  const codeRegions: string[] = [];
  const images: string[] = [];
  const mentions: string[] = [];
  const entities: string[] = [];
  const tokenPrefix = createTokenPrefix(markdown, "msteamsformat");
  const entitiesProtected = markdown.replace(MARKDOWN_ENTITY_RE, (entity) => {
    const index = entities.push(entity) - 1;
    return `${tokenPrefix}h${index}${TOKEN_END}`;
  });
  const imagesProtected = protectMarkdownImages(entitiesProtected, tokenPrefix, images);
  const mentionsProtected = protectMSTeamsMentions(imagesProtected, tokenPrefix, mentions);
  const tableInput = convertMarkdownTables(mentionsProtected, tableMode);
  const converted =
    tableMode === "off"
      ? protectRawTablesOutsideFences(tableInput, tokenPrefix, rawTables)
      : tableInput;
  const protectedMarkdown = converted.replace(ESCAPED_MARKDOWN_RE, (escaped) => {
    const index = escapedMarkdown.push(escaped) - 1;
    return `${tokenPrefix}e${index}${TOKEN_END}`;
  });
  const parsed = markdownToIR(protectedMarkdown, {
    autolink: false,
    enableSpoilers: true,
    enableTaskLists: true,
    headingStyle: "rich",
    linkify: false,
    blockquotePrefix: "",
  });
  const ir = prefixMSTeamsBlockquotes(
    protectMSTeamsCode(parsed, tokenPrefix, codeRegions, [
      { prefix: `${tokenPrefix}e`, values: escapedMarkdown },
      { prefix: `${tokenPrefix}t`, values: rawTables },
      { prefix: `${tokenPrefix}m`, values: mentions },
      { prefix: `${tokenPrefix}i`, values: images },
      { prefix: `${tokenPrefix}h`, values: entities },
    ]),
  );
  const rendered = renderMarkdownWithMarkers(
    ir,
    {
      styleMarkers: MSTEAMS_MARKERS,
      escapeText: (text) => text,
      buildLink: (link) => ({
        start: link.start,
        end: link.end,
        open: "[",
        close: `](${serializeMarkdownDestination(link.href)})`,
      }),
    },
    MSTEAMS_FORMAT_CAPABILITIES,
  );
  let restored = restoreTokens(rendered, `${tokenPrefix}c`, codeRegions);
  restored = restoreTokens(restored, `${tokenPrefix}e`, escapedMarkdown);
  restored = restoreTokens(restored, `${tokenPrefix}t`, rawTables);
  restored = restoreTokens(restored, `${tokenPrefix}m`, mentions);
  restored = restoreTokens(restored, `${tokenPrefix}i`, images);
  return restoreTokens(restored, `${tokenPrefix}h`, entities);
}
