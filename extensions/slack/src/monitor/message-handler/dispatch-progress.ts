import type { AgentPlanStep } from "openclaw/plugin-sdk/channel-outbound";
import {
  createChannelProgressDraftCompositor,
  createChannelProgressReceiptTracker,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  resolveChannelProgressDraftMaxLines,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftRender,
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
  buildSlackProgressDraftBlocks,
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
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import {
  resolveExplicitSlackProgressTitle,
  resolveSlackStreamRecipientTeamId,
} from "./dispatch-helpers.js";
import { collapseSlackProgressReceipt } from "./dispatch-progress-io.js";
import {
  buildNativeProgressChunks as buildRenderedNativeProgressChunks,
  combineProgressHeadlineAndExplanation,
  resolveNativeProgressLines,
  resolveNativeProgressPlan,
  resolveStructuredProgressLines,
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
        ...(prepared.eventScope ? { eventScope: prepared.eventScope } : {}),
        identity: slackIdentity,
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
    progressDraftActive && resolveChannelStreamingPreviewToolProgress(account.config);
  let shouldYieldDraftProgress: () => boolean = () => false;
  const suppressDefaultToolProgressMessages =
    resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
      draftStreamActive: Boolean(draftStream) || useNativeProgressStreaming,
      previewToolProgressEnabled,
      previewStreamingEnabled,
    });
  let previewToolProgressSuppressed = false;
  let legacyPreviewToolProgressLines: ChannelProgressDraftLine[] = [];
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
  const useRichProgressDraft =
    streamMode === "status_final" && resolveChannelProgressDraftRender(account.config) === "rich";
  const explicitProgressTitle = resolveExplicitSlackProgressTitle(account.config);
  const progressDraftMaxLineChars = resolveChannelProgressDraftMaxLineChars(account.config);

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
    if (session.delivered) {
      delivery.observedReplyDelivery = true;
    }
    if (threadTs) {
      delivery.usedReplyThreadTs ??= threadTs;
      delivery.rememberDeliveredThreadTs("block", threadTs);
    }
  };

  const startNativeProgressStream = async (
    chunks: NonNullable<ReturnType<typeof buildSlackProgressStreamStartChunks>>,
    chunkKey: string,
  ) => {
    const streamThreadTs = replyPlan.nextThreadTs();
    if (!streamThreadTs) {
      logVerbose(
        "slack-stream: no reply thread target for native progress stream start, falling back",
      );
      delivery.streamFailed = true;
      return;
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
    if (startedSession) {
      markNativeProgressDelivered(startedSession, streamThreadTs);
    }
    nativeProgressChunkKey = chunkKey;
    replyPlan.markSent();
  };

  const appendNativeProgressStream = async (
    chunks: NonNullable<ReturnType<typeof buildSlackProgressStreamUpdateChunks>>,
    chunkKey: string,
  ) => {
    if (!delivery.streamSession) {
      return;
    }
    await appendSlackStream({ session: delivery.streamSession, chunks });
    markNativeProgressDelivered(delivery.streamSession);
    nativeProgressChunkKey = chunkKey;
  };

  const updateNativeProgressStream = async () => {
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
      return;
    }
    const canContinue = await waitForNativeProgressStreamStart();
    if (!canContinue) {
      return;
    }
    const reconciled = reconcileSlackNativeTaskChunks({
      previousTasks: nativeTaskState,
      chunks: buildNativeProgressChunks(snapshot),
    });
    const chunks = reconciled.chunks;
    if (!chunks?.length) {
      return;
    }
    const chunkKey = JSON.stringify(chunks);
    if (chunkKey === nativeProgressChunkKey) {
      return;
    }
    try {
      if (!delivery.streamSession) {
        await startNativeProgressStream(chunks, chunkKey);
      } else {
        await appendNativeProgressStream(chunks, chunkKey);
      }
      // Commit only after Slack accepted the chunks; a failed emit must retry
      // the same reconciliation against the previous snapshot.
      nativeTaskState = reconciled.tasks;
    } catch (err) {
      runtime.error?.(
        danger(
          `slack-stream: native progress stream failed: ${formatSlackError(err)}, falling back`,
        ),
      );
      delivery.streamFailed = true;
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
    active: progressDraftActive && streamMode === "status_final",
    seed: progressSeed,
    formatLine: escapeSlackMrkdwn,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    reasoningGate: previewToolProgressEnabled,
    commentaryItalics: false,
    updateOnLineChange: useNativeProgressStreaming || useRichProgressDraft,
    update: async (previewText, options) => {
      if (useNativeProgressStreaming) {
        await updateNativeProgressStream();
        return;
      }
      if (!draftStream) {
        return;
      }
      const snapshot = progressDraft.getSnapshot();
      const structuredLines = resolveStructuredProgressLines(options?.lines ?? snapshot.lines);
      const richNarration = combineProgressHeadlineAndExplanation(
        snapshot.statusHeadline,
        snapshot.planExplanation,
      );
      const richProgressBlocks = useRichProgressDraft
        ? buildSlackProgressDraftBlocks({
            title: explicitProgressTitle,
            lines: structuredLines,
            plan: snapshot.plan,
            narration: richNarration,
            maxLineChars: progressDraftMaxLineChars,
          })
        : undefined;
      draftStream.update(
        useRichProgressDraft && richProgressBlocks
          ? { text: previewText, blocks: richProgressBlocks }
          : previewText,
      );
      hasStreamedMessage = true;
      if (options?.flush) {
        await draftStream.flush();
      }
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
      await progressDraft.pushPlanProgress(steps, { explanation });
      return;
    }
    if (previewToolProgressSuppressed || !draftStream) {
      return;
    }
    const text = formatChannelProgressDraftText({
      entry: account.config,
      lines: legacyPreviewToolProgressLines,
      seed: progressSeed,
      formatLine: escapeSlackMrkdwn,
      narration: explanation,
      plan: steps,
    });
    if (text) {
      draftStream.update(text);
      hasStreamedMessage = true;
    }
  };

  const pushPreviewProgress = async (
    line?: ChannelProgressDraftLine,
    options?: { toolName?: string },
  ) => {
    if (!draftStream && !useNativeProgressStreaming) {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const normalized = line?.text.replace(/\s+/g, " ").trim();
    if (streamMode === "status_final") {
      if (!line || !normalized) {
        await progressDraft.noteActivity();
        return;
      }
      await progressDraft.pushToolProgress(line, options);
      return;
    }
    if (
      !line ||
      !normalized ||
      !draftStream ||
      !previewToolProgressEnabled ||
      previewToolProgressSuppressed
    ) {
      return;
    }
    const nextLines = mergeChannelProgressDraftLine(legacyPreviewToolProgressLines, line, {
      maxLines: resolveChannelProgressDraftMaxLines(account.config),
    });
    if (nextLines === legacyPreviewToolProgressLines) {
      return;
    }
    legacyPreviewToolProgressLines = nextLines;
    draftStream.update(
      formatChannelProgressDraftText({
        entry: account.config,
        lines: legacyPreviewToolProgressLines,
        seed: progressSeed,
        formatLine: escapeSlackMrkdwn,
      }),
    );
    hasStreamedMessage = true;
  };

  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    if (streamMode === "append") {
      previewToolProgressSuppressed = true;
      legacyPreviewToolProgressLines = [];
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return;
      }
      draftStream?.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }

    if (streamMode === "status_final") {
      return;
    }

    previewToolProgressSuppressed = true;
    legacyPreviewToolProgressLines = [];
    draftStream?.update(trimmed);
    hasStreamedMessage = true;
  };
  const pushReasoningProgress = async (payload?: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    if (!payload?.text) {
      return;
    }
    if (streamMode !== "status_final") {
      const normalized = progressDraft
        .mergeReasoningProgress(payload.text, {
          snapshot: payload.isReasoningSnapshot === true,
        })
        .replace(/^_(.*)_$/su, "$1")
        .trim();
      if (!normalized) {
        return;
      }
      await pushPreviewProgress({
        id: "reasoning",
        kind: "item",
        text: normalized,
        label: "Reasoning",
      });
      return;
    }
    progressReceipt.noteReasoning();
    await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const resetDraftDeliveryState = () => {
    hasStreamedMessage = false;
    appendRenderedText = "";
    appendSourceText = "";
  };
  const resetDraftProgressState = () => {
    progressDraft.resetReasoningProgress();
    previewToolProgressSuppressed = false;
    legacyPreviewToolProgressLines = [];
  };
  const beginNewProgressTurn = async (options?: { force?: boolean }) => {
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
      draftStream?.forceNewMessage();
    }
    resetProgressTurnState();
    nativeTaskState = new Map();
    nativeProgressCompletionSent = false;
    nativeProgressTerminalStatus = "complete";
    nativeProgressChunkKey = undefined;
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

  return {
    draftStream,
    streamMode,
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
    onDraftBoundary,
    onQueuedFollowupAdmitted,
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
