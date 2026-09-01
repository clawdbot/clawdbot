// Msteams plugin module implements reply stream controller behavior.
import {
  type AgentPlanStep,
  createChannelProgressDraftGate,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-outbound";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MSTeamsConfig, ReplyPayload } from "../runtime-api.js";
import { extractMessageId } from "./media-helpers.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type Maybe<T> = T | undefined;

type TeamsStreamChunkActivity = {
  id?: string;
  type?: string;
  text?: string;
  channelData?: { streamType?: string };
};

type TeamsStreamChunkEvents = {
  on(event: "chunk", handler: (activity: TeamsStreamChunkActivity) => void): number;
  off(subscriptionId: number): void;
};

type MSTeamsNativeDeliveryFinalization = {
  visibleReplySent: boolean;
  content?: string;
  logicalContent?: string;
  messageId?: string;
  fallbackPayload?: ReplyPayload;
  postNativePayloads?: ReplyPayload[];
};

type DeferredReplacementEntry =
  | { kind: "payload"; payload: ReplyPayload }
  | { kind: "replacement"; payload: ReplyPayload };

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
  allowProviderPreview: boolean;
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
    params.allowProviderPreview &&
    isPersonal &&
    (streamMode === "partial" || streamMode === "progress");
  const shouldStreamPreviewToolProgress =
    streamMode === "progress" &&
    resolveChannelStreamingPreviewToolProgress(params.msteamsConfig, true, streamMode);

  const stream = shouldUseNativeStream ? params.context.stream : undefined;

  let tokensEmitted = false;
  let nativeDispatchStarted = false;
  let nativeDeliveryClaimed = false;
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
  let latestPlan: AgentPlanStep[] | undefined;
  let latestPlanExplanation: string | undefined;
  let pendingFinalPayload: Maybe<ReplyPayload>;
  // openclaw's reply pipeline calls onPartialReply with the cumulative text on
  // each chunk, but the SDK's HttpStream appends each emit() to its internal
  // text buffer (this.text += activity.text). Forwarding cumulative text into
  // an appending sink produces "chunk1 + chunk2 + chunk3..." duplication. We
  // track the cumulative text we've already emitted and forward only the
  // delta. Holding text instead of length preserves the next chunk when the
  // pipeline normalizes trailing whitespace between cumulative snapshots.
  let emittedText = "";
  let acknowledgedText = "";
  let acknowledgedStreamId: string | undefined;
  let replacementFinalPending = false;
  let replacementEmitFailed = false;
  let replacementSettlementPending = false;
  let replacementTextAwaitingAcknowledgement: string | undefined;
  let deferredReplacementEntries: DeferredReplacementEntry[] = [];
  let finalMetadataQueued = false;
  let failedSegmentFallbackPrepared = false;
  const streamEvents = (stream as { events?: TeamsStreamChunkEvents } | undefined)?.events;
  let streamChunkSubscription: number | undefined;

  // The SDK emits `chunk` only after Teams acknowledges a cumulative typing
  // activity. Never infer delivered text from emit(), queued bytes, or errors.
  if (typeof streamEvents?.on === "function" && typeof streamEvents.off === "function") {
    streamChunkSubscription = streamEvents.on("chunk", (activity) => {
      const replacementAcknowledgementPending =
        replacementTextAwaitingAcknowledgement !== undefined;
      const replacementAcknowledgement =
        typeof activity.text === "string" &&
        replacementAcknowledgementPending &&
        activity.text === replacementTextAwaitingAcknowledgement;
      if (
        activity.type !== "typing" ||
        activity.channelData?.streamType !== "streaming" ||
        !activity.id ||
        !activity.text ||
        (acknowledgedStreamId !== undefined && activity.id !== acknowledgedStreamId) ||
        (replacementAcknowledgementPending
          ? !replacementAcknowledgement
          : !activity.text.startsWith(acknowledgedText)) ||
        !emittedText.startsWith(activity.text)
      ) {
        return;
      }
      acknowledgedStreamId = activity.id;
      acknowledgedText = activity.text;
      if (activity.text === replacementTextAwaitingAcknowledgement) {
        replacementTextAwaitingAcknowledgement = undefined;
      }
    });
  }

  const wasCanceled = () => canceledLocally || Boolean(stream?.canceled);

  const releaseStreamChunkSubscription = (): void => {
    if (streamChunkSubscription === undefined) {
      return;
    }
    streamEvents?.off(streamChunkSubscription);
    streamChunkSubscription = undefined;
  };

  const acknowledgedNativeDelivery = (): MSTeamsNativeDeliveryFinalization => {
    if (!acknowledgedStreamId || !acknowledgedText) {
      return { visibleReplySent: false };
    }
    return {
      visibleReplySent: true,
      content: acknowledgedText,
      messageId: acknowledgedStreamId,
    };
  };

  const fallbackPayloadAfterAcknowledgedText = (payload: ReplyPayload): Maybe<ReplyPayload> => {
    if (
      !acknowledgedText ||
      typeof payload.text !== "string" ||
      !payload.text.startsWith(acknowledgedText)
    ) {
      return payload;
    }
    const remainingText = payload.text.slice(acknowledgedText.length);
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
    if (!remainingText && !hasMedia) {
      return undefined;
    }
    return { ...payload, text: remainingText || undefined };
  };

  const fallbackPayloadForSuppressedFinal = (payload: ReplyPayload): ReplyPayload => {
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
    return hasMedia ? { ...payload, mediaUrl: undefined, mediaUrls: undefined } : payload;
  };

  const finalStreamActivity = (text?: string) => ({
    type: "message" as const,
    ...(text ? { text } : {}),
    entities: [
      {
        type: "https://schema.org/Message",
        "@type": "Message",
        "@context": "https://schema.org",
        "@id": "",
        additionalType: ["AIGeneratedContent"],
      },
    ],
    channelData: params.feedbackLoopEnabled ? { feedbackLoopEnabled: true } : {},
  });

  const deferredReplacementLogicalContent = (): string | undefined => {
    const content = deferredReplacementEntries
      .map((entry) => entry.payload.text)
      .filter((text): text is string => Boolean(text))
      .join("\n");
    return content || undefined;
  };

  const takeDeferredReplacementPayloads = (
    replacementFallback: Maybe<ReplyPayload>,
  ): ReplyPayload[] => {
    const payloads = deferredReplacementEntries.flatMap((entry) => {
      if (entry.kind === "payload") {
        return [entry.payload];
      }
      const hasMedia = Boolean(entry.payload.mediaUrl || entry.payload.mediaUrls?.length);
      const text = replacementFallback?.text;
      if (!text && !hasMedia) {
        return [];
      }
      return [{ ...entry.payload, text: text || undefined }];
    });
    deferredReplacementEntries = [];
    return payloads;
  };

  /**
   * Render the current informative status line into the streaming card. Pulls
   * the rotating "Thinking..." label from msteams config (or the plugin-sdk
   * default) and prepends collected tool-progress lines when configured.
   */
  const renderInformativeUpdate = (): void => {
    // A late gate timer must not touch the stream once the final text is
    // queued: the SDK resets its stream id on close, so an update after that
    // would post a fresh stale "working" card below the final answer.
    if (!stream || wasCanceled() || streamFinalizationPending) {
      return;
    }
    const informativeText = formatChannelProgressDraftText({
      entry: params.msteamsConfig,
      lines: shouldStreamPreviewToolProgress ? progressLines : [],
      seed: params.progressSeed,
      bullet: "-",
      narration: latestPlanExplanation,
      plan: latestPlan,
    });
    // Empty render after a cleared plan intentionally keeps the previous
    // card: Teams streams cannot delete or blank an update mid-stream, and
    // the final answer settles the card at turn end. Default label configs
    // re-render immediately, so this only lingers with `label: false`.
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
      params.log?.debug?.(`stream informative update failed: ${coerceErrorMessage(err)}`);
    }
  };

  // Gate informative updates so they only start firing once meaningful work
  // has begun (avoids flickering "Thinking..." before the first real tool
  // call). The gate is shape-agnostic — it calls `onStart` once the initial
  // work delay elapses.
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
      if (!stream || !payload.text || wasCanceled() || streamMode !== "partial") {
        return;
      }
      if (replacementSettlementPending && replacementFinalPending) {
        // Keep the newest partial as the replacement candidate until the
        // authoritative final payload arrives. Never append it into the SDK
        // accumulator that clearText() reset.
        pendingFinalPayload = { text: payload.text };
        return;
      }
      if (streamFinalizationPending) {
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
      // Non-whitespace rewrites are not safe to append into Teams. Clear the
      // SDK's local accumulator, then replace the same streamed activity with
      // the authoritative final so a late provider Stop is still observed.
      if (previousRemainder.trim()) {
        stream.clearText();
        if (streamFailed) {
          // A prior provider failure already transferred this and later
          // segments to block delivery. Preserve the pending close cleanup,
          // but do not retry final text through a failed native stream.
          streamFinalizationPending = true;
          return;
        }
        // The SDK can replace the same streamed activity after clearText().
        // Defer the authoritative final to preparePayload so this provider
        // round-trip also discovers a Stop before any fallback can escape.
        replacementFinalPending = true;
        replacementSettlementPending = true;
        pendingFinalPayload = { text: fullText };
        streamFinalizationPending = true;
        return;
      }
      try {
        stream.emit(delta);
        emittedText = fullText;
        tokensEmitted = true;
        nativeDispatchStarted = true;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        // Preserve full fallback unless the SDK has proved exactly which
        // cumulative prefix Teams accepted; failed emits prove no delivery.
        streamFailed = true;
        params.log?.warn?.(
          `msteams stream emit failed, falling back to block delivery: ${coerceErrorMessage(err)}`,
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

    async pushPlanProgress(
      steps?: AgentPlanStep[],
      options?: { explanation?: string },
    ): Promise<void> {
      if (!stream || streamMode !== "progress" || streamFinalizationPending) {
        return;
      }
      latestPlan = steps?.length ? steps.map((entry) => ({ ...entry })) : undefined;
      latestPlanExplanation = options?.explanation?.replace(/\s+/g, " ").trim() || undefined;
      const hadStarted = progressDraftGate.hasStarted;
      await progressDraftGate.startNow();
      if (hadStarted && progressDraftGate.hasStarted) {
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
      if (replacementSettlementPending) {
        if (!replacementFinalPending) {
          deferredReplacementEntries.push({ kind: "payload", payload });
          return undefined;
        }
        if (!payload.text) {
          // The native stream activity was created before final payloads and
          // remains the provider-visible root. Preserve deferred block order
          // after that root; sending early would leak content after Stop.
          deferredReplacementEntries.push({ kind: "payload", payload });
          return undefined;
        }
        replacementFinalPending = false;
        deferredReplacementEntries.push({ kind: "replacement", payload });
        pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
        try {
          replacementTextAwaitingAcknowledgement = payload.text;
          stream.emit(finalStreamActivity(payload.text));
          finalMetadataQueued = true;
          emittedText = payload.text;
          tokensEmitted = false;
          // Replacement delivery owns all later payloads until close() proves
          // that Teams accepted the replacement or did not receive a Stop.
          return undefined;
        } catch (err) {
          replacementTextAwaitingAcknowledgement = undefined;
          tokensEmitted = false;
          if (isStreamCancelledError(err)) {
            canceledLocally = true;
            pendingFinalPayload = undefined;
            deferredReplacementEntries = [];
            return undefined;
          }
          streamFailed = true;
          replacementEmitFailed = true;
          params.log?.warn?.(
            `msteams stream replacement failed, falling back to block delivery: ${coerceErrorMessage(err)}`,
          );
          // Retain ownership until finalize so payloads held before this
          // failed replacement cannot be overtaken by this or later blocks.
          return undefined;
        }
      }
      // Partial mode with tokens already streamed: stream carries the text;
      // strip text from the payload (keep media if any) so block delivery
      // doesn't duplicate. Exception: if a non-cancel stream failure was
      // latched mid-flight, deliver only a provider-acknowledged remainder;
      // preserve the full reply when delivery was not acknowledged.
      if (tokensEmitted && !streamFailed) {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
        streamFinalizationPending = true;
        tokensEmitted = false;
        return hasMedia ? { ...payload, text: undefined } : undefined;
      }
      if (streamFailed) {
        // Trim the provider-acknowledged prefix only from the failed segment.
        // Retain its ID/text for final settlement while later tool rounds fall through whole.
        const fallback = failedSegmentFallbackPrepared
          ? payload
          : fallbackPayloadAfterAcknowledgedText(payload);
        failedSegmentFallbackPrepared = true;
        pendingFinalPayload = undefined;
        return fallback;
      }
      // Progress mode (or partial mode that received no tokens — e.g. a
      // tool-only response): emit the final text into the stream so the
      // preview card transitions in place to the final reply. The SDK's
      // HttpStream accumulates the text and the next `finalize()` close()
      // flushes it as the closing activity.
      if (streamMode === "progress" && payload.text) {
        try {
          stream.emit(payload.text);
          nativeDispatchStarted = true;
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
          params.log?.debug?.(`progress-mode finalize failed: ${coerceErrorMessage(err)}`);
        }
      }
      return payload;
    },

    claimNativeDelivery(): boolean {
      if (!nativeDispatchStarted || nativeDeliveryClaimed) {
        return false;
      }
      nativeDeliveryClaimed = true;
      return true;
    },

    async finalize(): Promise<MSTeamsNativeDeliveryFinalization> {
      // The delay gate may still hold a pending start timer for fast turns;
      // stop it before closing so it cannot fire against the closed stream.
      progressDraftGate.cancel();
      if (!stream || !nativeDispatchStarted) {
        releaseStreamChunkSubscription();
        return { visibleReplySent: false };
      }
      let logicalContent: string | undefined;
      try {
        if (wasCanceled()) {
          pendingFinalPayload = undefined;
          deferredReplacementEntries = [];
          streamFinalizationPending = false;
          return acknowledgedNativeDelivery();
        }
        if (!streamFinalizationPending) {
          return acknowledgedNativeDelivery();
        }
        // A media-only replacement payload may arrive before its text payload.
        // If no authoritative text followed, re-emit the latest divergent
        // partial so close() still performs the Stop-discovering round-trip.
        if (replacementSettlementPending && replacementFinalPending && pendingFinalPayload?.text) {
          replacementFinalPending = false;
          deferredReplacementEntries.push({
            kind: "replacement",
            payload: pendingFinalPayload,
          });
          replacementTextAwaitingAcknowledgement = pendingFinalPayload.text;
          logicalContent = deferredReplacementLogicalContent();
          stream.emit(finalStreamActivity(pendingFinalPayload.text));
          finalMetadataQueued = true;
          emittedText = pendingFinalPayload.text;
        }
        logicalContent ??= replacementSettlementPending
          ? deferredReplacementLogicalContent()
          : undefined;
        const content = pendingFinalPayload?.text ?? (emittedText || undefined);
        // The replacement path already queued text and final metadata as one
        // activity. Other paths add metadata here so the SDK can merge it into
        // the closing activity without duplicating the replacement chunk.
        if (!finalMetadataQueued) {
          stream.emit(finalStreamActivity());
        }
        const result = await stream.close();
        streamFinalizationPending = false;
        if (!result) {
          const fallback = pendingFinalPayload;
          pendingFinalPayload = undefined;
          const canceled = wasCanceled();
          const replacementFallback =
            replacementSettlementPending && fallback && !canceled
              ? fallbackPayloadAfterAcknowledgedText(fallback)
              : undefined;
          const fallbackPayload =
            !replacementSettlementPending && fallback && !canceled
              ? fallbackPayloadAfterAcknowledgedText(fallback)
              : undefined;
          const postNativePayloads =
            replacementSettlementPending && !canceled
              ? takeDeferredReplacementPayloads(replacementFallback)
              : [];
          if (canceled) {
            deferredReplacementEntries = [];
          }
          return {
            ...acknowledgedNativeDelivery(),
            ...(!canceled && logicalContent ? { logicalContent } : {}),
            ...(fallbackPayload ? { fallbackPayload } : {}),
            ...(postNativePayloads.length > 0 ? { postNativePayloads } : {}),
          };
        }
        const replacementFallback =
          replacementSettlementPending && replacementEmitFailed && pendingFinalPayload
            ? fallbackPayloadAfterAcknowledgedText(pendingFinalPayload)
            : undefined;
        pendingFinalPayload = undefined;
        const messageId = extractMessageId(result) ?? acknowledgedStreamId;
        const postNativePayloads = replacementSettlementPending
          ? takeDeferredReplacementPayloads(replacementFallback)
          : [];
        const nativeContent = replacementEmitFailed ? acknowledgedText || undefined : content;
        return {
          visibleReplySent: replacementEmitFailed ? Boolean(nativeContent) : true,
          ...(nativeContent === undefined ? {} : { content: nativeContent }),
          ...(logicalContent ? { logicalContent } : {}),
          ...(messageId && (!replacementEmitFailed || nativeContent) ? { messageId } : {}),
          ...(postNativePayloads.length > 0 ? { postNativePayloads } : {}),
        };
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          pendingFinalPayload = undefined;
          deferredReplacementEntries = [];
          streamFinalizationPending = false;
          return acknowledgedNativeDelivery();
        }
        // Non-cancel failure during the closing emit/close. Preserve only a
        // prefix acknowledged by Teams; queued bytes alone do not prove visibility.
        // Latch streamFailed for parity with the mid-stream path and
        // swallow the error — a thrown finalize would otherwise blow up
        // the reply pipeline after the user already saw the response.
        streamFailed = true;
        streamFinalizationPending = false;
        params.log?.warn?.(`msteams stream finalize failed: ${coerceErrorMessage(err)}`);
        const fallback = pendingFinalPayload;
        pendingFinalPayload = undefined;
        const replacementFallback =
          replacementSettlementPending && fallback
            ? fallbackPayloadAfterAcknowledgedText(fallback)
            : undefined;
        const fallbackPayload =
          !replacementSettlementPending && fallback
            ? fallbackPayloadAfterAcknowledgedText(fallback)
            : undefined;
        const postNativePayloads = replacementSettlementPending
          ? takeDeferredReplacementPayloads(replacementFallback)
          : [];
        return {
          ...acknowledgedNativeDelivery(),
          ...(logicalContent ? { logicalContent } : {}),
          ...(fallbackPayload ? { fallbackPayload } : {}),
          ...(postNativePayloads.length > 0 ? { postNativePayloads } : {}),
        };
      } finally {
        finalMetadataQueued = false;
        replacementEmitFailed = false;
        replacementFinalPending = false;
        replacementSettlementPending = false;
        replacementTextAwaitingAcknowledgement = undefined;
        deferredReplacementEntries = [];
        releaseStreamChunkSubscription();
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
