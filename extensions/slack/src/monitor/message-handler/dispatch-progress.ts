import type { AgentPlanStep } from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftCompositor,
  createChannelProgressReceiptTracker,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import {
  buildSlackProgressStreamCompletionChunks,
  buildSlackProgressStreamStartChunks,
  buildSlackProgressStreamUpdateChunks,
  reconcileSlackNativeTaskChunks,
  type SlackNativeTaskSnapshot,
} from "../../progress-blocks.js";
import { applyAppendOnlyStreamUpdate } from "../../stream-mode.js";
import {
  appendSlackStream,
  startSlackStream,
  stopSlackStream,
  type SlackStreamSession,
} from "../../streaming.js";
import {
  resolveExplicitSlackProgressTitle,
  resolveSlackStreamRecipientTeamId,
} from "./dispatch-helpers.js";
import {
  createSlackDraftProgressCardRuntime,
  formatSlackProgressDraftLine,
} from "./dispatch-progress-card.js";
import { collapseSlackProgressReceipt } from "./dispatch-progress-io.js";
import {
  buildNativeProgressChunks as buildRenderedNativeProgressChunks,
  combineProgressHeadlineAndExplanation,
  resolveNativeProgressLines,
  resolveNativeProgressPlan,
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
    slackStreamFallbackTeamId,
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
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
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
  // Last task rows emitted to the native stream; reconciliation terminalizes
  // ids that drop out (plan shrinks, tool-line <-> plan source switches).
  let nativeTaskState: SlackNativeTaskSnapshot = new Map();
  let appendRenderedText = "";
  let appendSourceText = "";
  let nativeProgressCompletionSent = false;
  // Terminal status of the turn's final payload; completion retries and
  // queued rotation must not repaint an errored turn as complete.
  let nativeProgressTerminalStatus: "complete" | "error" = "complete";
  let nativeProgressChunkKey: string | undefined;
  const progressReceipt = createChannelProgressReceiptTracker();
  let progressReceiptCollapsed = false;
  let pendingNativeProgressReceipt: string | undefined;
  const progressSeed = `${account.accountId}:${message.channel}`;
  const useDraftProgressCard = Boolean(draftStream) && streamMode === "status_final";
  const explicitProgressTitle = resolveExplicitSlackProgressTitle(account.config);
  const progressDraftMaxLineChars = resolveChannelProgressDraftMaxLineChars(account.config);
  const progressCard = createSlackDraftProgressCardRuntime({
    setup: { account, cfg, ctx, prepared, slackClient },
    draftStream,
    enabled: useDraftProgressCard,
    progressReceipt,
    progressSeed,
    explicitTitle: explicitProgressTitle,
    maxLineChars: progressDraftMaxLineChars,
    getSnapshot: () => progressDraft.getSnapshot(),
    getThreadTs: () => delivery.usedReplyThreadTs,
  });
  // Card-only cleanup. Other draft modes abandon a preview holding streamed
  // assistant text the human already replied to; that message stays visible.
  const dropDetachedProgressCards = async () => {
    if (!useDraftProgressCard) {
      return;
    }
    await draftStream?.dropDetachedMessages();
  };

  const waitForNativeProgressStreamStart = async (): Promise<boolean> => {
    if (delivery.streamSession || !delivery.nativeProgressStreamStartPromise) {
      return true;
    }
    try {
      await delivery.nativeProgressStreamStartPromise;
    } catch {
      delivery.streamFailed = true;
      return false;
    }
    return !delivery.streamFailed;
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
    if (!chunks?.length) {
      return;
    }
    try {
      await appendSlackStream({ session, chunks });
      nativeProgressCompletionSent = true;
      delivery.observedReplyDelivery ||= session.delivered;
    } catch (err) {
      delivery.streamFailed = true;
      runtime.error?.(
        danger(`slack-stream: native progress completion failed: ${formatSlackError(err)}`),
      );
    }
  };

  const buildNativeProgressChunks = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    buildRenderedNativeProgressChunks({
      snapshot,
      streamStarted: Boolean(delivery.streamSession),
      title: combineProgressHeadlineAndExplanation(
        explicitProgressTitle ?? snapshot.statusHeadline,
        snapshot.planExplanation,
      ),
      maxLineChars: progressDraftMaxLineChars,
    });

  const resolveNativeProgressTitle = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    combineProgressHeadlineAndExplanation(
      explicitProgressTitle ?? snapshot.statusHeadline,
      snapshot.planExplanation,
    );

  const markNativeProgressDelivered = (session: SlackStreamSession, threadTs?: string) => {
    if (!session.delivered) {
      return false;
    }
    delivery.observedReplyDelivery = true;
    if (threadTs) {
      delivery.usedReplyThreadTs ??= threadTs;
      delivery.rememberDeliveredThreadTs("block", threadTs);
    }
    return true;
  };

  const startNativeProgressStream = async (
    chunks: NonNullable<ReturnType<typeof buildSlackProgressStreamStartChunks>>,
  ): Promise<boolean> => {
    const streamThreadTs = replyPlan.nextThreadTs();
    if (!streamThreadTs) {
      logVerbose(
        "slack-stream: no reply thread target for native progress stream start, falling back",
      );
      delivery.streamFailed = true;
      return false;
    }
    delivery.nativeProgressStreamThreadTs = streamThreadTs;
    const startPromise = (async () => {
      const session = await startSlackStream({
        client: slackClient,
        channel: message.channel,
        threadTs: streamThreadTs,
        chunks,
        taskDisplayMode: "plan",
        ...(slackIdentity ? { identity: slackIdentity } : {}),
        teamId: await resolveSlackStreamRecipientTeamId({
          client: slackClient,
          token: ctx.botToken,
          userId: message.user,
          fallbackTeamId: slackStreamFallbackTeamId,
        }),
        userId: message.user,
      });
      delivery.streamSession = session;
      return session;
    })();
    delivery.nativeProgressStreamStartPromise = startPromise;
    let startedSession: SlackStreamSession | null;
    try {
      startedSession = await startPromise;
    } finally {
      if (delivery.nativeProgressStreamStartPromise === startPromise) {
        delivery.nativeProgressStreamStartPromise = null;
      }
    }
    return startedSession ? markNativeProgressDelivered(startedSession, streamThreadTs) : false;
  };

  const appendNativeProgressStream = async (
    chunks: NonNullable<ReturnType<typeof buildSlackProgressStreamUpdateChunks>>,
  ): Promise<boolean> => {
    if (!delivery.streamSession) {
      return false;
    }
    await appendSlackStream({ session: delivery.streamSession, chunks });
    return markNativeProgressDelivered(
      delivery.streamSession,
      delivery.nativeProgressStreamThreadTs,
    );
  };

  const updateNativeProgressStream = async (): Promise<boolean> => {
    const snapshot = progressDraft.getSnapshot();
    const progressLines = resolveNativeProgressLines(snapshot);
    const hasRetirableNativeTasks = [...nativeTaskState.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (
      !useNativeProgressStreaming ||
      delivery.streamFailed ||
      (progressLines.length === 0 &&
        !snapshot.plan?.length &&
        !snapshot.statusHeadline &&
        !explicitProgressTitle &&
        !hasRetirableNativeTasks)
    ) {
      return false;
    }
    const canContinue = await waitForNativeProgressStreamStart();
    if (!canContinue) {
      return false;
    }
    const reconciled = reconcileSlackNativeTaskChunks({
      previousTasks: nativeTaskState,
      chunks: buildNativeProgressChunks(snapshot),
    });
    const chunks = reconciled.chunks;
    if (!chunks?.length) {
      return false;
    }
    const chunkKey = JSON.stringify(chunks);
    if (chunkKey === nativeProgressChunkKey) {
      return Boolean(delivery.streamSession?.delivered);
    }
    try {
      const accepted = !delivery.streamSession
        ? await startNativeProgressStream(chunks)
        : await appendNativeProgressStream(chunks);
      if (!accepted) {
        return false;
      }
      // Commit transport identity and task state together. Buffered or failed
      // chunks must leave the identical render eligible for another attempt.
      if (nativeProgressChunkKey === undefined) {
        replyPlan.markSent();
      }
      nativeProgressChunkKey = chunkKey;
      nativeTaskState = reconciled.tasks;
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

  const resetProgressTurnState = () => {
    progressReceipt.reset();
    progressReceiptCollapsed = false;
    pendingNativeProgressReceipt = undefined;
  };

  const collapseProgressReceipt = async (
    params: Parameters<typeof collapseSlackProgressReceipt>[0]["edit"],
  ) => {
    progressReceiptCollapsed = await collapseSlackProgressReceipt({ setup, edit: params });
  };

  const progressDraft = createChannelProgressDraftCompositor({
    entry: account.config,
    mode: slackStreaming.mode,
    active: progressDraftActive,
    seed: progressSeed,
    formatLine: formatSlackProgressDraftLine,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "",
    reasoningGate: previewToolProgressEnabled,
    commentaryItalics: true,
    buildProgressEventLine: (input, options) =>
      input.event === "tool" || input.event === "item" || input.event === "command-output"
        ? buildChannelProgressDraftLineForEntry(account.config, input, options)
        : buildChannelProgressDraftLine(input, options),
    updateOnLineChange: useNativeProgressStreaming || useDraftProgressCard,
    update: async (previewText, options) => {
      if (useNativeProgressStreaming) {
        return await updateNativeProgressStream();
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
      hasStreamedMessage = true;
      if (options?.flush) {
        await draftStream.flush();
      }
      return Boolean(draftStream.messageId() && draftStream.channelId());
    },
  });
  const commentaryProgressEnabled = progressDraft.commentaryProgressEnabled;

  const buildNativeProgressCompletionChunks = (finalInProgressStatus: "complete" | "error") => {
    const snapshot = progressDraft.getSnapshot();
    const lines = resolveNativeProgressLines(snapshot);
    const hasRetirableNativeTasks = [...nativeTaskState.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (lines.length === 0 && !snapshot.plan?.length && !hasRetirableNativeTasks) {
      return undefined;
    }
    return reconcileSlackNativeTaskChunks({
      previousTasks: nativeTaskState,
      chunks: buildSlackProgressStreamCompletionChunks({
        title: resolveNativeProgressTitle(snapshot),
        lines,
        plan: resolveNativeProgressPlan(snapshot),
        maxLineChars: progressDraftMaxLineChars,
        finalInProgressStatus,
      }),
    }).chunks;
  };

  const finishNativeProgressTurn = async (
    completionChunks: ReturnType<typeof buildNativeProgressCompletionChunks>,
  ) => {
    if (delivery.nativeProgressStreamStartPromise) {
      await delivery.nativeProgressStreamStartPromise.catch(() => null);
    }
    const session = delivery.streamSession;
    if (session && !session.stopped) {
      try {
        if (completionChunks?.length) {
          nativeProgressCompletionSent = true;
        }
        const stopResult = await stopSlackStream({
          session,
          ...(completionChunks?.length ? { chunks: completionChunks } : {}),
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
        delivery.acknowledgeStoppedStreamedDeliveries(session, stopResult?.messageId);
        if (pendingNativeProgressReceipt && stopResult?.messageId) {
          await collapseProgressReceipt({
            channelId: session.channel,
            messageId: stopResult.messageId,
            text: pendingNativeProgressReceipt,
            threadTs: session.threadTs,
          });
        }
      } catch (err) {
        const error = formatSlackError(err);
        // stopSlackStream makes the one-shot session terminal before throwing.
        // Settle delivery bookkeeping before releasing that handle.
        delivery.emitAcknowledgedStreamedDeliveries();
        delivery.emitFailedPendingStreamedDeliveries(error);
        logVerbose(`slack-stream: failed to rotate native progress stream (${error})`);
      }
    }
    delivery.streamSession = null;
    delivery.nativeProgressStreamStartPromise = null;
    delivery.nativeProgressStreamThreadTs = undefined;
    delivery.streamFailed = false;
  };

  const pushPlanProgress = async (steps?: AgentPlanStep[], explanation?: string) => {
    if (streamMode === "status_final") {
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
      hasStreamedMessage = true;
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
    if (streamMode === "status_final") {
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
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return false;
    }

    if (streamMode === "append") {
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
      hasStreamedMessage = true;
      return false;
    }

    if (streamMode === "status_final") {
      return false;
    }

    previewToolProgressSuppressed = true;
    progressDraft.suppress();
    draftStream?.update(trimmed);
    hasStreamedMessage = true;
    return false;
  };
  const pushReasoningProgress = async (payload?: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    if (!payload?.text) {
      return false;
    }
    if (streamMode !== "status_final") {
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
    progressReceipt.noteReasoning();
    return await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const resetDraftDeliveryState = () => {
    hasStreamedMessage = false;
    appendRenderedText = "";
    appendSourceText = "";
  };
  const resetDraftProgressState = () => {
    previewToolProgressSuppressed = false;
    progressDraft.reset();
  };
  const beginNewProgressTurn = async (options?: { force?: boolean }) => {
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
    nativeTaskState = new Map();
    nativeProgressCompletionSent = false;
    nativeProgressTerminalStatus = "complete";
    nativeProgressChunkKey = undefined;
    progressCard.reset();
    // A re-armed turn is a new visible reply: it must not dedupe against or
    // inherit delivery state from the settled turn (mirrors queued admission).
    resetPreviewDeliveryState();
    delivery.resetDeliveryTracker();
    progressReceiptCollapsed = false;
    return true;
  };
  const onDraftBoundary =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (streamMode === "status_final") {
            await beginNewProgressTurn();
            return;
          }
          if (hasStreamedMessage) {
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
          if (streamMode === "status_final") {
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
  const onQueuedFollowupSettled = !useDraftProgressCard
    ? undefined
    : async () => {
        if (!progressCard.hasTerminalized) {
          await draftStream?.clear();
        }
        await dropDetachedProgressCards();
      };

  return {
    draftStream,
    streamMode,
    useDraftProgressCard,
    useNativeProgressStreaming,
    progressDraftActive,
    previewToolProgressEnabled,
    suppressDefaultToolProgressMessages,
    progressDraft,
    commentaryProgressEnabled,
    progressReceipt,
    get progressReceiptCollapsed() {
      return progressReceiptCollapsed;
    },
    get pendingNativeProgressReceipt() {
      return pendingNativeProgressReceipt;
    },
    set pendingNativeProgressReceipt(value: string | undefined) {
      pendingNativeProgressReceipt = value;
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
    appendNativeProgressCompletion,
    beginNewProgressTurn,
    buildNativeProgressCompletionChunks,
    collapseProgressReceipt,
    dropDetachedProgressCards,
    finalizeDraftProgressCard: progressCard.finalize,
    onDraftBoundary,
    onQueuedFollowupAdmitted,
    onQueuedFollowupSettled,
    pushPlanProgress,
    pushPreviewProgress,
    pushReasoningProgress,
    updateDraftFromPartial,
    waitForNativeProgressStreamStart,
    setShouldYieldDraftProgress: (value: () => boolean) => {
      shouldYieldDraftProgress = value;
    },
    shouldYieldDraftProgress: () => shouldYieldDraftProgress(),
  };
}
