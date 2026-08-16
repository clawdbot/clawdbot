import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { renderMarkdownWithAttributedRanges } from "openclaw/plugin-sdk/text-chunking";
import {
  LOCAL_TAG_PATTERN,
  TAG_STYLE_MAP,
  type InlineStyle,
  type LocalToken,
  type OrderedStyle,
  type TokenRegistry,
} from "./text-styles-shared.js";
import { TextStyle, type Style } from "./zca-constants.js";

export function protectLocalInlineSyntax(
  text: string,
  registry: TokenRegistry,
  preservedOpenBrackets: ReadonlySet<number> = new Set(),
  preserveTrailingWhitespace = false,
): string {
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
  const bracketsProtected = entitiesProtected.replace(/\[/g, (character, index) =>
    preservedOpenBrackets.has(index) ? character : protectLiteral(registry, character),
  );
  const punctuationProtected = preserveTrailingWhitespace
    ? bracketsProtected
    : bracketsProtected.replace(/[ \t]+(?=\n|$)/g, (whitespace) =>
        protectLiteral(registry, whitespace),
      );
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

export function protectLiteral(registry: TokenRegistry, text: string): string {
  return addToken(registry, { kind: "literal", text });
}

function addToken(registry: TokenRegistry, token: LocalToken): string {
  const value = `${registry.prefix}${registry.nextId}>`;
  registry.nextId += 1;
  registry.tokens.set(value, token);
  return value;
}

export function projectLocalTokens(
  rendered: ReturnType<typeof renderMarkdownWithAttributedRanges<InlineStyle>>,
  registry: TokenRegistry,
): { text: string; styles: Style[]; offsets: number[] } {
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
    if (token.kind === "tag-open" && rendered.text[consumedEnd] === " ") {
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
    offsets,
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
