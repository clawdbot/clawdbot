import {
  type AgentPlanStep,
  createChannelProgressDraftCompositor,
  createDraftStreamLoop,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { SLACK_EDIT_TEXT_MAX_BYTES, SLACK_TEXT_LIMIT } from "../../limits.js";
import {
  buildSlackProgressStreamChunks,
  reconcileSlackNativeTaskChunks,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
  type SlackNativeStreamSnapshot,
} from "../../progress-blocks.js";
import { applyAppendOnlyStreamUpdate } from "../../stream-mode.js";
import { appendSlackStream } from "../../streaming.js";
import {
  resolveExplicitSlackProgressTitle,
  resolveSlackProgressStyle,
} from "./dispatch-helpers.js";
import {
  createSlackDraftProgressCardRuntime,
  formatSlackProgressDraftLine,
} from "./dispatch-progress-card.js";
import { createSlackNativeProgressTransport } from "./dispatch-progress-native.js";
import {
  combineProgressHeadlineAndExplanation,
  resolveNativeProgressLines,
  resolveNativeProgressNarration,
} from "./dispatch-progress-render.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import type { SlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";

export function createSlackProgressRuntime(runtimeParams: {
  setup: SlackDispatchSetup;
  delivery: SlackStreamingDeliveryRuntime;
  resetPreviewDeliveryState: () => void;
}) {
  const { setup, delivery, resetPreviewDeliveryState } = runtimeParams;
  const {
    account,
    cfg,
    ctx,
    hasSlackCustomIdentity,
    message,
    prepared,
    replyPlan,
    runtime,
    slackClient,
    slackIdentity,
    slackMessageMetadata,
    slackStreaming,
    shouldUseDraftStream,
    useStreaming,
    previewStreamingEnabled,
  } = setup;
  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
        target: prepared.replyTarget,
        cfg,
        token: ctx.botToken,
        accountId: account.accountId,
        conversationChannelId: message.channel,
        eventScope: prepared.eventScope,
        // Impersonated Slack messages cannot be deleted. Keep the temporary
        // preview app-authored and apply custom identity only to final delivery.
        ...(!hasSlackCustomIdentity && slackIdentity ? { identity: slackIdentity } : {}),
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
        resolveThreadTs: () => {
          const ts = replyPlan.peekThreadTs();
          if (ts) {
            delivery.usedReplyThreadTs ??= ts;
          }
          return ts;
        },
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  let hasStreamedAnswer = false;
  const isProgressMode = slackStreaming.mode === "progress";
  const useNativeProgressStreaming = useStreaming && slackStreaming.mode === "progress";
  const progressDraftActive = Boolean(draftStream) || useNativeProgressStreaming;
  const previewToolProgressEnabled =
    progressDraftActive &&
    resolveChannelStreamingPreviewToolProgress(account.config, true, slackStreaming.mode);
  let shouldYieldDraftProgress: () => boolean = () => false;
  const suppressDefaultToolProgressMessages =
    resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
      draftStreamActive: Boolean(draftStream) || useNativeProgressStreaming,
      mode: slackStreaming.mode,
      previewToolProgressEnabled,
      previewStreamingEnabled,
    });
  let previewToolProgressSuppressed = false;
  // Plan title and task rows already delivered to the native stream; the
  // reconciler diffs each snapshot against it and terminalizes ids that drop
  // out (plan shrinks, summary <-> plan source switches).
  let nativeStreamSnapshot: SlackNativeStreamSnapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
  let appendRenderedText = "";
  let appendSourceText = "";
  let nativeProgressCompletionSent = false;
  // Terminal status of the turn's final payload; completion retries and
  // queued rotation must not repaint an errored turn as complete.
  let nativeProgressTerminalStatus: "complete" | "error" = "complete";
  let nativeNarrationRenderedText = "";
  let nativeNarrationSourceText = "";
  // Native streaming appends; overlapping updates would re-append identical
  // narration/chunks because delta state commits only after network success.
  // One chain keeps each update's compute -> append -> commit atomic.
  let nativeStreamOrder: Promise<unknown> = Promise.resolve();
  const withNativeStreamOrder = <T>(task: () => Promise<T>): Promise<T> => {
    const run = nativeStreamOrder.then(task, task);
    nativeStreamOrder = run.catch(() => undefined);
    return run;
  };
  const progressSeed = `${account.accountId}:${message.channel}`;
  const slackProgressStyle = resolveSlackProgressStyle(account.config);
  // THIS BEHAVIOR IS INTENTIONAL AND MUST NOT BE CASUALLY ADJUSTED.
  // DO NOT CHANGE THIS WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
  const useDraftProgressCard =
    Boolean(draftStream) && isProgressMode && slackProgressStyle === "card";
  const explicitProgressTitle = resolveExplicitSlackProgressTitle(account.config);
  const progressDraftMaxLineChars = resolveChannelProgressDraftMaxLineChars(account.config);
  const progressCard = createSlackDraftProgressCardRuntime({
    setup: { account, cfg, ctx, prepared, slackClient },
    draftStream,
    enabled: useDraftProgressCard,
    progressSeed,
    explicitTitle: explicitProgressTitle,
    maxLineChars: progressDraftMaxLineChars,
    getSnapshot: () => progressDraft.getSnapshot(),
    getThreadTs: () => delivery.usedReplyThreadTs,
  });
  const nativeTransport = createSlackNativeProgressTransport({ setup, delivery });
  // Card-only cleanup. Other draft modes abandon a preview holding streamed
  // assistant text the human already replied to; that message stays visible.
  const dropDetachedProgressCards = async () => {
    if (!useDraftProgressCard) {
      return;
    }
    await draftStream?.dropDetachedMessages();
  };

  const appendNativeProgressCompletion = async (isError: boolean) => {
    const session = delivery.streamSession;
    if (isError) {
      nativeProgressTerminalStatus = "error";
    }
    if (!session || nativeProgressCompletionSent) {
      return;
    }
    const chunks = buildNativeProgressCompletionChunks(isError ? "error" : "complete");
    const narrationUpdate = resolveNarrationUpdate(
      resolveNativeProgressNarration(progressDraft.getSnapshot()),
    );
    if (!chunks?.length && !narrationUpdate.delta) {
      return;
    }
    try {
      await appendSlackStream({ session, chunks });
      if (narrationUpdate.next.changed) {
        nativeNarrationRenderedText = narrationUpdate.next.rendered;
        nativeNarrationSourceText = narrationUpdate.next.source;
      }
      nativeProgressCompletionSent = true;
      delivery.observedReplyDelivery ||= session.delivered;
    } catch (err) {
      delivery.streamFailed = true;
      runtime.error?.(
        danger(`slack-stream: native progress completion failed: ${formatSlackError(err)}`),
      );
    }
  };

  const resolveNativeProgressTitle = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    combineProgressHeadlineAndExplanation(
      explicitProgressTitle ?? snapshot.statusHeadline,
      snapshot.planExplanation,
    );

  const normalizeProgressText = (text: string | undefined) =>
    text?.replace(/\s+/gu, " ").trim() ?? "";

  const isRenderedAsProgressTitle = (text: string | undefined): boolean => {
    const candidate = normalizeProgressText(text);
    if (!candidate) {
      return false;
    }
    const title = normalizeProgressText(resolveNativeProgressTitle(progressDraft.getSnapshot()));
    return title.length > 0 && title.includes(candidate);
  };

  const resolveNarrationUpdate = (incoming: string | undefined) => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: incoming ?? "",
      rendered: nativeNarrationRenderedText,
      source: nativeNarrationSourceText,
    });
    return {
      next,
      delta: next.changed ? next.rendered.slice(nativeNarrationRenderedText.length) : "",
    };
  };

  const updateNativeProgressStreamNow = async (): Promise<boolean> => {
    const snapshot = progressDraft.getSnapshot();
    const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(snapshot));
    if (!useNativeProgressStreaming || delivery.streamFailed || nativeUpdatesStopped) {
      return false;
    }
    const canContinue = await nativeTransport.waitForStart();
    if (!canContinue) {
      return false;
    }
    const reconciled = reconcileSlackNativeTaskChunks({
      previous: nativeStreamSnapshot,
      chunks: buildSlackProgressStreamChunks({
        title: resolveNativeProgressTitle(snapshot) ?? "Working",
        lines: resolveNativeProgressLines(snapshot),
        plan: snapshot.plan,
      }),
    });
    const chunks = reconciled.chunks;
    if (!chunks?.length && !narrationUpdate.delta) {
      return false;
    }
    try {
      const hadSession = Boolean(delivery.streamSession);
      const streamUpdate = {
        ...(narrationUpdate.delta ? { text: narrationUpdate.delta } : {}),
        ...(chunks?.length ? { chunks } : {}),
      };
      const accepted = hadSession
        ? await nativeTransport.append(streamUpdate)
        : await nativeTransport.start(streamUpdate);
      if (!accepted) {
        return false;
      }
      // Commit transport identity and task state together. Buffered or failed
      // chunks must leave the identical render eligible for another attempt.
      if (!hadSession) {
        replyPlan.markSent();
      }
      if (narrationUpdate.next.changed) {
        nativeNarrationRenderedText = narrationUpdate.next.rendered;
        nativeNarrationSourceText = narrationUpdate.next.source;
      }
      if (chunks?.length) {
        nativeStreamSnapshot = reconciled.snapshot;
      }
      return true;
    } catch (err) {
      runtime.error?.(
        danger(
          `slack-stream: native progress stream failed: ${formatSlackError(err)}, falling back`,
        ),
      );
      delivery.streamFailed = true;
      return false;
    }
  };

  let nativeUpdatesStopped = false;
  // Read the latest compositor snapshot only when the batch sends. Terminal
  // delivery cancels pending batches before joining the same transport chain.
  const nativeUpdates = createDraftStreamLoop<boolean>({
    throttleMs: 1_000,
    coalesceInFlight: true,
    emptyValue: false,
    isEmpty: (pending) => !pending,
    isStopped: () => nativeUpdatesStopped,
    sendOrEditStreamMessage: () => withNativeStreamOrder(updateNativeProgressStreamNow),
    onBackgroundFlushError: (err) =>
      runtime.error?.(danger(`slack-stream: progress update failed: ${formatSlackError(err)}`)),
  });
  const cancelNativeUpdates = async () => {
    nativeUpdatesStopped = true;
    nativeUpdates.stop();
    await nativeUpdates.waitForInFlight();
  };

  const appendNativeNarration = (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<boolean> => withNativeStreamOrder(() => appendNativeNarrationNow(payload, kind));

  const appendNativeNarrationNow = async (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<boolean> => {
    // The same preamble reaches us as a reply payload and as the compositor
    // headline behind the card title. The card updates it in place, so
    // streaming it as text too would print the line twice.
    if (isRenderedAsProgressTitle(payload.text)) {
      return false;
    }
    const narrationUpdate = resolveNarrationUpdate(payload.text?.trimEnd());
    if (!narrationUpdate.delta) {
      return false;
    }
    await delivery.deliverWithStreaming({
      payload,
      kind,
      streamText: narrationUpdate.delta,
      appendSeparator: false,
      taskDisplayMode: "plan",
    });
    if (!delivery.streamFailed) {
      nativeNarrationRenderedText = narrationUpdate.next.rendered;
      nativeNarrationSourceText = narrationUpdate.next.source;
    }
    return true;
  };

  const resetProgressTurnState = () => {
    nativeNarrationRenderedText = "";
    nativeNarrationSourceText = "";
  };

  const progressDraft = createChannelProgressDraftCompositor({
    presentation: isProgressMode && slackProgressStyle === "card" ? "summary" : undefined,
    entry: account.config,
    mode: slackStreaming.mode,
    active: progressDraftActive,
    seed: progressSeed,
    formatLine: formatSlackProgressDraftLine,
    reasoningLinePrefix: "🧠 ",
    reasoningGate: previewToolProgressEnabled,
    updateOnLineChange: useNativeProgressStreaming || useDraftProgressCard,
    update: async (previewText, options) => {
      if (useNativeProgressStreaming) {
        const priorSnapshot = nativeStreamSnapshot;
        const priorNarration = nativeNarrationRenderedText;
        nativeUpdates.update(true);
        if (options?.flush) {
          await nativeUpdates.flush();
        } else {
          await nativeUpdates.waitForInFlight();
        }
        return (
          priorSnapshot !== nativeStreamSnapshot || priorNarration !== nativeNarrationRenderedText
        );
      }
      if (!draftStream) {
        return false;
      }
      const snapshot = progressDraft.getSnapshot();
      progressCard.setFallbackText(previewText);
      draftStream.update(
        useDraftProgressCard
          ? {
              text: previewText,
              blocks: progressCard.resolvePresentation(snapshot, "working"),
            }
          : previewText,
      );
      if (options?.flush) {
        await draftStream.flush();
      }
      return Boolean(draftStream.messageId() && draftStream.channelId());
    },
  });
  const commentaryProgressEnabled = progressDraft.commentaryProgressEnabled;

  const deliverNativeFinal = async (
    payload: ReplyPayload,
    kind: ReplyDispatchKind,
  ): Promise<void> => {
    progressDraft.markFinalReplyStarted();
    await cancelNativeUpdates();
    await withNativeStreamOrder(() => deliverNativeFinalNow(payload, kind));
  };

  const deliverNativeFinalNow = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    progressDraft.markFinalReplyStarted();
    const streamReady = await nativeTransport.waitForStart();
    const finalThreadTs = delivery.streamSession?.threadTs ?? delivery.nativeProgressStreamThreadTs;
    // Optional progress may still be buffered locally. Join its stream so
    // final delivery cannot leave a second message to be flushed by stop.
    const canFinishInStream =
      payload.isError !== true &&
      streamReady &&
      Boolean(delivery.streamSession) &&
      delivery.isStreamingEligible(payload, { maxTextBytes: SLACK_EDIT_TEXT_MAX_BYTES });
    if (canFinishInStream) {
      // Flush the terminal task row before buffering the answer so Slack
      // preserves narration -> plan -> final answer ordering.
      await appendNativeProgressCompletion(false);
      await delivery.deliverWithStreaming({ payload, kind });
    } else {
      await delivery.deliverNormally({ payload, kind, forcedThreadTs: finalThreadTs });
      await appendNativeProgressCompletion(payload.isError === true);
    }
    progressDraft.markFinalReplyDelivered();
  };

  const buildNativeProgressCompletionChunks = (finalInProgressStatus: "complete" | "error") => {
    const snapshot = progressDraft.getSnapshot();
    const lines = resolveNativeProgressLines(snapshot);
    const sessionUrl = progressCard.resolveSessionUrl();
    const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(snapshot));
    const hasRetirableNativeTasks = [...nativeStreamSnapshot.tasks.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (
      lines.length === 0 &&
      !snapshot.plan?.length &&
      !hasRetirableNativeTasks &&
      !narrationUpdate.delta &&
      !sessionUrl
    ) {
      return undefined;
    }
    const completion = reconcileSlackNativeTaskChunks({
      previous: nativeStreamSnapshot,
      chunks: buildSlackProgressStreamChunks({
        title:
          resolveNativeProgressTitle(snapshot) ??
          (lines.length === 0 && !snapshot.plan?.length ? "Working" : undefined),
        lines,
        plan: snapshot.plan,
        finalInProgressStatus,
        sessionUrl,
      }),
    }).chunks;
    // Terminal appends, silent closeout, and queued rotation share this
    // snapshot: authored text still in the batch must reach the SDK before stop.
    return narrationUpdate.delta
      ? [{ type: "markdown_text" as const, text: narrationUpdate.delta }, ...(completion ?? [])]
      : completion;
  };

  const finishNativeProgressTurn = async (
    completionChunks: ReturnType<typeof buildNativeProgressCompletionChunks>,
  ) => {
    if (delivery.nativeProgressStreamStartPromise) {
      await delivery.nativeProgressStreamStartPromise.catch(() => null);
    }
    if (completionChunks?.length) {
      nativeProgressCompletionSent = true;
    }
    await delivery.finishStream(completionChunks);
    delivery.streamSession = null;
    delivery.nativeProgressStreamStartPromise = null;
    delivery.nativeProgressStreamThreadTs = undefined;
    delivery.streamFailed = false;
  };

  const pushPlanProgress = async (steps?: AgentPlanStep[], explanation?: string) => {
    // A plan is tool progress, not a replacement for the model's latest preamble.
    if (!previewToolProgressEnabled) {
      return false;
    }
    if (isProgressMode) {
      if (slackProgressStyle === "compact") {
        return false;
      }
      return await progressDraft.pushPlanProgress(steps, { explanation });
    }
    if (previewToolProgressSuppressed || !draftStream) {
      return false;
    }
    const text = formatChannelProgressDraftText({
      entry: account.config,
      lines: [...progressDraft.getSnapshot().lines],
      seed: progressSeed,
      formatLine: formatSlackProgressDraftLine,
      narration: explanation,
      plan: steps,
    });
    if (text) {
      draftStream.update(text);
    }
    return false;
  };

  const pushPreviewProgress = async (
    line?: ChannelProgressDraftLine,
    options?: { toolName?: string },
  ) => {
    if (!draftStream && !useNativeProgressStreaming) {
      return false;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return false;
    }
    const normalized = line?.text.replace(/\s+/g, " ").trim();
    if (isProgressMode) {
      if (!line || !normalized) {
        return await progressDraft.noteActivity();
      }
      return await progressDraft.pushToolProgress(line, options);
    }
    if (!line || !normalized || !draftStream || !previewToolProgressEnabled) {
      return false;
    }
    return await progressDraft.pushToolProgress(line, options);
  };

  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text && sanitizeAssistantVisibleText(text).trimEnd();
    if (!trimmed) {
      return false;
    }

    if (slackStreaming.mode === "block") {
      previewToolProgressSuppressed = true;
      progressDraft.suppress();
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return false;
      }
      draftStream?.update(next.rendered);
      hasStreamedAnswer = true;
      return false;
    }

    if (isProgressMode) {
      return false;
    }

    previewToolProgressSuppressed = true;
    progressDraft.suppress();
    draftStream?.update(trimmed);
    hasStreamedAnswer = true;
    return false;
  };
  const pushReasoningProgress = async (payload?: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    if (!payload?.text) {
      return false;
    }
    if (!isProgressMode) {
      const normalized = progressDraft
        .mergeReasoningProgress(payload.text, {
          snapshot: payload.isReasoningSnapshot === true,
        })
        .replace(/^_(.*)_$/su, "$1")
        .trim();
      if (!normalized) {
        return false;
      }
      const visible = await pushPreviewProgress({
        id: "reasoning",
        kind: "item",
        text: normalized,
        label: "Reasoning",
      });
      // Tool admission closes reasoning bursts; restore this still-open preview lane.
      progressDraft.mergeReasoningProgress(normalized, { snapshot: true });
      return visible;
    }
    return await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const resetDraftDeliveryState = () => {
    hasStreamedAnswer = false;
    appendRenderedText = "";
    appendSourceText = "";
  };
  const resetDraftProgressState = () => {
    previewToolProgressSuppressed = false;
    progressDraft.reset();
  };
  const beginNewProgressTurn = async (options?: { force?: boolean }) => {
    if (useNativeProgressStreaming) {
      if (!nativeUpdatesStopped && options?.force !== true) {
        return false;
      }
      await cancelNativeUpdates();
    }
    const priorSnapshot = progressDraft.getSnapshot();
    const priorFallbackText = progressCard.resolveText(priorSnapshot);
    const completionChunks =
      useNativeProgressStreaming && !nativeProgressCompletionSent
        ? buildNativeProgressCompletionChunks(nativeProgressTerminalStatus)
        : undefined;
    if (!progressDraft.beginNewTurn(options)) {
      return false;
    }
    // Native messages are one-shot streams. Stop the prior turn before the
    // reset compositor can publish the queued turn's first snapshot.
    if (useNativeProgressStreaming) {
      await finishNativeProgressTurn(completionChunks);
    } else {
      await progressCard.finalize("success", priorSnapshot, priorFallbackText);
      draftStream?.forceNewMessage();
      await dropDetachedProgressCards();
    }
    resetProgressTurnState();
    nativeStreamSnapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
    nativeProgressCompletionSent = false;
    nativeProgressTerminalStatus = "complete";
    nativeUpdatesStopped = false;
    nativeUpdates.resetThrottleWindow();
    progressCard.reset();
    // A re-armed turn is a new visible reply: it must not dedupe against or
    // inherit delivery state from the settled turn (mirrors queued admission).
    resetPreviewDeliveryState();
    delivery.resetDeliveryTracker();
    return true;
  };
  const onDraftBoundary =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (isProgressMode) {
            await beginNewProgressTurn();
            return;
          }
          if (hasStreamedAnswer) {
            draftStream?.forceNewMessage();
          }
          resetDraftDeliveryState();
          resetDraftProgressState();
        };

  const onQueuedFollowupAdmitted =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          // A queued input is a new visible reply even though it drains through
          // this turn's callbacks. Do not let it edit or dedupe against this run.
          await draftStream?.flush();
          resetPreviewDeliveryState();
          if (isProgressMode) {
            await beginNewProgressTurn({ force: true });
          } else {
            draftStream?.forceNewMessage();
          }
          delivery.resetDeliveryTracker();
          resetDraftDeliveryState();
          resetDraftProgressState();
        };
  // A queued turn can drain after its dispatch returned, so dispatch closeout is
  // no longer available to settle the card it published. Leave none in Working.
  const onQueuedFollowupSettled =
    !useDraftProgressCard && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (useNativeProgressStreaming) {
            progressDraft.markFinalReplyStarted();
            await cancelNativeUpdates();
            await finishNativeProgressTurn(
              nativeProgressCompletionSent
                ? undefined
                : buildNativeProgressCompletionChunks(nativeProgressTerminalStatus),
            );
            progressDraft.markFinalReplyDelivered();
            return;
          }
          if (!progressCard.hasTerminalized) {
            await draftStream?.clear();
          }
          await dropDetachedProgressCards();
        };

  return {
    draftStream,
    isProgressMode,
    useDraftProgressCard,
    useNativeProgressStreaming,
    progressDraftActive,
    previewToolProgressEnabled,
    suppressDefaultToolProgressMessages,
    progressDraft,
    commentaryProgressEnabled,
    async cancel() {
      progressDraft.cancel();
      await cancelNativeUpdates();
    },
    get nativeProgressCompletionSent() {
      return nativeProgressCompletionSent;
    },
    set nativeProgressCompletionSent(value: boolean) {
      nativeProgressCompletionSent = value;
    },
    get nativeProgressTerminalStatus() {
      return nativeProgressTerminalStatus;
    },
    appendNativeNarration,
    buildNativeProgressCompletionChunks,
    deliverNativeFinal,
    dropDetachedProgressCards,
    finalizeDraftProgressCard: progressCard.finalize,
    onDraftBoundary,
    onQueuedFollowupAdmitted,
    onQueuedFollowupSettled,
    pushPlanProgress,
    pushReasoningProgress,
    updateDraftFromPartial,
    setShouldYieldDraftProgress: (value: () => boolean) => {
      shouldYieldDraftProgress = value;
    },
    shouldYieldDraftProgress: () => shouldYieldDraftProgress(),
  };
}
