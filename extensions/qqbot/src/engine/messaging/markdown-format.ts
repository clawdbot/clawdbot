// QQ Bot Markdown formatting declares dialect capabilities and applies shared fallbacks.

import {
  FormatCapabilityProfile,
  type MarkdownIR,
  markdownToIR,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
  sliceMarkdownIR,
} from "openclaw/plugin-sdk/text-chunking";

const QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT = 3600;
const QQBOT_MARKDOWN_ESCAPE_RE = /([\\`*_{}[\]()#+\-.!|>~])/gu;
const ESCAPED_MARKDOWN_RE = /\\[\\`*_{}[\]()#+\-.!|>~]/gu;
const MARKDOWN_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/giu;
const PROTECTED_TOKEN_RANGES = [
  [0xe000, 0xf8ff],
  [0x3400, 0x9fff],
  [0xac00, 0xd7a3],
] as const;
const PROTECTED_TOKEN_RE = /[\u3400-\u9FFF\uAC00-\uD7A3\uE000-\uF8FF]/gu;
const PROTECTED_IMAGE_OVERHEAD_BYTES = 64;

function resolveQQBotMarkdownChunkLimit(limit: number): number {
  return Math.min(limit, QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT);
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const QQBOT_FORMAT_CAPABILITIES = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "strip",
    codeInline: "fallback",
    codeBlock: "fallback",
    codeLanguage: "fallback",
    table: "fallback",
  },
  chunk: { limit: QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT, unit: "bytes" },
});

const QQBOT_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  strikethrough: { open: "~~", close: "~~" },
  heading_1: { open: "# ", close: "" },
  heading_2: { open: "## ", close: "" },
  heading_3: { open: "### ", close: "" },
  heading_4: { open: "#### ", close: "" },
  heading_5: { open: "##### ", close: "" },
  heading_6: { open: "###### ", close: "" },
} as const;

function createProtectedTokenStore(source: string) {
  const normalized = markdownToIR(source, { autolink: false, linkify: false }).text;
  const occupied = new Set<string>();
  for (const text of [source, normalized]) {
    for (const character of text) {
      occupied.add(character);
    }
  }
  const values = new Map<string, string>();
  const reusable = new Map<string, string>();
  let rangeIndex = 0;
  let codePoint: number = PROTECTED_TOKEN_RANGES[0][0];
  const next = (value: string): string => {
    while (rangeIndex < PROTECTED_TOKEN_RANGES.length) {
      const range = PROTECTED_TOKEN_RANGES[rangeIndex];
      if (!range) {
        break;
      }
      if (codePoint > range[1]) {
        rangeIndex += 1;
        codePoint = PROTECTED_TOKEN_RANGES[rangeIndex]?.[0] ?? Number.POSITIVE_INFINITY;
        continue;
      }
      const token = String.fromCharCode(codePoint++);
      if (!occupied.has(token) && !values.has(token)) {
        values.set(token, value);
        return token;
      }
    }
    return value;
  };
  return {
    next,
    reuse: (value: string) => {
      const existing = reusable.get(value);
      if (existing) {
        return existing;
      }
      const token = next(value);
      reusable.set(value, token);
      return token;
    },
    restore: (text: string) =>
      text.replace(PROTECTED_TOKEN_RE, (token) => values.get(token) ?? token),
  };
}

function escapeQQMarkdownSyntax(text: string): string {
  return text.replace(QQBOT_MARKDOWN_ESCAPE_RE, "\\$1");
}

type TextEdit = { start: number; end: number; text: string };

