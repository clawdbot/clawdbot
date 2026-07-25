import { randomUUID } from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  FormatCapabilityProfile,
  markdownToIR,
  renderMarkdownWithAttributedRanges,
} from "openclaw/plugin-sdk/text-chunking";
import { TextStyle, type Style } from "./zca-constants.js";

type InlineStyle = (typeof TextStyle)[keyof typeof TextStyle];

type LineStyle = {
  lineIndex: number;
  style: InlineStyle;
  indentSize?: number;
};

type FenceMarker = {
  char: "`" | "~";
  length: number;
  indent: number;
};

type ActiveFence = FenceMarker & {
  quoteIndent: number;
};

const TAG_STYLE_MAP: Record<string, InlineStyle | null> = {
  red: TextStyle.Red,
  orange: TextStyle.Orange,
  yellow: TextStyle.Yellow,
  green: TextStyle.Green,
  small: null,
  big: TextStyle.Big,
  underline: TextStyle.Underline,
};

type LocalToken =
  | { kind: "literal"; text: string }
  | { kind: "tag-open"; id: number; style: InlineStyle | null }
  | { kind: "tag-close"; id: number }
  | { kind: "line-prefix" };

type TokenRegistry = {
  nextId: number;
  prefix: string;
  tokens: Map<string, LocalToken>;
};

type OrderedStyle = Style & { rawStart: number; rawEnd: number };

const ZALOUSER_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: {
    spoiler: "strip",
    codeInline: "fallback",
    codeBlock: "fallback",
    codeLanguage: "strip",
    linkLabel: "fallback",
    taskList: "fallback",
    table: "fallback",
    image: "strip",
    mention: "strip",
  },
  chunk: { limit: 2_000, unit: "utf16" },
});

const ZALOUSER_STYLE_MAP = {
  bold: TextStyle.Bold,
  italic: TextStyle.Italic,
  underline: TextStyle.Underline,
  strikethrough: TextStyle.StrikeThrough,
} as const;

