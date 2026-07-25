import { EmbeddedBlockChunker } from "openclaw/plugin-sdk/agent-runtime";
import {
  type AgentPlanStep,
  type ChannelProgressDraftLine,
  createChannelProgressDraftCompositor,
  resolveChannelProgressDraftConfig,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingProgressNarration,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord plugin module implements message handlerraft preview behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
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
  let finalReplyDelivered = false;
  // Final delivery can cancel the gate before Discord consumes collapse
  // eligibility, so keep the pre-final state until that transition occurs.
  let progressDraftStartedBeforeFinal = false;
  let progressDraftCollapsed = false;
  let progressNarratorLifecycle: { beginTurn: () => void; stopTurn: () => void } | undefined;
  const progressConfig = resolveChannelProgressDraftConfig(params.discordConfig);
  const progressHasExplicitLabel =
    progressConfig.label !== undefined || progressConfig.labels !== undefined;
  // Discord defaults to progress mode even when `streaming.mode` is omitted,
  // so pass that resolved mode into the shared default through this fallback.
  const progressToolDefault = progressConfig.toolProgress ?? progressHasExplicitLabel;
  const previewToolProgressEnabled =
    Boolean(draftStream) &&
    resolveChannelStreamingPreviewToolProgress(
      params.discordConfig,
      discordStreamMode === "progress" ? progressToolDefault : true,
    );
  const narrationProgressEnabled =
    Boolean(draftStream) &&
    discordStreamMode === "progress" &&
    resolveChannelStreamingProgressNarration(params.discordConfig);
  // Narration model input follows the channel's command-text display policy:
  // "status" hides raw exec/bash text from viewers, so it must not reach the
  // utility model either.
  const narrationHideCommandText =
    narrationProgressEnabled &&
    resolveChannelStreamingPreviewCommandText(params.discordConfig) === "status";
  const suppressDefaultToolProgressMessages =
    Boolean(draftStream) &&
    resolveChannelStreamingSuppressDefaultToolProgressMessages(params.discordConfig, {
      draftStreamActive: true,
      previewToolProgressEnabled,
    });
  const progressSeed = `${params.accountId}:${params.deliverChannelId}`;
  const progressDraft = createChannelProgressDraftCompositor({
    entry: params.discordConfig,
    mode: discordStreamMode,
    active: Boolean(draftStream),
    seed: progressSeed,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    reasoningGate: previewToolProgressEnabled,
    commentaryItalics: false,
    update: async (previewText, options) => {
      lastPartialText = previewText;
      draftText = previewText;
      hasStreamedMessage = true;
      draftChunker?.reset();
      draftStream?.update(previewText);
      if (options?.flush) {
        await draftStream?.flush();
      }
    },
    deleteCurrent: async () => {
      lastPartialText = "";
      draftText = "";
      hasStreamedMessage = false;
      if (draftStream?.messageId()) {
        await draftStream.deleteCurrentMessage();
      }
    },
    isEmptyLine: isEmptyDiscordProgressLine,
    shouldStartNow: shouldStartDiscordProgressDraftNow,
  });

  const resetProgressState = () => {
    lastPartialText = "";
    draftText = "";
    draftChunker?.reset();
    progressDraft.reset();
  };

  const forceNewMessageIfNeeded = () => {
    if (shouldSplitPreviewMessages && hasStreamedMessage) {
      params.log("discord: calling forceNewMessage() for draft stream");
      draftStream?.forceNewMessage();
    }
    resetProgressState();
  };

  const pushPreambleHeadline = async (text?: string, options?: { itemId?: string }) => {
    if (discordStreamMode === "progress") {
      await progressDraft.pushPreambleHeadline(text, options);
    }
  };

  return {
    draftStream,
    previewToolProgressEnabled,
    narrationProgressEnabled,
    narrationHideCommandText,
    commentaryProgressEnabled: progressDraft.commentaryProgressEnabled,
    suppressDefaultToolProgressMessages,
    get isProgressMode() {
      return discordStreamMode === "progress";
    },
    get hasProgressDraftStarted() {
      return progressDraft.hasStarted;
    },
    get isProgressDraftVisible() {
      return progressDraft.isVisible;
    },
    get hasProgressDraftToCollapse() {
      return (
        !progressDraftCollapsed && (progressDraft.hasStarted || progressDraftStartedBeforeFinal)
      );
    },
    markProgressDraftCollapsed() {
      progressDraftCollapsed = true;
      progressDraftStartedBeforeFinal = false;
    },
    get finalizedViaPreviewMessage() {
      return finalizedViaPreviewMessage;
    },
    setProgressNarratorLifecycle(lifecycle: { beginTurn: () => void; stopTurn: () => void }) {
      progressNarratorLifecycle = lifecycle;
    },
    markFinalReplyStarted() {
      progressDraftStartedBeforeFinal ||= progressDraft.hasStarted;
      progressDraft.markFinalReplyStarted();
      progressNarratorLifecycle?.stopTurn();
    },
    markFinalReplyDelivered() {
      finalReplyDelivered = true;
      progressDraft.markFinalReplyDelivered();
    },
    markPreviewFinalized() {
      finalizedViaPreviewMessage = true;
    },
    disableBlockStreamingForDraft: draftStream ? true : undefined,
    async pushToolProgress(
      line?: string | ChannelProgressDraftLine,
      options?: { toolName?: string },
    ) {
      await progressDraft.pushToolProgress(line, options);
    },
    async pushPlanProgress(steps?: AgentPlanStep[], options?: { explanation?: string }) {
      await progressDraft.pushPlanProgress(steps, options);
    },
    async pushReasoningProgress(text?: string, options?: { snapshot?: boolean }) {
      await progressDraft.pushReasoningProgress(text, options);
    },
    async pushNarrationProgress(text?: string) {
      await progressDraft.pushNarrationProgress(text);
    },
    pushPreambleHeadline,
    async pushPreambleItemEvent(
      payload: { itemId?: string; progressText?: string },
      noteCommentary: (itemId?: string, text?: string) => void,
    ) {
      await pushPreambleHeadline(payload.progressText, { itemId: payload.itemId });
      if (!progressDraft.commentaryProgressEnabled) {
        return;
      }
      const accepted = await progressDraft.pushCommentaryProgress(payload.progressText, {
        itemId: payload.itemId,
      });
      // Count only sanitized commentary that actually streamed to the window.
      if (accepted) {
        noteCommentary(payload.itemId, payload.progressText);
      }
    },
    async pushCommentaryProgress(text?: string, options?: { itemId?: string }) {
      await progressDraft.pushCommentaryProgress(text, options);
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
      const trimmed = expectDefined(chunks.at(0), "single Discord preview chunk").trim();
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
      progressDraft.suppress();
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
      // Queued/followup turns need a fresh progress draft after the primary final.
      const beganNewTurn = progressDraft.beginNewTurn();
      if (beganNewTurn) {
        progressDraftCollapsed = false;
        progressDraftStartedBeforeFinal = false;
        finalReplyDelivered = false;
        finalizedViaPreviewMessage = false;
        progressNarratorLifecycle?.beginTurn();
      }
      if (discordStreamMode === "progress") {
        if (beganNewTurn) {
          draftStream?.forceNewMessage("discard");
        }
        return beganNewTurn;
      }
      forceNewMessageIfNeeded();
      return beganNewTurn;
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
        progressDraft.cancel();
        if (!finalReplyDelivered) {
          await draftStream?.discardPending();
        }
        if (!finalizedViaPreviewMessage && draftStream?.messageId()) {
          await draftStream.clear();
        }
      } catch (err) {
        params.log(`discord: draft cleanup failed: ${String(err)}`);
      }
    },
  };
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
