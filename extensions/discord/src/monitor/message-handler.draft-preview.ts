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
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
} from "openclaw/plugin-sdk/channel-outbound";
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
  const canStreamProgressDraftForToolOnlySource =
    params.sourceRepliesAreToolOnly && discordStreamMode === "progress";
  const canStreamDraft =
    (!params.sourceRepliesAreToolOnly || canStreamProgressDraftForToolOnlySource) &&
    discordStreamMode !== "off" &&
    !accountBlockStreamingEnabled;
  const draftStream = canStreamDraft
    ? createDiscordDraftStream({
        rest: params.deliveryRest,
        channelId: params.deliverChannelId,
        maxChars: draftMaxChars,
        replyToMessageId: () => params.replyReference.peek(),
        minInitialChars: discordStreamMode === "progress" ? 0 : 30,
        suppressEmbeds: params.discordConfig?.suppressEmbeds ?? true,
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
  let finalReplyStarted = false;
  let finalReplyDelivered = false;
  const previewToolProgressEnabled =
    Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(params.discordConfig);
  const commentaryProgressEnabled =
    Boolean(draftStream) && resolveChannelStreamingProgressCommentary(params.discordConfig);
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

  const clearProgressDraftLine = async (lineId: string) => {
    const nextLines = previewToolProgressLines.filter(
      (line) => typeof line !== "object" || line.id?.trim() !== lineId,
    );
    if (nextLines.length === previewToolProgressLines.length) {
      return;
    }
    previewToolProgressLines = nextLines;
    if (!progressDraftGate.hasStarted) {
      return;
    }
    const previewText = formatChannelProgressDraftText({
      entry: params.discordConfig,
      lines: previewToolProgressLines,
      seed: progressSeed,
    });
    if (previewText) {
      await renderProgressDraft();
      return;
    }
    lastPartialText = "";
    draftText = "";
    hasStreamedMessage = false;
    if (draftStream?.messageId()) {
      await draftStream.deleteCurrentMessage();
    }
  };

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
    commentaryProgressEnabled,
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
    markFinalReplyStarted() {
      finalReplyStarted = true;
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
      if (finalReplyStarted || finalReplyDelivered) {
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
      let progressActive;
      if (shouldStartDiscordProgressDraftNow(line)) {
        await progressDraftGate.startNow();
        progressActive = progressDraftGate.hasStarted;
      } else {
        progressActive = await progressDraftGate.noteWork();
      }
      if ((alreadyStarted || progressActive) && progressDraftGate.hasStarted) {
        await renderProgressDraft();
      }
    },
    async pushReasoningProgress(text?: string, options?: { snapshot?: boolean }) {
      if (!draftStream || discordStreamMode !== "progress" || !text) {
        return;
      }
      if (finalReplyDelivered) {
        return;
      }
      reasoningProgressRawText = mergeReasoningProgressText(reasoningProgressRawText, text, {
        snapshot: options?.snapshot === true,
      });
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
      const progressActive = await progressDraftGate.noteWork();
      if (progressActive && progressDraftGate.hasStarted) {
        await renderProgressDraft();
      }
    },
    async pushCommentaryProgress(text?: string, options?: { itemId?: string }) {
      if (!draftStream || discordStreamMode !== "progress" || !commentaryProgressEnabled) {
        return;
      }
      if (finalReplyStarted || finalReplyDelivered) {
        return;
      }
      const itemId = options?.itemId?.trim();
      if (!text && !itemId) {
        return;
      }
      const normalized = normalizeCommentaryProgressText(text ?? "");
      const lineId = itemId ? `commentary:${itemId}` : normalized ? `commentary:${normalized}` : "";
      if (!normalized) {
        if (lineId) {
          await clearProgressDraftLine(lineId);
        }
        return;
      }
      const line: ChannelProgressDraftLine = {
        id: lineId,
        kind: "item",
        text: normalized,
        label: "Commentary",
        prefix: false,
      };
      previewToolProgressLines = mergeChannelProgressDraftLine(previewToolProgressLines, line, {
        maxLines: resolveChannelProgressDraftMaxLines(params.discordConfig),
      });
      await progressDraftGate.startNow();
      await renderProgressDraft();
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
    .replace(/^\s*(?:>\s*)?(?:Reasoning:|Thinking\.{0,3})\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
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
  const normalizedCurrent = normalizeReasoningProgressLine(current);
  const normalizedIncoming = normalizeReasoningProgressLine(incoming);
  if (!normalizedIncoming || normalizedIncoming === normalizedCurrent) {
    return current;
  }
  if (
    options?.snapshot === true ||
    isReasoningSnapshotText(incoming) ||
    normalizedIncoming.startsWith(normalizedCurrent)
  ) {
    return incoming;
  }
  return `${current}${incoming}`;
}

function isReasoningSnapshotText(text: string): boolean {
  return /^\s*(?:>\s*)?(?:Reasoning:|Thinking\.{0,3})\s*/i.test(text);
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
