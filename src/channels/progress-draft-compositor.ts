// Stateful progress-draft compositor for channel streaming previews.
// It merges tool, reasoning, and commentary updates until the final reply replaces them.
import { formatReasoningMessage } from "../agents/embedded-agent-utils.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { stripInlineDirectiveTagsForDelivery } from "../utils/directive-tags.js";
import { removeChannelProgressDraftLine } from "./progress-draft-lines.js";
import {
  createChannelProgressDraftGate,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type StreamingCompatEntry,
  type StreamingMode,
} from "./streaming.js";

// Composes transient channel progress drafts from tool, reasoning, and
// commentary updates. It owns draft lifecycle state before the final reply wins.
export type ChannelProgressDraftMode = StreamingMode;

export type ChannelProgressDraftCompositor = ReturnType<
  typeof createChannelProgressDraftCompositor
>;
type ProgressDraftLine = string | ChannelProgressDraftLine;

/** Creates a stateful compositor for one streaming channel reply. */
export function createChannelProgressDraftCompositor(params: {
  entry: StreamingCompatEntry | null | undefined;
  mode: ChannelProgressDraftMode;
  active: boolean;
  seed: string;
  update: (text: string, options?: { flush?: boolean }) => Promise<void> | void;
  deleteCurrent?: () => Promise<void> | void;
  tryNativeUpdate?: (text: string) => Promise<boolean> | boolean;
  formatLine?: (line: string) => string;
  isEmptyLine?: (line: ProgressDraftLine | undefined) => boolean;
  shouldStartNow?: (line: ProgressDraftLine | undefined) => boolean;
}) {
  const previewToolProgressEnabled =
    params.active && resolveChannelStreamingPreviewToolProgress(params.entry);
  const commentaryProgressEnabled =
    params.active && resolveChannelStreamingProgressCommentary(params.entry);
  const suppressDefaultToolProgressMessages =
    params.active &&
    resolveChannelStreamingSuppressDefaultToolProgressMessages(params.entry, {
      draftStreamActive: true,
      previewToolProgressEnabled,
    });
  let progressSuppressed = false;
  let lines: ProgressDraftLine[] = [];
  let lastRenderedText = "";
  let reasoningRawText = "";
  let lastReasoningLine: string | undefined;
  let finalReplyStarted = false;
  let finalReplyDelivered = false;

  const formatDraftText = (draftLines = lines, options?: { formatted?: boolean }) =>
    formatChannelProgressDraftText({
      entry: params.entry,
      lines: draftLines,
      seed: params.seed,
      formatLine: options?.formatted === false ? undefined : params.formatLine,
    });

  const clearProgressState = (suppressed: boolean) => {
    progressSuppressed = suppressed;
    lines = [];
    lastRenderedText = "";
    reasoningRawText = "";
    lastReasoningLine = undefined;
  };

  const render = async (options?: { flush?: boolean }): Promise<boolean> => {
    if (!params.active || params.mode !== "progress") {
      return false;
    }
    const text = formatDraftText();
    if (!text || text === lastRenderedText) {
      return false;
    }
    lastRenderedText = text;
    await params.update(text, options);
    return true;
  };

  const gate = createChannelProgressDraftGate({
    onStart: async () => {
      await render({ flush: true });
    },
  });

  const clearLine = async (lineId: string) => {
    const nextLines = removeChannelProgressDraftLine(lines, lineId);
    if (nextLines === lines) {
      return;
    }
    lines = nextLines;
    if (!gate.hasStarted) {
      return;
    }
    const text = formatDraftText();
    if (text) {
      await render();
      return;
    }
    lastRenderedText = "";
    await params.deleteCurrent?.();
  };

  const noteProgress = async (
    line?: ProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!params.active || finalReplyStarted || finalReplyDelivered) {
      return false;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return false;
    }
    if (params.isEmptyLine?.(line)) {
      return false;
    }
    const normalized = normalizeChannelProgressDraftLineIdentity(line);
    if (!normalized || progressSuppressed) {
      return false;
    }
    if (params.mode !== "progress" && !previewToolProgressEnabled) {
      return false;
    }
    const progressLine = typeof line === "object" && line !== undefined ? line : normalized;
    const shouldStoreLine = previewToolProgressEnabled;
    const nextLines = shouldStoreLine
      ? mergeChannelProgressDraftLine(lines, progressLine, {
          maxLines: resolveChannelProgressDraftMaxLines(params.entry),
        })
      : lines;
    if (shouldStoreLine && nextLines === lines) {
      return false;
    }
    if (shouldStoreLine && params.tryNativeUpdate) {
      // Native draft updates get unformatted text; if the channel accepts it,
      // keep local state aligned without sending a generic draft message.
      const text = formatDraftText(nextLines, { formatted: false });
      if (text && (await params.tryNativeUpdate(text))) {
        lines = nextLines;
        lastRenderedText = text;
        return true;
      }
    }
    lines = nextLines;
    if (params.mode !== "progress") {
      if (!shouldStoreLine) {
        return false;
      }
      const text = formatDraftText();
      if (!text || text === lastRenderedText) {
        return false;
      }
      lastRenderedText = text;
      await params.update(text);
      return true;
    }
    if (options?.startImmediately || params.shouldStartNow?.(line)) {
      await gate.startNow();
      return gate.hasStarted ? await render() : false;
    }
    const alreadyStarted = gate.hasStarted;
    const progressActive = await gate.noteWork();
    if ((alreadyStarted || progressActive) && gate.hasStarted) {
      return await render();
    }
    return false;
  };

  return {
    get previewToolProgressEnabled() {
      return previewToolProgressEnabled;
    },
    get commentaryProgressEnabled() {
      return commentaryProgressEnabled;
    },
    get suppressDefaultToolProgressMessages() {
      return suppressDefaultToolProgressMessages;
    },
    get hasStarted() {
      return gate.hasStarted;
    },
    markFinalReplyStarted() {
      finalReplyStarted = true;
    },
    markFinalReplyDelivered() {
      finalReplyDelivered = true;
    },
    reset() {
      clearProgressState(false);
    },
    suppress() {
      clearProgressState(true);
    },
    cancel() {
      gate.cancel();
    },
    start() {
      return gate.startNow();
    },
    pushToolProgress: noteProgress,
    async pushReasoningProgress(text?: string, options?: { snapshot?: boolean }) {
      if (
        !params.active ||
        params.mode !== "progress" ||
        !text ||
        progressSuppressed ||
        finalReplyDelivered
      ) {
        return false;
      }
      reasoningRawText = mergeReasoningProgressText(reasoningRawText, text, {
        snapshot: options?.snapshot === true,
      });
      const normalized = normalizeReasoningProgressLine(reasoningRawText);
      if (!normalized) {
        return false;
      }
      const displayLine = formatReasoningProgressDisplayLine(
        normalized,
        resolveChannelProgressDraftMaxLineChars(params.entry),
      );
      if (!displayLine) {
        return false;
      }
      if (previewToolProgressEnabled) {
        // Reasoning streams usually arrive as deltas. Replace the previous
        // reasoning line so the draft stays compact instead of appending noise.
        const priorIndex =
          lastReasoningLine === undefined ? -1 : lines.lastIndexOf(lastReasoningLine);
        if (priorIndex >= 0) {
          lines = [...lines];
          lines[priorIndex] = displayLine;
        } else {
          lines = [...lines, displayLine].slice(-resolveChannelProgressDraftMaxLines(params.entry));
        }
        lastReasoningLine = displayLine;
      }
      const progressActive = await gate.noteWork();
      if (progressActive && gate.hasStarted) {
        return await render();
      }
      return false;
    },
    async pushCommentaryProgress(text?: string, options?: { itemId?: string }) {
      if (!params.active || params.mode !== "progress" || !commentaryProgressEnabled) {
        return false;
      }
      if (finalReplyStarted || finalReplyDelivered) {
        return false;
      }
      const itemId = options?.itemId?.trim();
      if (!text && !itemId) {
        return false;
      }
      const normalized = normalizeCommentaryProgressText(text ?? "");
      const lineId = itemId ? `commentary:${itemId}` : normalized ? `commentary:${normalized}` : "";
      if (!normalized) {
        // Empty commentary with an item id means the producer retracted that
        // item; remove its draft line if it was already rendered.
        if (lineId) {
          await clearLine(lineId);
        }
        return false;
      }
      const line: ChannelProgressDraftLine = {
        id: lineId,
        kind: "item",
        text: normalized,
        label: "Commentary",
        prefix: false,
      };
      lines = mergeChannelProgressDraftLine(lines, line, {
        maxLines: resolveChannelProgressDraftMaxLines(params.entry),
      });
      await gate.startNow();
      return await render();
    },
  };
}