const LOCAL_TAG_PATTERN = new RegExp(
  `\\{(${Object.keys(TAG_STYLE_MAP).join("|")})\\}(.+?)\\{/\\1\\}`,
  "g",
);
export function parseZalouserTextStyles(input: string): { text: string; styles: Style[] } {
  const registry: TokenRegistry = {
    nextId: 0,
    prefix: `<zalouser-${randomUUID()}-`,
    tokens: new Map(),
  };
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const lineStyles: LineStyle[] = [];
  const processedLines: string[] = [];
  let activeFence: ActiveFence | null = null;

  for (const [lineIndex, rawLine] of lines.entries()) {
    const { text: unquotedLine, indent: baseIndent } = stripQuotePrefix(rawLine);

    if (activeFence) {
      const codeLine =
        activeFence.quoteIndent > 0
          ? stripQuotePrefix(rawLine, activeFence.quoteIndent).text
          : rawLine;
      if (isClosingFence(codeLine, activeFence)) {
        activeFence = null;
        continue;
      }
      processedLines.push(
        protectLiteral(
          registry,
          normalizeCodeBlockLeadingWhitespace(stripCodeFenceIndent(codeLine, activeFence.indent)),
        ),
      );
      continue;
    }

    const line = unquotedLine;
    const openingFence = resolveOpeningFence(rawLine);
    if (openingFence) {
      const fenceLine = openingFence.quoteIndent > 0 ? unquotedLine : rawLine;
      if (!hasClosingFence(lines, lineIndex + 1, openingFence)) {
        processedLines.push(protectLiteral(registry, fenceLine));
        activeFence = openingFence;
        continue;
      }
      activeFence = openingFence;
      continue;
    }

    const outputLineIndex = processedLines.length;
    if (/^(?: {4,}|\t)/.test(line)) {
      addIndentStyle(lineStyles, outputLineIndex, baseIndent);
      processedLines.push(protectLiteral(registry, normalizeCodeBlockLeadingWhitespace(line)));
      continue;
    }

    const markdownPadding = line.match(/^( {1,3})(?=\S)/)?.[1]?.length ?? 0;
    const markdownLine = line.slice(markdownPadding);

    const headingMatch = markdownLine.match(/^(#{1,4})\s(.*)$/);
    if (headingMatch) {
      const depth = expectDefined(headingMatch[1], "heading marker capture").length;
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.Bold });
      if (depth === 1) {
        lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.Big });
      }
      addIndentStyle(lineStyles, outputLineIndex, baseIndent);
      processedLines.push(expectDefined(headingMatch[2], "heading body capture"));
      continue;
    }

    const indentMatch = markdownLine.match(/^(\s+)(.*)$/);
    let indentLevel = 0;
    let content = markdownLine;
    if (indentMatch) {
      indentLevel = Math.min(
        5,
        Math.max(1, Math.floor(expectDefined(indentMatch[1], "indent capture").length / 2)),
      );
      content = expectDefined(indentMatch[2], "indented content capture");
    }
    const totalIndent = Math.min(5, baseIndent + indentLevel);

    if (/^[-*+]\s\[[ xX]\]\s/.test(content)) {
      addIndentStyle(lineStyles, outputLineIndex, totalIndent);
      processedLines.push(content);
      continue;
    }

    const listMatch = content.match(/^(?:(\d+)\.|[-*+])\s(.*)$/);
    if (listMatch) {
      addIndentStyle(lineStyles, outputLineIndex, totalIndent);
      lineStyles.push({
        lineIndex: outputLineIndex,
        style: listMatch[1] ? TextStyle.OrderedList : TextStyle.UnorderedList,
      });
      processedLines.push(expectDefined(listMatch[2], "list body capture"));
      continue;
    }

    if (markdownPadding > 0) {
      addIndentStyle(lineStyles, outputLineIndex, baseIndent);
      processedLines.push(line);
      continue;
    }

    if (totalIndent > 0) {
      addIndentStyle(lineStyles, outputLineIndex, totalIndent);
      processedLines.push(content);
      continue;
    }

    processedLines.push(line);
  }

  const linePrefix = addToken(registry, { kind: "line-prefix" });
  const renderedLines = processedLines.map((line) => renderInlineLine(line, linePrefix, registry));
  const allStyles: Style[] = [];

  let offset = 0;
  for (const [lineIndex, line] of renderedLines.entries()) {
    const lineLength = line.text.length;
    for (const style of line.styles) {
      style.start += offset;
      allStyles.push(style);
    }
    if (lineLength > 0) {
      for (const lineStyle of lineStyles) {
        if (lineStyle.lineIndex !== lineIndex) {
          continue;
        }

        allStyles.push(
          lineStyle.style === TextStyle.Indent
            ? {
                start: offset,
                len: lineLength,
                st: TextStyle.Indent,
                indentSize: lineStyle.indentSize,
              }
            : ({ start: offset, len: lineLength, st: lineStyle.style } as Style),
        );
      }
    }
    offset += lineLength + 1;
  }

  return { text: renderedLines.map((line) => line.text).join("\n"), styles: allStyles };
}

function addIndentStyle(styles: LineStyle[], lineIndex: number, indentSize: number): void {
  if (indentSize > 0) {
    styles.push({ lineIndex, style: TextStyle.Indent, indentSize });
  }
}

function hasClosingFence(lines: string[], startIndex: number, fence: ActiveFence): boolean {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = expectDefined(lines[index], "closing fence scan index is in bounds");
    const candidate = fence.quoteIndent > 0 ? stripQuotePrefix(line, fence.quoteIndent).text : line;
    if (isClosingFence(candidate, fence)) {
      return true;
    }
  }
  return false;
}

function resolveOpeningFence(line: string): ActiveFence | null {
  const directFence = parseFenceMarker(line);
  if (directFence) {
    return { ...directFence, quoteIndent: 0 };
  }

  const quoted = stripQuotePrefix(line);
  if (quoted.indent === 0) {
    return null;
  }

  const quotedFence = parseFenceMarker(quoted.text);
  if (!quotedFence) {
    return null;
  }

  return {
    ...quotedFence,
    quoteIndent: quoted.indent,
  };
}

