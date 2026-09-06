import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { chunkByParagraph, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  avoidTrailingHighSurrogateBreak,
  chunkTextForOutbound,
  findCodeRegions,
} from "openclaw/plugin-sdk/text-chunking";

type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 2000. */
  maxChars?: number;
  /**
   * Soft max line count per message. Default: 17.
   *
   * Discord clients can clip/collapse very tall messages in the UI; splitting
   * by lines keeps long multi-paragraph replies readable.
   */
  maxLines?: number;
};

type OpenFence = {
  marker: string;
  closeLine: string;
  reopenLine: string | null;
};

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;
const REASONING_ITALICS_MARKER_CHARS = 2;
const MIN_REASONING_ITALICS_CHUNK_CHARS = 4;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function hasReasoningItalics(text: string): boolean {
  return /^(?:Reasoning:|Thinking\.{0,3})\n+_/u.test(text) && text.trimEnd().endsWith("_");
}

function resolveDiscordChunkLimit(value: unknown, fallback: number) {
  return resolveIntegerOption(value, fallback, { min: 1 });
}

function countLines(text: string) {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

// Keep Discord's existing fence grammar. Tiny caps retain original source when a synthetic
// marker pair cannot fit; otherwise drop an oversized language hint only on continuation fences.
function parseFenceLine(line: string, maxChars = Number.POSITIVE_INFINITY): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const marker = match[2] ?? "";
  const closeLine = (match[1] ?? "") + marker;
  const canBalance = closeLine.length * 2 + 3 <= maxChars;
  const reopenLine = line.length + closeLine.length + 3 <= maxChars ? line : closeLine;
  return { marker, closeLine, reopenLine: canBalance ? reopenLine : null };
}

function closesFence(open: OpenFence, close: OpenFence): boolean {
  return open.marker[0] === close.marker[0] && close.marker.length >= open.marker.length;
}

