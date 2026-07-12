// Msteams plugin module implements reply stream controller behavior.
import {
  createChannelProgressDraftGate,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftLabel,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-outbound";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MSTeamsConfig, ReplyPayload } from "../runtime-api.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type Maybe<T> = T | undefined;

/**
 * Resolve the informative status text shown above the streaming card while the
 * agent is working. Pulls custom labels from `msteams.streaming.progressDraft`
 * config when set, falls back to the plugin-sdk's default rotation otherwise.
 */
export function pickInformativeStatusText(
  params: { config?: MSTeamsConfig; seed?: string; random?: () => number } | (() => number) = {},
): string | undefined {
  const options = typeof params === "function" ? { random: params } : params;
  return resolveChannelProgressDraftLabel({
    entry: options.config,
    seed: options.seed,
    random: options.random,
  });
}

// The SDK throws StreamCancelledError synchronously from stream.emit/update
// when the user pressed Stop in Teams (Teams replies 403 to the next chunk
// update and the SDK flips _canceled). Match by `name` rather than importing
// the class — tsgo can't resolve the re-export chain through
// @microsoft/teams.apps/dist/types/streamer, and the SDK's own code at
// utils/promises/retry.js falls back to this same name check.
function isStreamCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === "StreamCancelledError";
}

/**
 * Bridges openclaw's reply pipeline callbacks to the SDK's `ctx.stream`.
 * Streaming is enabled for personal (DM) conversations only; group/channel
 * messages fall through to block delivery.
 *
 * Streaming modes (resolved from `cfg.channels.msteams.streaming.preview`):
 * - "partial" (default): per-token streaming via `stream.emit(text)`. Each
 *   chunk goes onto the live preview card in Teams.
 * - "progress": no per-token streaming; the preview card carries an
 *   informative status that updates as tools run (e.g. "Looking up the
 *   schema..." → "Generating SQL..."). When tool-progress streaming is also
 *   enabled, raw tool names appear as bullets above the label.
 * - "block": disable native streaming entirely; the reply lands as a regular
 *   block message. We bypass the controller in that case.
 */
