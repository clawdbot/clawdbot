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
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

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
  const maxChars = resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxLines = resolveDiscordChunkLimit(opts.maxLines, DEFAULT_MAX_LINES);

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

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

  return rebalanceReasoningItalics(text, chunks);
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

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next so every chunk renders
// consistently.
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const opensWithReasoningItalics =
    /^(?:Reasoning:|Thinking\.{0,3})\n+_/u.test(source) && source.trimEnd().endsWith("_");
  if (!opensWithReasoningItalics) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = expectDefined(adjusted[i], "Discord chunk adjustment index");

    // Ensure current chunk closes italics so Discord renders it italicized.
    const needsClosing = !current.trimEnd().endsWith("_");
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    // Re-open italics on the next chunk if needed.
    const next = expectDefined(adjusted[i + 1], "non-final Discord chunk successor");
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (!nextBody.startsWith("_")) {
      adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
    }
  }

  return adjusted;
}