type DiscordFrame = { start: number; end: number };
function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const hardMaxChars = resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxLines = resolveDiscordChunkLimit(opts.maxLines, DEFAULT_MAX_LINES);
  if (!text) {
    return [];
  }
  if (text.length <= hardMaxChars && countLines(text) <= maxLines) {
    return [text];
  }
  const maxChars =
    hardMaxChars >= MIN_REASONING_ITALICS_CHUNK_CHARS && hasReasoningItalics(text)
      ? hardMaxChars - REASONING_ITALICS_MARKER_CHARS
      : hardMaxChars;
  const ranges = createDiscordRanges(text, maxChars, maxLines);
  const chunks: string[] = [];
  let current: DiscordFrame | undefined;
  let consumed = 0;
  let lineStart = 0;
  // Keep existing soft breaks based on source bytes; render measures the full payload.
  const raw = (frame: DiscordFrame) => {
    const prefix = ranges.fenceAt(frame.start)?.reopenLine ?? "";
    const body = text.slice(frame.start, frame.end);
    return prefix + (prefix ? "\n" : "") + body;
  };
  const render = (frame: DiscordFrame) => {
    const body = ranges.render(frame.start, frame.end);
    if (body === undefined) {
      return undefined;
    }
    const prefix = ranges.fenceAt(frame.start)?.reopenLine ?? "";
    const result = prefix + (prefix ? "\n" : "") + body;
    const close = ranges.fenceAt(frame.end);
    return close?.reopenLine
      ? result + (result.endsWith("\n") ? "" : "\n") + close.closeLine
      : result;
  };
  const fits = (frame: DiscordFrame) => {
    const payload = render(frame);
    // The line limit is soft: a balanced fence needs its opener, body and closer.
    return (
      payload !== undefined &&
      payload.length <= maxChars &&
      countLines(payload) <=
        Math.max(
          maxLines,
          ranges.fenceAt(frame.start)?.reopenLine || ranges.fenceAt(frame.end)?.reopenLine ? 3 : 1,
        )
    );
  };
  const flush = (frame: DiscordFrame) => {
    let end = ranges.overlaps(frame.start, frame.end)
      ? ranges.cutBoundary(frame.start, frame.end)
      : ranges.boundary(frame.start, frame.end);
    // A rejected nonempty range needs more source before its atomic unit can be emitted.
    if (frame.end > frame.start && end <= frame.start) {
      return frame;
    }
    // A single Unicode code point can exceed a one-unit cap; retain the existing safe split.
    const minimum = ranges.boundary(frame.start, frame.start + 1);
    while (end > minimum && !fits({ ...frame, end })) {
      const cut = ranges.cutBoundary(frame.start, end - 1);
      end = cut > frame.start ? cut : minimum;
    }
    const payload = expectDefined(render({ ...frame, end }), "renderable Discord source range");
    if (payload.trim()) {
      chunks.push(payload);
    }
    consumed = end;
    // Keep an opener or CRLF pair with the unconsumed source, never synthetic offsets.
    return end < frame.end ? { start: end, end: frame.end } : undefined;
  };
  for (const line of text.split("\n")) {
    const openFence = ranges.fenceAt(lineStart - 1);
    const candidateFence = ranges.fenceAt(lineStart + line.length) ?? openFence;
    const fence = candidateFence?.reopenLine ? candidateFence : null;
    const charLimit = maxChars - (fence ? fence.closeLine.length + 1 : 0);
    const lineLimit = Math.max(1, maxLines - (fence ? 1 : 0));
    const content = current ? raw(current) : (ranges.fenceAt(consumed)?.reopenLine ?? "");
    // An original closer consumes its reservation; splitting it first would turn markers into code.
    const segmentLimit =
      openFence?.reopenLine &&
      openFence.closeStart === lineStart &&
      fits({ start: lineStart, end: lineStart + line.length })
        ? maxChars
        : Math.max(
            1,
            charLimit -
              Math.max(
                content ? content.length + 1 : 0,
                fence?.reopenLine ? fence.reopenLine.length + 1 : 0,
              ),
          );
    let segmentStart = lineStart;
    for (const segment of chunkTextForOutbound(line, segmentLimit, {
      preserveWhitespace: Boolean(openFence),
    })) {
      const end = segmentStart + segment.length;
      const start =
        current?.start ?? (ranges.joins(consumed, segmentStart) ? consumed : segmentStart);
      const candidate = { start, end };
      // An original closing fence consumes the reservation; do not reserve a second closer.
      const closesBlock = openFence && !ranges.fenceAt(end);
      const exceeds = closesBlock
        ? !fits(candidate)
        : raw(candidate).length > charLimit ||
          countLines(raw(candidate)) > lineLimit ||
          (ranges.overlaps(start, end) && !fits(candidate));
      if (current && exceeds) {
        current = flush(current);
        candidate.start =
          current?.start ?? (ranges.joins(consumed, segmentStart) ? consumed : segmentStart);
      }
      current = raw(candidate) ? candidate : undefined;
      segmentStart = end;
    }
    lineStart += line.length + 1;
  }
  while (current) {
    current = flush(current);
  }
  return rebalanceReasoningItalics(text, chunks, hardMaxChars);
}

export function chunkDiscordTextWithMode(
  text: string,
  opts: ChunkDiscordTextOpts & { chunkMode?: ChunkMode },
): string[] {
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkByParagraph(
    text,
    resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS),
    { splitLongParagraphs: false },
  );
  return lineChunks.flatMap((line) => {
    const chunks = chunkDiscordText(line, opts);
    return chunks.length || !line ? chunks : [line];
  });
}

