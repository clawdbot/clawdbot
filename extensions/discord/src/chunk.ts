// Discord plugin module implements chunk behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";

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
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
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

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function canBalanceFence(openFence: OpenFence, maxChars: number) {
  const markerLength = closeFenceLine(openFence).length;
  return markerLength * 2 + 3 <= maxChars;
}

// Continuation chunks reopen the fence so Discord keeps rendering the code block. Prefer the full
// opening line (keeps the language for highlighting); degrade to a bare marker when it would not
// leave room for the closing marker plus at least one delimiter+char of body. When even the bare
// pair cannot fit, preserve the hard transport limit and emit the continuation without synthetic
// fences; the original fence text is still retained in its own chunks.
function reopenFenceLine(openFence: OpenFence, maxChars: number) {
  const bareMarker = closeFenceLine(openFence);
  if (!canBalanceFence(openFence, maxChars)) {
    return null;
  }
  // openLine + closing marker (bareMarker + newline) + one delimiter + one body char must all fit.
  if (openFence.openLine.length + bareMarker.length + 3 <= maxChars) {
    return openFence.openLine;
  }
  return bareMarker;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null, maxChars: number) {
  if (!openFence || !canBalanceFence(openFence, maxChars)) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}\n${closeLine}`;
  }
  return `${text}${closeLine}`;
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const hardMaxChars = resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxLines = resolveDiscordChunkLimit(opts.maxLines, DEFAULT_MAX_LINES);

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const alreadyOk = body.length <= hardMaxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

  // Reasoning rebalancing can add an opening and closing marker to each chunk.
  // Reserve both before splitting so the rendered payload still fits Discord.
  const maxChars =
    hardMaxChars >= MIN_REASONING_ITALICS_CHUNK_CHARS && hasReasoningItalics(body)
      ? hardMaxChars - REASONING_ITALICS_MARKER_CHARS
      : hardMaxChars;

  const lines = body.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const payload = closeFenceIfNeeded(current, openFence, maxChars);
    if (payload.trim().length) {
      chunks.push(payload);
    }
    current = "";
    currentLines = 0;
    if (openFence) {
      const reopenLine = reopenFenceLine(openFence, maxChars);
      if (reopenLine) {
        current = reopenLine;
        currentLines = 1;
      }
    }
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    // A flush can fire mid-line, before `openFence` advances to `nextOpenFence` below, so it closes
    // against the still-open `openFence`. A fence-closing line that also carries trailing text would
    // otherwise reserve 0 yet still get a closing fence appended on flush, overflowing maxChars.
    const candidateFence = nextOpenFence ?? openFence;
    const fenceToReserve =
      candidateFence && canBalanceFence(candidateFence, maxChars) ? candidateFence : null;
    const reserveChars = fenceToReserve ? closeFenceLine(fenceToReserve).length + 1 : 0;
    const reserveLines = fenceToReserve ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const reopenPrefixLen = fenceToReserve
      ? (reopenFenceLine(fenceToReserve, maxChars)?.length ?? 0)
      : 0;
    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    // A mid-line flush swaps `current` to the reopen prefix; size segments against whichever prefix
    // is larger so the reopened chunk (prefix + segment + closing marker) still fits maxChars.
    const reopenBudget = reopenPrefixLen > 0 ? reopenPrefixLen + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - Math.max(prefixLen, reopenBudget));
    const segments = chunkTextForOutbound(originalLine, segmentLimit, {
      preserveWhitespace: wasInsideFence,
    });

    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex];
      const isLineContinuation = segIndex > 0;
      let delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
      let addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
        // A fence-aware flush reopens the block as the new first line. Continuation text must
        // start on the next line or Discord interprets it as part of the fence info string.
        delimiter = current.length > 0 ? "\n" : "";
        addition = `${delimiter}${segment}`;
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation || delimiter) {
          currentLines += 1;
        }
      } else {
        current = expectDefined(segment, "current Discord chunk segment");
        currentLines = 1;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence, maxChars);
    if (payload.trim().length) {
      chunks.push(payload);
    }
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
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS),
    "newline",
  );
  const chunks: string[] = [];
  for (const line of lineChunks) {
    const nested = chunkDiscordText(line, opts);
    if (!nested.length && line) {
      chunks.push(line);
      continue;
    }
    chunks.push(...nested);
  }
  return chunks;
}

// Find the end of a leading fenced or inline code span. This deliberately reuses the chunker's
// fence grammar so italics balancing cannot disagree about indentation, marker type, or length.
function leadingCodeSpanEnd(body: string): number {
  if (!body) {
    return -1;
  }

  const firstNewline = body.indexOf("\n");
  const firstLine = firstNewline === -1 ? body : body.slice(0, firstNewline);
  const openFence = parseFenceLine(firstLine);
  if (openFence) {
    if (firstNewline === -1) {
      return body.length;
    }
    let lineStart = firstNewline + 1;
    while (lineStart <= body.length) {
      const lineEnd = body.indexOf("\n", lineStart);
      const line = lineEnd === -1 ? body.slice(lineStart) : body.slice(lineStart, lineEnd);
      const closeFence = parseFenceLine(line);
      const closeSuffix = closeFence
        ? line.slice(closeFence.indent.length + closeFence.markerLen)
        : "";
      if (
        closeFence?.markerChar === openFence.markerChar &&
        closeFence.markerLen >= openFence.markerLen &&
        /^[ \t]*_?[ \t]*$/u.test(closeSuffix)
      ) {
        const markerEnd = closeFence.indent.length + closeFence.markerLen;
        const trailingSpaces = /^ */.exec(line.slice(markerEnd))?.[0].length ?? 0;
        return lineStart + markerEnd + trailingSpaces;
      }
      if (lineEnd === -1) {
        return body.length;
      }
      lineStart = lineEnd + 1;
    }
    return body.length;
  }

  if (!body.startsWith("`")) {
    return -1;
  }
  const ticks = /^(?<ticks>`+)/.exec(body)?.groups?.ticks;
  if (!ticks) {
    return -1;
  }
  for (let index = ticks.length; index < body.length;) {
    if (body[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (body[runEnd] === "`") {
      runEnd += 1;
    }
    if (runEnd - index === ticks.length) {
      return runEnd;
    }
    index = runEnd;
  }
  return -1;
}