export function createTeamsReplyStreamController(params: {
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  log?: MSTeamsMonitorLogger;
  msteamsConfig?: MSTeamsConfig;
  /**
   * Seed for the random label rotation so the same conversation gets the same
   * "Thinking..." flavor across reconnects. Typically `${accountId}:${convId}`.
   */
  progressSeed?: string;
  random?: () => number;
}) {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const streamMode = resolveChannelPreviewStreamMode(params.msteamsConfig, "partial");
  const shouldUseNativeStream =
    isPersonal && (streamMode === "partial" || streamMode === "progress");
  const shouldStreamPreviewToolProgress =
    streamMode === "progress" && resolveChannelStreamingPreviewToolProgress(params.msteamsConfig);

  const stream = shouldUseNativeStream ? params.context.stream : undefined;

  let tokensEmitted = false;
  let streamFinalizationPending = false;
  let canceledLocally = false;
  // Set when `stream.emit/close` fails for a non-cancel reason after we've
  // already started streaming. Differentiates "user pressed Stop" from "the
  // stream broke under us"; the second case wants block-delivery fallback so
  // the user gets the full reply instead of a truncated streamed prefix.
  // Matches the pre-migration `TeamsHttpStream.hasContent → false` recovery.
  let streamFailed = false;
  let lastInformativeText = "";
  let progressLines: Array<string | ChannelProgressDraftLine> = [];
  let pendingFinalPayload: Maybe<ReplyPayload>;
  // openclaw's reply pipeline calls onPartialReply with the cumulative text on
  // each chunk, but the SDK's HttpStream appends each emit() to its internal
  // text buffer (this.text += activity.text). Forwarding cumulative text into
  // an appending sink produces "chunk1 + chunk2 + chunk3..." duplication. We
  // track the cumulative text we've already emitted and forward only the
  // delta. Holding text instead of length preserves the next chunk when the
  // pipeline normalizes trailing whitespace between cumulative snapshots.
  let emittedText = "";

  const wasCanceled = () => canceledLocally || Boolean(stream?.canceled);

  const fallbackPayloadForSuppressedFinal = (payload: ReplyPayload): ReplyPayload => {
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
    return hasMedia ? { ...payload, mediaUrl: undefined, mediaUrls: undefined } : payload;
  };

  /**
   * Render the current informative status line into the streaming card. Pulls
   * the rotating "Thinking..." label from msteams config (or the plugin-sdk
   * default) and prepends collected tool-progress lines when configured.
   */
  const renderInformativeUpdate = (): void => {
    if (!stream || wasCanceled()) {
      return;
    }
    const informativeText = formatChannelProgressDraftText({
      entry: params.msteamsConfig,
      lines: shouldStreamPreviewToolProgress ? progressLines : [],
      seed: params.progressSeed,
      bullet: "-",
    });
    if (!informativeText || informativeText === lastInformativeText) {
      return;
    }
    lastInformativeText = informativeText;
    try {
      stream.update(informativeText);
    } catch (err) {
      if (isStreamCancelledError(err)) {
        canceledLocally = true;
        return;
      }
      params.log?.debug?.(
        `stream informative update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Gate informative updates so they only start firing once meaningful work
  // has begun (avoids flickering "Thinking..." before the first real tool
  // call). The gate is shape-agnostic — it just calls `onStart` once when the
  // first noteWork() arrives.
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: renderInformativeUpdate,
  });

  return {
    async onReplyStart(): Promise<void> {
      // Starting a reply is not enough to decide that native streaming should
      // own delivery. Wait for text tokens or explicit progress work so
      // no-token replies keep the normal block-delivery path.
    },

    onPartialReply(payload: { text?: string }): void {
      // Partial-token streaming only fires in "partial" mode. In "progress"
      // mode, openclaw's pipeline doesn't deliver tokens — the model output
      // arrives as a single payload at preparePayload time.
      if (
        !stream ||
        !payload.text ||
        wasCanceled() ||
        streamMode !== "partial" ||
        streamFinalizationPending
      ) {
        return;
      }
      // Convert cumulative-text from the pipeline into deltas for the SDK's
      // appending sink. Without this, "Here's a" → "Here's a sonnet" → ...
      // gets emitted as full repeats and the SDK concatenates the lot.
      const fullText = payload.text;
      let prefixLength = 0;
      while (
        prefixLength < emittedText.length &&
        prefixLength < fullText.length &&
        emittedText[prefixLength] === fullText[prefixLength]
      ) {
        prefixLength += 1;
      }
      const previousRemainder = emittedText.slice(prefixLength);
      const delta = fullText.slice(prefixLength);
      // Duplicate or prefix-only out-of-order snapshots produce no delta.
      if (!delta) {
        return;
      }
      // Non-whitespace rewrites are not safe to append into Teams. Let block
      // delivery carry the final payload, but clear the SDK's accumulated text
      // before closing so stale prefixes are not finalized as another message.
      if (previousRemainder.trim()) {
        stream.clearText();
        streamFailed = true;
        streamFinalizationPending = true;
        return;
      }
      try {
        stream.emit(delta);
        emittedText = fullText;
        tokensEmitted = true;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        // Non-cancel failure: latch streamFailed so `preparePayload` lets
        // block delivery happen even though tokens were already emitted.
        // The user may see a duplicate (streamed prefix + full block reply)
        // — that's intentional and matches the pre-migration recovery
        // behavior; truncated-only is the worse outcome.
        streamFailed = true;
        params.log?.warn?.(
          `msteams stream emit failed, falling back to block delivery: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    /**
     * Note that the agent is working — bumps the progress-draft gate so the
     * informative status starts (or refreshes) on the next render. Called
     * from the reply-dispatcher's typing callbacks.
     */
    async noteProgressWork(options?: { toolName?: string }): Promise<void> {
      if (!stream || streamMode !== "progress") {
        return;
      }
      // Filter out non-work tool names (e.g. internal scheduling helpers) so
      // the user only sees lines for tools that actually represent work.
      if (
        options?.toolName !== undefined &&
        !isChannelProgressDraftWorkToolName(options.toolName)
      ) {
        return;
      }
      const hadStarted = progressDraftGate.hasStarted;
      const progressActive = await progressDraftGate.noteWork();
      // If the gate was already started, the call above is a no-op — refresh
      // the informative line manually so the latest progress lines render.
      if ((hadStarted || progressActive) && progressDraftGate.hasStarted) {
        renderInformativeUpdate();
      }
    },

    /**
     * Append a tool-progress line (e.g. a tool name being invoked) into the
     * preview card's informative status. Only takes effect in "progress" mode
     * with `streaming.previewToolProgress` enabled in config.
     */
    async pushProgressLine(
      line?: string | ChannelProgressDraftLine,
      options?: { toolName?: string },
    ): Promise<void> {
      if (!stream || streamMode !== "progress") {
        return;
      }
      if (
        options?.toolName !== undefined &&
        !isChannelProgressDraftWorkToolName(options.toolName)
      ) {
        return;
      }
      if (shouldStreamPreviewToolProgress) {
        const normalized = normalizeChannelProgressDraftLineIdentity(line);
        if (normalized) {
          const progressLine: string | ChannelProgressDraftLine =
            typeof line === "object" && line !== undefined ? line : normalized;
          progressLines = mergeChannelProgressDraftLine(progressLines, progressLine, {
            maxLines: resolveChannelProgressDraftMaxLines(params.msteamsConfig),
          });
        }
      }
      const hadStarted = progressDraftGate.hasStarted;
      const progressActive = await progressDraftGate.noteWork();
      if ((hadStarted || progressActive) && progressDraftGate.hasStarted) {
        renderInformativeUpdate();
      }
    },

    preparePayload(payload: ReplyPayload): Maybe<ReplyPayload> {
      if (!stream) {
        return payload;
      }
      // User pressed Stop (or Teams ended the stream) — the streamed prefix
      // is already visible to the user. Dropping the payload here prevents a
      // second block message from re-delivering the rest, which would override
      // the explicit cancel intent.
      if (wasCanceled()) {
        return undefined;
      }
      // Partial mode with tokens already streamed: stream carries the text;
      // strip text from the payload (keep media if any) so block delivery
      // doesn't duplicate. Exception: if a non-cancel stream failure was
      // latched mid-flight, fall through to block delivery so the user gets
      // the full reply instead of the truncated streamed prefix.
      if (tokensEmitted && !streamFailed) {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
        streamFinalizationPending = true;
        tokensEmitted = false;
        return hasMedia ? { ...payload, text: undefined } : undefined;
      }
      // Progress mode (or partial mode that received no tokens — e.g. a
      // tool-only response): emit the final text into the stream so the
      // preview card transitions in place to the final reply. The SDK's
      // HttpStream accumulates the text and the next `finalize()` close()
      // flushes it as the closing activity.
      if (streamMode === "progress" && payload.text) {
        try {
          stream.emit(payload.text);
          pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
          streamFinalizationPending = true;
          const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
          return hasMedia ? { ...payload, text: undefined } : undefined;
        } catch (err) {
          if (isStreamCancelledError(err)) {
            canceledLocally = true;
            return undefined;
          }
          // Non-cancel emit failure: fall through to block delivery as a
          // safety net so the user still sees the final reply.
          params.log?.debug?.(
            `progress-mode finalize failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return payload;
    },

    async finalize(): Promise<Maybe<ReplyPayload>> {
      if (!stream || !streamFinalizationPending || wasCanceled()) {
        return undefined;
      }
      // Emit a final MessageActivity carrying the AI-generated marker and (if
      // enabled) the feedback channelData. The SDK's HttpStream merges this
      // into the closing activity it sends to Teams, so streamed replies still
      // get the AI-generated label and thumbs up/down.
      const finalEntities: Array<Record<string, unknown>> = [
        {
          type: "https://schema.org/Message",
          "@type": "Message",
          "@context": "https://schema.org",
          "@id": "",
          additionalType: ["AIGeneratedContent"],
        },
      ];
      const finalChannelData: Record<string, unknown> = params.feedbackLoopEnabled
        ? { feedbackLoopEnabled: true }
        : {};
      try {
        stream.emit({
          type: "message",
          entities: finalEntities,
          channelData: finalChannelData,
        });
        const result = await stream.close();
        streamFinalizationPending = false;
        if (!result) {
          const fallback = pendingFinalPayload;
          pendingFinalPayload = undefined;
          return fallback;
        }
        pendingFinalPayload = undefined;
        return undefined;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          pendingFinalPayload = undefined;
          streamFinalizationPending = false;
          return undefined;
        }
        // Non-cancel failure during the closing emit/close. The streamed
        // prefix is already visible to the user; the only loss is the
        // closing activity (AI-Generated marker, feedback channelData).
        // Latch streamFailed for parity with the mid-stream path and
        // swallow the error — a thrown finalize would otherwise blow up
        // the reply pipeline after the user already saw the response.
        streamFailed = true;
        streamFinalizationPending = false;
        params.log?.warn?.(
          `msteams stream finalize failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        const fallback = pendingFinalPayload;
        pendingFinalPayload = undefined;
        return fallback;
      }
    },

    hasStream(): boolean {
      return Boolean(stream);
    },

    isStreamActive(): boolean {
      return Boolean(stream) && tokensEmitted && !wasCanceled() && !streamFailed;
    },

    wasCanceled,
  };
}