// Find the end of a leading fenced or inline code span. This deliberately reuses the chunker's
// fence grammar so italics balancing cannot disagree about indentation, marker type, or length.
function leadingCodePrefixEnd(body: string): number {
  let offset = 0;
  let prefixEnd = -1;
  while (offset < body.length) {
    const rest = body.slice(offset);
    const fence = parseFenceLine(rest.split("\n", 1)[0] ?? "");
    const marker = fence?.marker ?? /^`+/.exec(rest)?.[0];
    if (!marker) {
      return prefixEnd;
    }
    // Fence continuations keep the legacy close rule; inline runs must match exactly,
    // including spans across CRLF or blank lines that CommonMark treats as blocks.
    const pattern = fence
      ? `\\n( {0,3}${marker[0]}{${marker.length},} *)(?=[\\t ]*_?[\\t ]*(?:\\n|$))`
      : "(?<!`)`{" + marker.length + "}(?!`)";
    const delimiter = new RegExp(pattern, "g");
    delimiter.lastIndex = fence ? 0 : marker.length;
    const match = delimiter.exec(rest);
    if (!match) {
      return fence ? body.length : prefixEnd;
    }
    prefixEnd = offset + match.index + match[0].length;
    const separator = /^\s+/u.exec(body.slice(prefixEnd))?.[0];
    if (!separator) {
      return prefixEnd;
    }
    offset = prefixEnd + separator.length;
  }
  return prefixEnd;
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next. Code-leading continuations reopen after code.
function rebalanceReasoningItalics(source: string, chunks: string[], maxChars: number): string[] {
  if (
    chunks.length <= 1 ||
    maxChars < MIN_REASONING_ITALICS_CHUNK_CHARS ||
    !hasReasoningItalics(source)
  ) {
    return chunks;
  }
  return chunks.map((chunk, index) => {
    const leadingWhitespace = chunk.length - chunk.trimStart().length;
    const codeEnd = leadingCodePrefixEnd(chunk.slice(leadingWhitespace));
    const prefixEnd = leadingWhitespace + Math.max(0, codeEnd);
    const prefix = chunk.slice(0, prefixEnd);
    let body = chunk.slice(prefixEnd);
    if (index > 0) {
      if (codeEnd >= 0 && /^\s*_\s*$/.test(body)) {
        return prefix;
      }
      const content = body.trimStart();
      if (content && !content.startsWith("_")) {
        body = `${body.slice(0, body.length - content.length)}_${content}`;
      }
    }
    if (
      !body.trimEnd().endsWith("_") &&
      /^(?:_|(?:Reasoning:|Thinking\.{0,3})\n+_)/u.test(body.trimStart())
    ) {
      body += "_";
    }
    return prefix + body;
  });
}