function leadingCodePrefixEnd(body: string): number {
  let prefixEnd = leadingCodeSpanEnd(body);
  if (prefixEnd < 0) {
    return -1;
  }
  while (prefixEnd < body.length) {
    const separator = /^\s+/u.exec(body.slice(prefixEnd))?.[0] ?? "";
    if (!separator) {
      break;
    }
    const nextStart = prefixEnd + separator.length;
    const nextEnd = leadingCodeSpanEnd(body.slice(nextStart));
    if (nextEnd < 0) {
      break;
    }
    prefixEnd = nextStart + nextEnd;
  }
  return prefixEnd;
}

function hasReasoningItalicsOpen(chunk: string): boolean {
  const trimmed = chunk.trimStart();
  if (trimmed.startsWith("_") || /^(?:Reasoning:|Thinking\.{0,3})\n+_/u.test(trimmed)) {
    return true;
  }
  const codeEnd = leadingCodePrefixEnd(trimmed);
  return codeEnd >= 0 && trimmed.slice(codeEnd).trimStart().startsWith("_");
}

// Keep a leading code delimiter untouched; reopen reasoning italics only after its code span.
function reopenReasoningItalicsAfterLeadingCode(body: string, codeEnd: number): string {
  const code = body.slice(0, codeEnd);
  const rest = body.slice(codeEnd);
  if (!rest.trim()) {
    return code + rest;
  }
  if (/^\s*_\s*$/.test(rest)) {
    return code;
  }
  const whitespaceLength = rest.length - rest.trimStart().length;
  const whitespace = rest.slice(0, whitespaceLength);
  const restBody = rest.slice(whitespaceLength);
  return restBody.startsWith("_") ? code + rest : `${code}${whitespace}_${restBody}`;
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next. Code-leading continuations reopen after code.
function rebalanceReasoningItalics(source: string, chunks: string[], maxChars: number): string[] {
  if (chunks.length <= 1 || maxChars < MIN_REASONING_ITALICS_CHUNK_CHARS) {
    return chunks;
  }

  if (!hasReasoningItalics(source)) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = expectDefined(adjusted[i], "Discord chunk adjustment index");

    // Pure-code continuations never open reasoning italics, so do not append an unmatched closer.
    const needsClosing = !current.trimEnd().endsWith("_") && hasReasoningItalicsOpen(current);
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    const next = expectDefined(adjusted[i + 1], "non-final Discord chunk successor");
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (nextBody.startsWith("_")) {
      continue;
    }
    const codeEnd = leadingCodePrefixEnd(nextBody);
    adjusted[i + 1] =
      codeEnd >= 0
        ? `${leadingWhitespace}${reopenReasoningItalicsAfterLeadingCode(nextBody, codeEnd)}`
        : `${leadingWhitespace}_${nextBody}`;
  }

  return adjusted;
}
