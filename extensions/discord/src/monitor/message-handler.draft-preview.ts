import { EmbeddedBlockChunker } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelProgressDraftGate,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
} from "openclaw/plugin-sdk/channel-streaming";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
  stripReasoningTagsFromText,
} from "openclaw/plugin-sdk/text-chunking";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { resolveDiscordDraftStreamingChunking } from "../draft-chunking.js";
import { createDiscordDraftStream } from "../draft-stream.js";
import type { RequestClient } from "../internal/discord.js";
import { resolveDiscordPreviewStreamMode } from "../preview-streaming.js";

type DraftReplyReference = {
  peek: () => string | undefined;
};

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

export function createDiscordDraftPreviewController(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sourceRepliesAreToolOnly: boolean;
  textLimit: number;
  deliveryRest: RequestClient;
  deliverChannelId: string;
  replyReference: DraftReplyReference;
  tableMode: Parameters<typeof convertMarkdownTables>[1];
  maxLinesPerMessage: number | undefined;
  chunkMode: Parameters<typeof chunkDiscordTextWithMode>[1]["chunkMode"];
  log: (message: string) => void;
}) {
  const discordStreamMode = resolveDiscordPreviewStreamMode(params.discordConfig);
  const draftMaxChars = Math.min(params.textLimit, 2000);
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(params.discordConfig) ??
    params.cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft =
    !params.sourceRepliesAreToolOnly &&
    discordStreamMode !== "off" &&
    !accountBlockStreamingEnabled;
  const draftStream = canStreamDraft
    ? createDiscordDraftStream({
        rest: params.deliveryRest,
        channelId: params.deliverChannelId,
        maxChars: draftMaxChars,
        replyToMessageId: () => params.replyReference.peek(),
        minInitialChars: discordStreamMode === "progress" ? 0 : 30,
        throttleMs: 1200,
        log: params.log,
        warn: params.log,
      })
    : undefined;
  const draftChunking =
    draftStream && discordStreamMode === "block"
      ? resolveDiscordDraftStreamingChunking(params.cfg, params.accountId)
      : undefined;
  const shouldSplitPreviewMessages = discordStreamMode === "block";
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedMessage = false;
  let finalizedViaPreviewMessage = false;
  let finalReplyDelivered = false;
  const previewToolProgressEnabled =
    Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(params.discordConfig);
  const suppressDefaultToolProgressMessages =
    Boolean(draftStream) &&
    resolveChannelStreamingSuppressDefaultToolProgressMessages(params.discordConfig, {
      draftStreamActive: true,
      previewToolProgressEnabled,
    });
  let previewToolProgressSuppressed = false;
  let previewToolProgressLines: Array<string | ChannelProgressDraftLine> = [];
  let reasoningProgressRawText = "";
  let lastReasoningProgressLine: string | undefined;
  const progressSeed = `${params.accountId}:${params.deliverChannelId}`;

  const renderProgressDraft = async (options?: { flush?: boolean }) => {
    if (!draftStream || discordStreamMode !== "progress") {
      return;
    }
    const previewText = formatChannelProgressDraftText({
      entry: params.discordConfig,
      lines: previewToolProgressLines,
      seed: progressSeed,
    });
    if (!previewText || previewText === lastPartialText) {
      return;
    }
    lastPartialText = previewText;
    draftText = previewText;
    hasStreamedMessage = true;
    draftChunker?.reset();
    draftStream.update(previewText);
    if (options?.flush) {
      await draftStream.flush();
    }
  };

  const progressDraftGate = createChannelProgressDraftGate({
    onStart: () => renderProgressDraft({ flush: true }),
  });

  const resetProgressState = () => {
    lastPartialText = "";
    draftText = "";
    draftChunker?.reset();
    previewToolProgressSuppressed = false;
    previewToolProgressLines = [];
    reasoningProgressRawText = "";
    lastReasoningProgressLine = undefined;
  };

  const forceNewMessageIfNeeded = () => {
    if (shouldSplitPreviewMessages && hasStreamedMessage) {
      params.log("discord: calling forceNewMessage() for draft stream");
      draftStream?.forceNewMessage();
    }
    resetProgressState();
  };

  return {
    draftStream,
    previewToolProgressEnabled,
    suppressDefaultToolProgressMessages,
    get isProgressMode() {
      return discordStreamMode === "progress";
    },
    get hasProgressDraftStarted() {
      return progressDraftGate.hasStarted;
    },
    get finalizedViaPreviewMessage() {
      return finalizedViaPreviewMessage;
    },
    markFinalReplyDelivered() {
      finalReplyDelivered = true;
    },
    markPreviewFinalized() {
      finalizedViaPreviewMessage = true;
    },
    disableBlockStreamingForDraft: draftStream ? true : undefined,
    async startProgressDraft() {
      if (!draftStream || discordStreamMode !== "progress") {
        return;
      }
      await progressDraftGate.startNow();
    },
    async pushToolProgress(
      line?: string | ChannelProgressDraftLine,
      options?: { toolName?: string },
    ) {
      if (!draftStream) {
        return;
      }
      if (
        options?.toolName !== undefined &&
        !isChannelProgressDraftWorkToolName(options.toolName)
      ) {
        return;
      }
      if (isEmptyDiscordProgressLine(line)) {
        return;
      }
      const normalized = normalizeChannelProgressDraftLineIdentity(line);
      if (!normalized) {
        return;
      }
      const progressLine: string | ChannelProgressDraftLine =
        typeof line === "object" && line !== undefined ? line : normalized;
      if (discordStreamMode !== "progress") {
        if (!previewToolProgressEnabled || previewToolProgressSuppressed) {
          return;
        }
        const nextLines = mergeChannelProgressDraftLine(previewToolProgressLines, progressLine, {
          maxLines: resolveChannelProgressDraftMaxLines(params.discordConfig),
        });
        if (nextLines === previewToolProgressLines) {
          return;
        }
        previewToolProgressLines = nextLines;
        const previewText = formatChannelProgressDraftText({
          entry: params.discordConfig,
          lines: previewToolProgressLines,
          seed: progressSeed,
        });
        lastPartialText = previewText;
        draftText = previewText;
        hasStreamedMessage = true;
        draftChunker?.reset();
        draftStream.update(previewText);
        return;
      }
      if (previewToolProgressEnabled && !previewToolProgressSuppressed && normalized) {
        previewToolProgressLines = mergeChannelProgressDraftLine(
          previewToolProgressLines,
          progressLine,
          {
            maxLines: resolveChannelProgressDraftMaxLines(params.discordConfig),
          },
        );
      }
      const alreadyStarted = progressDraftGate.hasStarted;
      if (shouldStartDiscordProgressDraftNow(line)) {
        await progressDraftGate.startNow();
      } else {
        await progressDraftGate.noteWork();
      }
      if (alreadyStarted && progressDraftGate.hasStarted) {
        await renderProgressDraft();
      }
    },
    async pushReasoningProgress(text?: string) {
      if (!draftStream || discordStreamMode !== "progress" || !text) {
        return;
      }
      reasoningProgressRawText = mergeReasoningProgressText(reasoningProgressRawText, text);
      const normalized = normalizeReasoningProgressLine(reasoningProgressRawText);
      if (!normalized) {
        return;
      }
      if (previewToolProgressEnabled && !previewToolProgressSuppressed) {
        const priorIndex =
          lastReasoningProgressLine === undefined
            ? -1
            : previewToolProgressLines.lastIndexOf(lastReasoningProgressLine);
        if (priorIndex >= 0) {
          previewToolProgressLines = [...previewToolProgressLines];
          previewToolProgressLines[priorIndex] = normalized;
        } else {
          previewToolProgressLines = [...previewToolProgressLines, normalized].slice(
            -resolveChannelProgressDraftMaxLines(params.discordConfig),
          );
        }
        lastReasoningProgressLine = normalized;
      }
      const alreadyStarted = progressDraftGate.hasStarted;
      await progressDraftGate.noteWork();
      if (alreadyStarted && progressDraftGate.hasStarted) {
        await renderProgressDraft();
      }
    },
    resolvePreviewFinalText(text?: string) {
      if (typeof text !== "string") {
        return undefined;
      }
      const formatted = convertMarkdownTables(
        stripInlineDirectiveTagsForDelivery(text).text,
        params.tableMode,
      );
      const chunks = chunkDiscordTextWithMode(formatted, {
        maxChars: draftMaxChars,
        maxLines: params.maxLinesPerMessage,
        chunkMode: params.chunkMode,
      });
      if (!chunks.length && formatted) {
        chunks.push(formatted);
      }
      if (chunks.length !== 1) {
        return undefined;
      }
      const trimmed = chunks[0].trim();
      if (!trimmed) {
        return undefined;
      }
      const currentPreviewText = discordStreamMode === "block" ? draftText : lastPartialText;
      if (
        currentPreviewText &&
        currentPreviewText.startsWith(trimmed) &&
        trimmed.length < currentPreviewText.length
      ) {
        return undefined;
      }
      return trimmed;
    },
    updateFromPartial(text?: string) {
      if (!draftStream || !text) {
        return;
      }
      const cleaned = stripInlineDirectiveTagsForDelivery(
        stripReasoningTagsFromText(text, { mode: "strict", trim: "both" }),
      ).text;
      if (!cleaned || cleaned.startsWith("Reasoning:\n")) {
        return;
      }
      if (cleaned === lastPartialText) {
        return;
      }
      if (discordStreamMode === "progress") {
        return;
      }
      previewToolProgressSuppressed = true;
      previewToolProgressLines = [];
      hasStreamedMessage = true;
      if (discordStreamMode === "partial") {
        if (
          lastPartialText &&
          lastPartialText.startsWith(cleaned) &&
          cleaned.length < lastPartialText.length
        ) {
          return;
        }
        lastPartialText = cleaned;
        draftStream.update(cleaned);
        return;
      }

      let delta = cleaned;
      if (cleaned.startsWith(lastPartialText)) {
        delta = cleaned.slice(lastPartialText.length);
      } else {
        draftChunker?.reset();
        draftText = "";
      }
      lastPartialText = cleaned;
      if (!delta) {
        return;
      }
      if (!draftChunker) {
        draftText = cleaned;
        draftStream.update(draftText);
        return;
      }
      draftChunker.append(delta);
      draftChunker.drain({
        force: false,
        emit: (chunk) => {
          draftText += chunk;
          draftStream.update(draftText);
        },
      });
    },
    handleAssistantMessageBoundary() {
      if (discordStreamMode === "progress") {
        return;
      }
      forceNewMessageIfNeeded();
    },
    async flush() {
      if (!draftStream) {
        return;
      }
      if (draftChunker?.hasBuffered()) {
        draftChunker.drain({
          force: true,
          emit: (chunk) => {
            draftText += chunk;
          },
        });
        draftChunker.reset();
        if (draftText) {
          draftStream.update(draftText);
        }
      }
      await draftStream.flush();
    },
    async cleanup() {
      try {
        progressDraftGate.cancel();
        if (!finalReplyDelivered) {
          await draftStream?.discardPending();
        }
        if (!finalReplyDelivered && !finalizedViaPreviewMessage && draftStream?.messageId()) {
          await draftStream.clear();
        }
      } catch (err) {
        params.log(`discord: draft cleanup failed: ${String(err)}`);
      }
    },
  };
}

function normalizeReasoningProgressLine(text: string): string {
  return text
    .replace(/^\s*(?:>\s*)?Reasoning:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeReasoningProgressText(current: string, incoming: string): string {
  if (!current) {
    return incoming;
  }
  const normalizedCurrent = normalizeReasoningProgressLine(current);
  const normalizedIncoming = normalizeReasoningProgressLine(incoming);
  if (!normalizedIncoming || normalizedIncoming === normalizedCurrent) {
    return current;
  }
  if (isReasoningSnapshotText(incoming) || normalizedIncoming.startsWith(normalizedCurrent)) {
    return incoming;
  }
  return `${current}${incoming}`;
}

function isReasoningSnapshotText(text: string): boolean {
  return /^\s*(?:>\s*)?Reasoning:\s*/i.test(text);
}

function isEmptyDiscordProgressLine(line: string | ChannelProgressDraftLine | undefined): boolean {
  if (!line || typeof line === "string") {
    return false;
  }
  return line.toolName === "apply_patch" && !line.detail && !line.status;
}

function shouldStartDiscordProgressDraftNow(
  line: string | ChannelProgressDraftLine | undefined,
): boolean {
  return typeof line === "object" && line?.kind === "patch" && Boolean(line.detail);
}