function renderInlineCode(body: string, delimiter: string): string | undefined {
  // A cut can shorten an interior backtick run to match the original delimiter.
  const runs = new Set(Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  let marker = delimiter;
  if (runs.has(marker.length) || (marker.length >= 3 && /[\r\n]/.test(body))) {
    marker = "`";
    while (runs.has(marker.length)) {
      marker += "`";
    }
  }
  // A multiline fragment with a fence-sized opener needs a backtick in its first line,
  // or Markdown would interpret it as a block. The range owner must cut it earlier.
  if (
    marker.length >= 3 &&
    /[\r\n]/.test(body) &&
    !body.split(/\r\n|[\r\n]/, 1)[0]?.includes("`")
  ) {
    return undefined;
  }
  const normalized = body.replace(/\r\n|[\r\n]/g, " ");
  const padding =
    body.startsWith("`") ||
    body.endsWith("`") ||
    (normalized.startsWith(" ") && normalized.endsWith(" ") && /[^ ]/.test(normalized))
      ? " "
      : "";
  return marker + padding + body + padding + marker;
}

type InlineSpan = DiscordFrame & {
  code: NonNullable<ReturnType<typeof findCodeRegions>[number]["source"]>;
  base: number;
  marker: string;
  atomicTicks: boolean;
};
type FenceRange = DiscordFrame &
  OpenFence & {
    bodyStart: number;
    closeStart: number;
  };
// Inline spans are collected only between Discord fences, using the existing close grammar.
function createDiscordRanges(source: string, maxChars: number, maxLines: number) {
  const spans: InlineSpan[] = [];
  const fences: FenceRange[] = [];
  let offset = 0;
  let plainStart = 0;
  let fence: FenceRange | undefined;
  const collect = (end: number) => {
    for (const span of findCodeRegions(source.slice(plainStart, end), {
      includeSource: true,
      syntax: "commonmark",
    })) {
      if (span.block) {
        continue;
      }
      const start = plainStart + span.start;
      const finish = plainStart + span.end;
      const marker = /^`+/.exec(source.slice(start, finish))?.[0];
      if (!marker) {
        continue;
      }
      const code = expectDefined(span.source, "inline code source map");
      const atomicTicks =
        (renderInlineCode("`", marker)?.length ?? Infinity) + code.prefix.text.length > maxChars;
      const pattern = atomicTicks ? /`+|\r\n|[\s\S]/gu : /\r\n|[\s\S]/gu;
      const fits = Array.from(source.slice(start, finish).matchAll(pattern)).every(
        ({ index, 0: raw }) => {
          const value = code.value.slice(code.offsets[index], code.offsets[index + raw.length]);
          return (
            !value ||
            (renderInlineCode(value, marker)?.length ?? Infinity) + code.prefix.text.length <=
              maxChars
          );
        },
      );
      if (fits && (maxLines > 1 || !code.value.includes("\n"))) {
        spans.push({ start, end: finish, code, base: plainStart, marker, atomicTicks });
      }
    }
  };
  for (const line of source.split("\n")) {
    const info = parseFenceLine(line, maxChars);
    if (info && !fence) {
      collect(offset);
      fence = {
        start: offset,
        bodyStart: offset + line.length + 1,
        closeStart: source.length,
        end: source.length,
        ...info,
      };
      fences.push(fence);
    } else if (info && fence && closesFence(fence, info)) {
      fence.closeStart = offset;
      fence.end = offset + line.length;
      fence = undefined;
      plainStart = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  if (!fence) {
    collect(source.length);
  }
  const overlaps = (start: number, end: number) =>
    spans.some((span) => span.start < end && span.end > start);
  const joins = (end: number, start: number) =>
    end <= start && spans.some((span) => span.start < end && end < span.end && start < span.end);
  const boundary = (start: number, end: number) => {
    let safe = avoidTrailingHighSurrogateBreak(source, start, end);
    for (const span of spans) {
      const prefix = span.code.prefix;
      if (span.base + prefix.start < safe && safe < span.base + prefix.end) {
        return span.base + prefix.start;
      }
      if (span.start < safe && safe < span.end) {
        if (source[safe - 1] === "\r" && source[safe] === "\n") {
          safe -= 1;
        }
        if (span.atomicTicks) {
          while (source[safe - 1] === "`" && source[safe] === "`") {
            safe -= 1;
          }
        }
      }
    }
    return safe;
  };
  const render = (start: number, end: number) => {
    let cursor = start,
      text = "";
    for (const span of spans) {
      if (span.end <= start || span.start >= end) {
        continue;
      }
      const prefix = span.code.prefix;
      const prefixStart = span.base + prefix.start;
      // Reopen only containers whose original marker was emitted in an earlier message.
      if (start > span.base + prefix.ownerStart && cursor <= prefixStart) {
        text += source.slice(cursor, prefixStart) + prefix.text;
        cursor = span.base + prefix.end;
      }
      text += source.slice(cursor, Math.max(cursor, span.start));
      if (span.start >= start && span.end <= end) {
        text += source.slice(span.start, span.end);
      } else {
        const body = span.code.value.slice(
          span.code.offsets[Math.max(start, span.start) - span.start],
          span.code.offsets[Math.min(end, span.end) - span.start],
        );
        if (body) {
          const value = renderInlineCode(body, span.marker);
          if (value === undefined) {
            return undefined;
          }
          text += (span.start < start ? span.code.prefix.text : "") + value;
        }
      }
      cursor = Math.min(end, span.end);
    }
    return text + source.slice(cursor, end);
  };
  // A partial closing line is still inside the fence until its original text is consumed.
  const fenceAt = (position: number) =>
    fences.find(
      (range) =>
        range.bodyStart - 1 <= position &&
        (position < range.end || (position === range.end && range.closeStart === range.end)),
    );
  const cutBoundary = (start: number, end: number) => {
    const safe = boundary(start, end);
    // Keep marker lines intact and leave an opening fence with its body.
    for (const range of fences) {
      if (start < range.start && range.start < safe && safe <= range.bodyStart) {
        return range.start;
      }
      if (range.closeStart < safe && safe < range.end) {
        return range.closeStart;
      }
    }
    return safe;
  };
  return { render, overlaps, joins, boundary, fenceAt, cutBoundary };
}