function normalizeReasoningProgressLine(text: string): string {
  const reasoningText = readReasoningProgressTextOutsideCode(text);
  if (reasoningText === undefined) {
    return "";
  }
  return stripReasoningProgressTagsOutsideCode(reasoningText)
    .replace(
      /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const REASONING_PROGRESS_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/giu;
const REASONING_PROGRESS_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
] as const;
const REASONING_PROGRESS_TAG_PREFIXES = REASONING_PROGRESS_TAG_NAMES.flatMap((name) => [
  `<${name}`,
  `</${name}`,
]);

function readReasoningProgressTextOutsideCode(text: string): string | undefined {
  if (isPartialReasoningProgressTagPrefix(text)) {
    // Hold partial tags until more bytes arrive; otherwise a streaming "<thi"
    // fragment can flash as user-visible progress.
    return undefined;
  }
  const codeRegions = findCodeRegions(text);
  let hasTags = false;
  let inReasoning = false;
  let cursor = 0;
  const chunks: string[] = [];
  for (const match of text.matchAll(REASONING_PROGRESS_TAG_RE)) {
    const offset = match.index ?? 0;
    if (isInsideCode(offset, codeRegions)) {
      // Preserve code examples that mention reasoning tags; only actual model
      // wrapper tags outside code delimit private reasoning progress.
      continue;
    }
    hasTags = true;
    if (match[1]) {
      if (inReasoning) {
        chunks.push(text.slice(cursor, offset));
      }
      inReasoning = false;
      cursor = offset + match[0].length;
      continue;
    }
    if (inReasoning) {
      chunks.push(text.slice(cursor, offset));
    }
    inReasoning = true;
    cursor = offset + match[0].length;
  }
  if (!hasTags) {
    return text;
  }
  if (inReasoning) {
    chunks.push(text.slice(cursor));
  }
  return chunks.join("").trim();
}

function isPartialReasoningProgressTagPrefix(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return (
    normalized.startsWith("<") &&
    !normalized.includes(">") &&
    REASONING_PROGRESS_TAG_PREFIXES.some(
      (prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix),
    )
  );
}

function stripReasoningProgressTagsOutsideCode(text: string): string {
  const codeRegions = findCodeRegions(text);
  return text.replace(REASONING_PROGRESS_TAG_RE, (match, _closing: string, offset: number) =>
    isInsideCode(offset, codeRegions) ? match : "",
  );
}

function normalizeReasoningProgressInput(text: string): string {
  const normalized = normalizeReasoningProgressLine(text);
  const italic = normalized.match(/^_(.*)_$/u);
  return (italic?.[1] ?? normalized).trim();
}

function formatReasoningProgressDisplayLine(text: string, maxChars: number): string {
  const normalizedText = normalizeReasoningProgressInput(text);
  const formatted = normalizeReasoningProgressLine(formatReasoningMessage(normalizedText));
  if (!formatted) {
    return "";
  }
  if (Array.from(formatted).length <= maxChars) {
    return formatted;
  }
  const italic = formatted.match(/^_(.*)_$/u);
  if (!italic) {
    return compactReasoningProgressDisplayLine(formatted, maxChars);
  }
  const body = compactReasoningProgressDisplayLine(italic[1] ?? "", Math.max(1, maxChars - 2));
  return body ? `_${body}_` : "";
}

function compactReasoningProgressDisplayLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const head = chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${head.slice(0, boundary).trimEnd()}…`;
  }
  return `${head}…`;
}

function normalizeCommentaryProgressText(text: string): string {
  const cleaned = stripInlineDirectiveTagsForDelivery(text).text.trim();
  if (!cleaned || isSilentCommentaryProgressText(cleaned)) {
    return "";
  }
  return cleaned
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => `_${line}_`)
    .join("\n");
}

function isSilentCommentaryProgressText(text: string): boolean {
  const normalized = text.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized);
}

function mergeReasoningProgressText(
  current: string,
  incoming: string,
  options?: { snapshot?: boolean },
): string {
  if (!current) {
    return incoming;
  }
  const normalizedCurrent = normalizeReasoningProgressInput(current);
  const normalizedIncoming = normalizeReasoningProgressInput(incoming);
  if (!normalizedIncoming) {
    return shouldAppendEmptyReasoningProgressDelta(current, incoming)
      ? `${current}${incoming}`
      : current;
  }
  if (normalizedIncoming === normalizedCurrent) {
    return current;
  }
  if (
    options?.snapshot === true ||
    isReasoningSnapshotText(incoming) ||
    (normalizedCurrent && normalizedIncoming.startsWith(normalizedCurrent))
  ) {
    // Snapshot-style providers resend the full reasoning text. Replace the
    // buffer instead of duplicating the already-seen prefix.
    return incoming;
  }
  return `${current}${incoming}`;
}

function isReasoningSnapshotText(text: string): boolean {
  return /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i.test(
    text,
  );
}

function shouldAppendEmptyReasoningProgressDelta(current: string, incoming: string): boolean {
  return (
    isPartialReasoningProgressTagPrefix(current) ||
    isPartialReasoningProgressTagPrefix(incoming) ||
    hasReasoningProgressTagOutsideCode(incoming)
  );
}

function hasReasoningProgressTagOutsideCode(text: string): boolean {
  const codeRegions = findCodeRegions(text);
  for (const match of text.matchAll(REASONING_PROGRESS_TAG_RE)) {
    if (!isInsideCode(match.index ?? 0, codeRegions)) {
      return true;
    }
  }
  return false;
}