function rewriteMarkdownIR(ir: MarkdownIR, edits: readonly TextEdit[]): MarkdownIR {
  if (edits.length === 0) {
    return ir;
  }
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

function prefixQQBotBlockquotes(ir: MarkdownIR): MarkdownIR {
  const quoteSpans = ir.styles.filter((span) => span.style === "blockquote");
  const edits = quoteSpans.flatMap((span) => {
    const positions: number[] = [];
    for (let index = span.start; index < span.end; index += 1) {
      if (ir.text[index] === "\n" && index + 1 < span.end) {
        positions.push(index + 1);
      }
    }
    return positions.map((position) => ({ start: position, end: position, text: "> " }));
  });
  return rewriteMarkdownIR(ir, edits);
}

function escapeQQFallbackCode(
  ir: MarkdownIR,
  protectEscape: (escaped: string) => string,
): MarkdownIR {
  return rewriteMarkdownIR(
    ir,
    ir.styles
      .filter((span) => span.style === "code" || span.style === "code_block")
      .map((span) => ({
        start: span.start,
        end: span.end,
        text: ir.text
          .slice(span.start, span.end)
          .replace(QQBOT_MARKDOWN_ESCAPE_RE, (char) => protectEscape(`\\${char}`)),
      })),
  );
}

function specializeProtectedTokensInCode(
  ir: MarkdownIR,
  tokens: readonly string[],
  protectedTokens: ReturnType<typeof createProtectedTokenStore>,
): MarkdownIR {
  const codeStyles = ir.styles.filter(
    (span) => span.style === "code" || span.style === "code_block",
  );
  const edits: TextEdit[] = [];
  const protectedSet = new Set(tokens);
  for (let start = 0; start < ir.text.length; start += 1) {
    const token = ir.text[start] ?? "";
    if (
      protectedSet.has(token) &&
      codeStyles.some((span) => start >= span.start && start + token.length <= span.end)
    ) {
      const escaped = escapeQQMarkdownSyntax(protectedTokens.restore(token));
      edits.push({ start, end: start + token.length, text: protectedTokens.reuse(escaped) });
    }
  }
  return rewriteMarkdownIR(ir, edits);
}

type ImageCandidateScan = { end: number } | { next: number } | undefined;

function blankBlockEnd(text: string, index: number): number | undefined {
  const match = /^(?:\r?\n)[ \t]*(?:\r?\n)/u.exec(text.slice(index));
  return match ? index + match[0].length : undefined;
}

function scanQQBotMarkdownImage(text: string, start: number): ImageCandidateScan {
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
    } else if (text.startsWith("![", index)) {
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
    const next = fallbackNext ?? text.indexOf("![", altEnd === undefined ? start + 2 : altEnd + 1);
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
    } else if (text.startsWith("![", index)) {
      fallbackNext = index;
    } else if (text[index] === "(") {
      parenDepth += 1;
    } else if (text[index] === ")" && --parenDepth === 0) {
      return { end: index + 1 };
    }
  }
  return fallbackNext === undefined ? undefined : { next: fallbackNext };
}

function protectQQBotMarkdownImages(
  text: string,
  createToken: (image: string) => string,
  byteLimit: number,
): { text: string; tokens: string[] } {
  let protectedText = "";
  let cursor = 0;
  let searchFrom = 0;
  const tokens: string[] = [];
  while (searchFrom < text.length) {
    const start = text.indexOf("![", searchFrom);
    if (start < 0) {
      break;
    }
    const scan = scanQQBotMarkdownImage(text, start);
    if (!scan) {
      break;
    }
    if ("next" in scan) {
      searchFrom = scan.next;
      continue;
    }
    let slashStart = start;
    while (slashStart > cursor && text[slashStart - 1] === "\\") {
      slashStart -= 1;
    }
    const escaped = (start - slashStart) % 2 === 1;
    const image = text.slice(start, scan.end);
    const protectedSize = Math.max(
      utf8ByteLength(image),
      utf8ByteLength(escapeQQMarkdownSyntax(image)),
    );
    if (protectedSize + PROTECTED_IMAGE_OVERHEAD_BYTES > byteLimit) {
      searchFrom = scan.end;
      continue;
    }
    protectedText += text.slice(cursor, escaped ? start - 1 : start);
    const token = createToken(escaped ? `\\${image}` : image);
    tokens.push(token);
    protectedText += token;
    cursor = scan.end;
    searchFrom = scan.end;
  }
  return { text: protectedText + text.slice(cursor), tokens };
}

function serializeMarkdownDestination(href: string): string {
  return `<${href.replace(/([\\<>])/gu, "\\$1")}>`;
}

function fallbackOversizedQQLinks(
  ir: MarkdownIR,
  byteLimit: number,
  render: (ir: MarkdownIR) => string,
  protectEscape: (escaped: string) => string,
): MarkdownIR {
  const oversizedIndexes = new Set<number>();
  for (const [index, link] of ir.links.entries()) {
    const rendered = render(sliceMarkdownIR(ir, link.start, link.end));
    if (utf8ByteLength(rendered) > byteLimit) {
      oversizedIndexes.add(index);
    }
  }
  if (oversizedIndexes.size === 0) {
    return ir;
  }
  const oversized = ir.links.filter((_link, index) => oversizedIndexes.has(index));
  const rewritten = rewriteMarkdownIR(
    ir,
    oversized.map((link) => ({
      start: link.end,
      end: link.end,
      text: ` (${link.href.replace(QQBOT_MARKDOWN_ESCAPE_RE, (char) => protectEscape(`\\${char}`))})`,
    })),
  );
  return {
    ...rewritten,
    links: rewritten.links.filter((_link, index) => !oversizedIndexes.has(index)),
  };
}