function stripQuotePrefix(
  line: string,
  maxDepth = Number.POSITIVE_INFINITY,
): { text: string; indent: number } {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") {
    cursor += 1;
  }

  let removedDepth = 0;
  let consumedCursor = cursor;
  while (removedDepth < maxDepth && consumedCursor < line.length && line[consumedCursor] === ">") {
    removedDepth += 1;
    consumedCursor += 1;
    if (line[consumedCursor] === " ") {
      consumedCursor += 1;
    }
  }

  if (removedDepth === 0) {
    return { text: line, indent: 0 };
  }

  return {
    text: line.slice(consumedCursor),
    indent: Math.min(5, removedDepth),
  };
}

function parseFenceMarker(line: string): FenceMarker | null {
  const match = line.match(/^([ ]{0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  const marker = expectDefined(match[2], "fence marker capture");
  const char = marker.charAt(0);
  if (char !== "`" && char !== "~") {
    return null;
  }

  return {
    char,
    length: marker.length,
    indent: expectDefined(match[1], "fence indent capture").length,
  };
}

function isClosingFence(line: string, fence: FenceMarker): boolean {
  const match = line.match(/^([ ]{0,3})(`{3,}|~{3,})[ \t]*$/);
  if (!match) {
    return false;
  }
  const marker = expectDefined(match[2], "closing fence marker capture");
  return marker.charAt(0) === fence.char && marker.length >= fence.length;
}

function protectLocalInlineSyntax(text: string, registry: TokenRegistry): string {
  const codeProtected = replaceValidMatches(text, /`([^`\n]+)`/g, (match) =>
    protectLiteral(registry, match[0]),
  );
  const escapesProtected = codeProtected
    .replace(/\\([!-/:-@[-`{-~])/g, (match, character: string) =>
      "*_~#\\{}>+-`".includes(character) ? match : protectLiteral(registry, match),
    )
    .replace(/\\[ \t]+(?=\n|$)/g, (match) => protectLiteral(registry, match))
    .replace(/\\(?=\n|$)/g, (match) => protectLiteral(registry, match));
  const authoredUnderlineProtected = escapesProtected.replace(/<\/?(?:u|ins)\b[^>]*>/gi, (tag) =>
    protectLiteral(registry, tag),
  );
  const entitiesProtected = authoredUnderlineProtected.replace(
    /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/gi,
    (entity) => protectLiteral(registry, entity),
  );
  const punctuationProtected = entitiesProtected
    .replace(/\[/g, (character) => protectLiteral(registry, character))
    .replace(/[ \t]+(?=\n|$)/g, (whitespace) => protectLiteral(registry, whitespace));
  const remainingBackticksEscaped = punctuationProtected.replace(/`/g, (marker, index, source) =>
    isEscaped(source, index) ? marker : `\\${marker}`,
  );
  return replaceValidMatches(remainingBackticksEscaped, LOCAL_TAG_PATTERN, (match) => {
    const tag = expectDefined(match[1], "tag name capture");
    const body = protectLocalInlineSyntax(expectDefined(match[2], "tag body capture"), registry);
    const style = TAG_STYLE_MAP[tag] ?? null;
    if (style === TextStyle.Underline) {
      return `<u>${body}</u>`;
    }
    const id = registry.tokens.size;
    return `${addToken(registry, { kind: "tag-open", id, style })} ${body} ${addToken(registry, {
      kind: "tag-close",
      id,
    })}`;
  });
}

function replaceValidMatches(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string,
): string {
  const regex = new RegExp(pattern.source, pattern.flags);
  let output = "";
  let cursor = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    if (isEscaped(text, match.index)) {
      regex.lastIndex = match.index + 1;
      continue;
    }
    output += text.slice(cursor, match.index) + replace(match);
    cursor = match.index + match[0].length;
  }
  return output + text.slice(cursor);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function protectLiteral(registry: TokenRegistry, text: string): string {
  return addToken(registry, { kind: "literal", text });
}

function addToken(registry: TokenRegistry, token: LocalToken): string {
  const value = `${registry.prefix}${registry.nextId}>`;
  registry.nextId += 1;
  registry.tokens.set(value, token);
  return value;
}

function renderInlineLine(
  line: string,
  linePrefix: string,
  registry: TokenRegistry,
): { text: string; styles: Style[] } {
  if (!line) {
    return { text: "", styles: [] };
  }
  const ir = markdownToIR(`${linePrefix} ${protectLocalInlineSyntax(line, registry)}`, {
    autolink: false,
    enableHtmlUnderline: true,
    headingStyle: "none",
    linkify: false,
    tableMode: "off",
  });
  const rendered = renderMarkdownWithAttributedRanges(
    ir,
    { styleMap: ZALOUSER_STYLE_MAP },
    ZALOUSER_FORMAT_PROFILE,
  );
  return projectLocalTokens(rendered, registry);
}

function projectLocalTokens(
  rendered: ReturnType<typeof renderMarkdownWithAttributedRanges<InlineStyle>>,
  registry: TokenRegistry,
): { text: string; styles: Style[] } {
  const offsets = Array.from({ length: rendered.text.length + 1 }, () => 0);
  const openTags = new Map<
    number,
    { start: number; rawStart: number; style: InlineStyle | null }
  >();
  const orderedStyles: OrderedStyle[] = [];
  let text = "";

  for (let index = 0; index < rendered.text.length; index += 1) {
    offsets[index] = text.length;
    const character = rendered.text[index] ?? "";
    const match = findLocalToken(rendered.text, index, registry);
    const nextMatch = character === " " ? findLocalToken(rendered.text, index + 1, registry) : null;
    if (nextMatch?.token.kind === "tag-close") {
      offsets[index + 1] = text.length;
      continue;
    }
    if (!match) {
      text += character;
      offsets[index + 1] = text.length;
      continue;
    }
    const { token } = match;
    const tokenStart = text.length;
    for (let cursor = index + 1; cursor < match.end; cursor += 1) {
      offsets[cursor] = tokenStart;
    }
    if (token.kind === "literal") {
      text += token.text;
    } else if (token.kind === "tag-open") {
      openTags.set(token.id, { start: text.length, rawStart: index, style: token.style });
    } else if (token.kind === "tag-close") {
      const open = openTags.get(token.id);
      if (open?.style && text.length > open.start) {
        orderedStyles.push({
          start: open.start,
          len: text.length - open.start,
          st: open.style,
          rawStart: open.rawStart,
          rawEnd: index,
        } as OrderedStyle);
      }
      openTags.delete(token.id);
    }
    let consumedEnd = match.end;
    if (
      (token.kind === "line-prefix" || token.kind === "tag-open") &&
      rendered.text[consumedEnd] === " "
    ) {
      offsets[consumedEnd] = text.length;
      consumedEnd += 1;
    }
    offsets[consumedEnd] = text.length;
    index = consumedEnd - 1;
  }

  orderedStyles.push(
    ...rendered.ranges.map((range) => ({
      start: offsets[range.start] ?? text.length,
      len:
        (offsets[range.start + range.length] ?? text.length) -
        (offsets[range.start] ?? text.length),
      st: range.style,
      rawStart: range.start,
      rawEnd: range.start + range.length,
    })),
  );
  return {
    text,
    styles: orderedStyles
      .filter((style) => style.len > 0)
      .toSorted((left, right) => left.rawStart - right.rawStart || right.rawEnd - left.rawEnd)
      .map(({ rawStart: _rawStart, rawEnd: _rawEnd, ...style }) => style),
  };
}

function findLocalToken(
  text: string,
  index: number,
  registry: TokenRegistry,
): { end: number; token: LocalToken } | null {
  if (!text.startsWith(registry.prefix, index)) {
    return null;
  }
  const end = text.indexOf(">", index + registry.prefix.length);
  if (end === -1) {
    return null;
  }
  const token = registry.tokens.get(text.slice(index, end + 1));
  return token ? { end: end + 1, token } : null;
}

function normalizeCodeBlockLeadingWhitespace(line: string): string {
  return line.replace(/^[ \t]+/, (leadingWhitespace) =>
    leadingWhitespace.replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0").replace(/ /g, "\u00A0"),
  );
}

function stripCodeFenceIndent(line: string, indent: number): string {
  let consumed = 0;
  let cursor = 0;

  while (cursor < line.length && consumed < indent && line[cursor] === " ") {
    cursor += 1;
    consumed += 1;
  }

  return line.slice(cursor);
}