function fallbackOversizedProtectedImages(
  ir: MarkdownIR,
  byteLimit: number,
  render: (ir: MarkdownIR) => string,
  protectedTokens: ReturnType<typeof createProtectedTokenStore>,
): MarkdownIR {
  const edits: TextEdit[] = [];
  for (let start = 0; start < ir.text.length; start += 1) {
    const token = ir.text[start] ?? "";
    const protectedValue = protectedTokens.restore(token);
    const escapedLiteral = protectedValue.startsWith("\\![");
    const unescaped = protectedValue.replace(/\\(.)/gu, "$1");
    if (
      /^!?\[[\s\S]*\]\([\s\S]*\)$/u.test(unescaped) &&
      utf8ByteLength(render(sliceMarkdownIR(ir, start, start + token.length))) > byteLimit
    ) {
      if (escapedLiteral) {
        const literal = protectedValue.replace(QQBOT_MARKDOWN_ESCAPE_RE, (char) =>
          protectedTokens.reuse(`\\${char}`),
        );
        edits.push({ start, end: start + token.length, text: literal });
        continue;
      }
      const altStart = protectedValue.startsWith("![") ? 2 : 1;
      let depth = 1;
      let altEnd = altStart;
      let alt = "";
      for (; altEnd < protectedValue.length; altEnd += 1) {
        if (protectedValue[altEnd] === "\\" && protectedValue[altEnd + 1]) {
          alt += protectedValue[++altEnd];
        } else if (protectedValue[altEnd] === "[") {
          depth += 1;
          alt += "[";
        } else if (protectedValue[altEnd] === "]" && --depth === 0) {
          break;
        } else {
          alt += protectedValue[altEnd] ?? "";
        }
      }
      edits.push({ start, end: start + token.length, text: alt });
    }
  }
  return rewriteMarkdownIR(ir, edits);
}

export function formatQQBotMarkdown(markdown: string, limit: number): string[] {
  const protectedTokens = createProtectedTokenStore(markdown);
  const chunkLimit = resolveQQBotMarkdownChunkLimit(limit);
  const images = protectQQBotMarkdownImages(markdown, protectedTokens.reuse, chunkLimit);
  const entityTokens: string[] = [];
  const entitiesProtected = images.text.replace(MARKDOWN_ENTITY_RE, (entity) => {
    const protectedSize = Math.max(
      utf8ByteLength(entity),
      utf8ByteLength(escapeQQMarkdownSyntax(entity)),
    );
    if (protectedSize + PROTECTED_IMAGE_OVERHEAD_BYTES > chunkLimit) {
      return entity;
    }
    const token = protectedTokens.reuse(entity);
    entityTokens.push(token);
    return token;
  });
  const escapeTokens: string[] = [];
  const protectedMarkdown = entitiesProtected.replace(ESCAPED_MARKDOWN_RE, (escaped) => {
    const token = protectedTokens.reuse(escaped);
    escapeTokens.push(token);
    return token;
  });
  const parsed = markdownToIR(protectedMarkdown, {
    autolink: false,
    enableSpoilers: true,
    enableTaskLists: true,
    headingStyle: "rich",
    linkify: false,
    blockquotePrefix: "",
  });
  const specialized = specializeProtectedTokensInCode(
    specializeProtectedTokensInCode(parsed, images.tokens, protectedTokens),
    [...escapeTokens, ...entityTokens],
    protectedTokens,
  );
  const renderChunk = (chunk: MarkdownIR): string =>
    protectedTokens.restore(
      renderMarkdownWithMarkers(
        chunk,
        {
          styleMarkers: {
            ...QQBOT_MARKERS,
            blockquote: {
              open: (span: { start: number }) =>
                chunk.text.slice(span.start, span.start + 2) === "> " ? "" : "> ",
              close: "",
            },
          },
          escapeText: (text) => text,
          buildLink: (link) => ({
            start: link.start,
            end: link.end,
            open: "[",
            close: `](${serializeMarkdownDestination(link.href)})`,
          }),
        },
        QQBOT_FORMAT_CAPABILITIES,
      ),
    );
  const formatted = prefixQQBotBlockquotes(
    escapeQQFallbackCode(specialized, protectedTokens.reuse),
  );
  const imagesSized = fallbackOversizedProtectedImages(
    formatted,
    chunkLimit,
    renderChunk,
    protectedTokens,
  );
  const ir = fallbackOversizedQQLinks(imagesSized, chunkLimit, renderChunk, protectedTokens.reuse);
  const chunks = renderMarkdownIRChunksWithinLimit({
    ir,
    limit: chunkLimit,
    measureRendered: utf8ByteLength,
    renderChunk,
  }).map((chunk) => chunk.rendered);
  const last = chunks.length - 1;
  if (last >= 0) {
    chunks[last] = chunks[last]?.trimEnd() ?? "";
  }
  return chunks;
}
