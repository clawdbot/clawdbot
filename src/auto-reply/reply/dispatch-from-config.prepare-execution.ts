import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isFastModeAutoProgressPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import { type AgentPlanStep, formatPlanChecklistLines } from "../../channels/streaming.js";
import { getRuntimeConfigSnapshot } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { ChooseDispatchRouteReadyState } from "./dispatch-from-config.choose-route.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import { loadGetReplyFromConfigRuntime } from "./dispatch-from-config.runtime-loaders.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

export async function prepareDispatchExecution(state: ChooseDispatchRouteReadyState) {
  const {
    cfg,
    ctx,
    deliveryChannel,
    deliverySuppressionReason,
    dispatcher,
    getDispatchAbortOperation,
    getDispatchReplyOperation,
    hasAskUserPayload,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    noteCommentaryProgress,
    params,
    recordAgentDispatchStarted,
    replyRoute,
    routeReplyChannel,
    sendPayloadAsync,
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    sessionTtsAuto,
    shouldDeliverVerboseProgressDespiteSourceSuppression,
    shouldEmitFullVerboseProgress,
    shouldEmitVerboseProgress,
    shouldRouteToOriginating,
    shouldSendToolStartStatuses,
    shouldSendToolSummaries,
    shouldSendVerboseProgressMessages,
    sourceReplyPolicy,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    traceReplyPhase,
  } = state;
  // When automatic source delivery is suppressed, still let the agent process
  // the inbound message (context, memory, tool calls) but suppress automatic
  // outbound source delivery.
  if (suppressDelivery) {
    logVerbose(
      `Delivery suppressed by ${deliverySuppressionReason} for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"} — agent will still process the message`,
    );
  }

  const toolStartStatusesSent = new Set<string>();
  let toolStartStatusCount = 0;
  let didSendPlanStatusNotice = false;
  const normalizeWorkingLabel = (label: string) => {
    const collapsed = label.replace(/\s+/g, " ").trim();
    if (collapsed.length <= 80) {
      return collapsed;
    }
    return `${truncateUtf16Safe(collapsed, 77).trimEnd()}...`;
  };
  const formatPlanUpdateText = (payload: { explanation?: string; steps?: AgentPlanStep[] }) => {
    const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
    const steps = (payload.steps ?? [])
      .map((entry) => ({ step: entry.step.replace(/\s+/g, " ").trim(), status: entry.status }))
      .filter((entry) => entry.step);
    if (steps.length > 0) {
      return formatPlanChecklistLines(steps, {
        maxLines: steps.length,
        maxLineChars: 120,
      }).join("\n");
    }
    return explanation || "Planning next steps.";
  };
  const maybeSendWorkingStatus = async (label: string): Promise<void> => {
    if (shouldSuppressProgressDelivery()) {
      return;
    }
    const normalizedLabel = normalizeWorkingLabel(label);
    if (
      !shouldEmitVerboseProgress() ||
      !shouldSendToolStartStatuses ||
      !normalizedLabel ||
      toolStartStatusCount >= 2 ||
      toolStartStatusesSent.has(normalizedLabel)
    ) {
      return;
    }
    toolStartStatusesSent.add(normalizedLabel);
    toolStartStatusCount += 1;
    const payload: ReplyPayload = {
      text: `Working: ${normalizedLabel}`,
    };
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(payload, undefined, false);
      return;
    }
    markInboundDedupeReplayUnsafe();
    dispatcher.sendToolResult(payload);
  };
  const sendPlanUpdate = async (payload: {
    explanation?: string;
    steps?: AgentPlanStep[];
  }): Promise<void> => {
    if (
      shouldSuppressProgressDelivery() ||
      !shouldSendVerboseProgressMessages() ||
      didSendPlanStatusNotice
    ) {
      return;
    }
    didSendPlanStatusNotice = true;
    const replyPayload: ReplyPayload = {
      text: formatPlanUpdateText(payload),
      isStatusNotice: true,
    };
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(replyPayload, undefined, false);
      return;
    }
    markInboundDedupeReplayUnsafe();
    dispatcher.sendToolResult(replyPayload);
  };
  const summarizeApprovalLabel = (payload: {
    status?: string;
    command?: string;
    message?: string;
  }) => {
    if (payload.status === "pending") {
      const command = normalizeOptionalString(payload.command);
      if (command) {
        return normalizeWorkingLabel(`awaiting approval: ${command}`);
      }
      return "awaiting approval";
    }
    if (payload.status === "unavailable") {
      const message = normalizeOptionalString(payload.message);
      if (message) {
        return normalizeWorkingLabel(message);
      }
      return "approval unavailable";
    }
    return "";
  };
  const summarizePatchLabel = (payload: { summary?: string; title?: string }) => {
    const summary = normalizeOptionalString(payload.summary);
    if (summary) {
      return normalizeWorkingLabel(summary);
    }
    const title = normalizeOptionalString(payload.title);
    if (title) {
      return normalizeWorkingLabel(title);
    }
    return "";
  };
  // Track accumulated block text for TTS generation after streaming completes.
  // When block streaming succeeds, there's no final reply, so we need to generate
  // TTS audio separately from the accumulated block content.
  let accumulatedBlockText = "";
  let accumulatedBlockTtsText = "";
  let blockCount = 0;
  const cleanBlockTtsDirectiveText = shouldCleanTtsDirectiveText({
    cfg,
    ttsAuto: sessionTtsAuto,
    agentId: sessionAgentId,
    channelId: deliveryChannel,
    accountId: replyRoute.accountId,
  })
    ? createTtsDirectiveTextStreamCleaner()
    : undefined;

  const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
    if (
      shouldSuppressLocalExecApprovalPrompt({
        channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
        cfg,
        accountId: ctx.AccountId,
        payload,
      })
    ) {
      return null;
    }
    if (shouldSendToolSummaries()) {
      return payload;
    }
    const execApproval =
      payload.channelData &&
      typeof payload.channelData === "object" &&
      !Array.isArray(payload.channelData)
        ? payload.channelData.execApproval
        : undefined;
    if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
      return payload;
    }
    if (hasAskUserPayload(payload)) {
      return payload;
    }
    if (isFastModeAutoProgressPayload(payload)) {
      return payload;
    }
    // Group/native flows intentionally suppress tool summary text, but media-only
    // tool results (for example TTS audio) must still be delivered.
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (!hasMedia) {
      return null;
    }
    return { ...payload, text: undefined };
  };
  const typing = resolveRunTypingPolicy({
    requestedPolicy: params.replyOptions?.typingPolicy,
    suppressTyping: sourceReplyPolicy.suppressTyping,
    originatingChannel: routeReplyChannel,
    systemEvent: shouldRouteToOriginating,
  });
  const shouldSuppressProgressDelivery = () =>
    sendPolicyDenied ||
    (suppressDelivery && !shouldDeliverVerboseProgressDespiteSourceSuppression());
  const hasVisibleRegularVerboseToolProgress = () =>
    shouldEmitVerboseProgress() &&
    !shouldEmitFullVerboseProgress() &&
    shouldSendVerboseProgressMessages() &&
    ctx.InboundEventKind !== "room_event" &&
    !shouldSuppressProgressDelivery();
  let observedVisibleToolErrorProgress = false;
  const markVisibleToolErrorProgress = () => {
    if (hasVisibleRegularVerboseToolProgress()) {
      observedVisibleToolErrorProgress = true;
    }
  };
  const hasFailedProgressStatus = (payload: {
    phase?: string;
    status?: string;
    exitCode?: number | null;
  }) =>
    payload.phase === "error" ||
    payload.status === "failed" ||
    payload.status === "error" ||
    (typeof payload.exitCode === "number" && payload.exitCode !== 0);
  const shouldSuppressToolErrorWarnings = () => {
    if (params.replyOptions?.suppressToolErrorWarnings !== undefined) {
      return params.replyOptions.suppressToolErrorWarnings;
    }
    if (!shouldEmitVerboseProgress()) {
      return false;
    }
    return observedVisibleToolErrorProgress ? true : undefined;
  };
  const suppressToolErrorWarnings =
    params.replyOptions?.suppressToolErrorWarnings ??
    (observedVisibleToolErrorProgress ? true : undefined);
  const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
  const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
  const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
  const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
  const allowSuppressedSourceProgressCallbacks =
    params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed === true;
  const isChannelOwnedToolResultProgressPayload = (payload: ReplyPayload) => {
    const text = normalizeOptionalString(payload.text);
    return Boolean(text?.startsWith("🛠️") || text?.startsWith("🔧"));
  };
  const shouldForwardToolResultProgressCallback = (
    payload: ReplyPayload,
    isFastModeAutoProgress: boolean,
  ) => {
    if (isFastModeAutoProgress) {
      return shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true });
    }
    if (
      allowSuppressedSourceProgressCallbacks &&
      isChannelOwnedToolResultProgressPayload(payload)
    ) {
      return shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true });
    }
    return shouldSendToolSummaries() && shouldForwardProgressCallback();
  };
  const shouldAllowQuietChannelOwnedProgressCallbacks = (options?: {
    allowWhenToolSummariesHidden?: boolean;
    requiresToolSummaryVisibility?: boolean;
  }) =>
    options?.requiresToolSummaryVisibility === true &&
    (params.replyOptions?.suppressDefaultToolProgressMessages === true ||
      options.allowWhenToolSummariesHidden === true);
  let hasPendingDirectBlockReplyDelivery = false;
  const waitForPendingDirectBlockReplyDelivery = async (abortSignal?: AbortSignal) => {
    if (!hasPendingDirectBlockReplyDelivery) {
      return;
    }
    // Direct block replies are queued asynchronously so lightweight replies do
    // not wait for dispatcher idle. Flush only before later tool/progress
    // callbacks and final completion where external ordering is visible.
    hasPendingDirectBlockReplyDelivery = false;
    await waitForReplyDispatcherIdle(dispatcher, abortSignal);
  };
  const shouldForwardProgressCallback = (options?: {
    allowWhenToolSummariesHidden?: boolean;
    forwardWhenSourceDeliverySuppressed?: boolean;
    requiresToolSummaryVisibility?: boolean;
  }) => {
    if (
      options?.requiresToolSummaryVisibility === true &&
      !shouldSendToolSummaries() &&
      !shouldAllowQuietChannelOwnedProgressCallbacks(options)
    ) {
      return false;
    }
    return (
      !suppressAutomaticSourceDelivery ||
      (allowSuppressedSourceProgressCallbacks &&
        !sendPolicyDenied &&
        options?.forwardWhenSourceDeliverySuppressed === true)
    );
  };
  const preserveProgressCallbackStartOrder =
    params.replyOptions?.preserveProgressCallbackStartOrder === true;
  let progressCallbackStartTail = Promise.resolve();
  const reserveProgressCallbackStart = () => {
    const previousStart = progressCallbackStartTail;
    let releaseStart: (() => void) | undefined;
    progressCallbackStartTail = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    return {
      previousStart,
      releaseStart: () => releaseStart?.(),
    };
  };
  const wrapProgressCallback = <Args extends unknown[], Result extends false | void>(
    callback: ((...args: Args) => Promise<Result> | Result) | undefined,
    options?: {
      allowWhenToolSummariesHidden?: boolean;
      forwardWhenSourceDeliverySuppressed?: boolean;
      requiresToolSummaryVisibility?: boolean;
      onForward?: (...args: Args) => Promise<void> | void;
      onVisible?: (...args: Args) => Promise<void> | void;
      waitForDirectBlockReplyDelivery?: boolean;
    },
  ): ((...args: Args) => Promise<Result | undefined>) | undefined => {
    if (!callback) {
      return undefined;
    }
    const runProgressCallback = async (
      args: Args,
      noteCallbackStarted: () => void,
    ): Promise<Result | undefined> => {
      try {
        if (isDispatchOperationAborted()) {
          return undefined;
        }
        getDispatchReplyOperation()?.recordActivity();
        markProgress();
        if (options?.waitForDirectBlockReplyDelivery) {
          await waitForPendingDirectBlockReplyDelivery(getDispatchAbortOperation()?.abortSignal);
          if (isDispatchOperationAborted()) {
            return undefined;
          }
        }
        if (shouldForwardProgressCallback(options)) {
          if (preserveProgressCallbackStartOrder && options?.onForward) {
            await options.onForward(...args);
          } else if (!preserveProgressCallbackStartOrder) {
            // Preserve the historical microtask boundary for unflagged channels.
            await options?.onForward?.(...args);
          }
          const callbackResult = callback(...args);
          noteCallbackStarted();
          const result = await callbackResult;
          if (result === false) {
            return result;
          }
          await options?.onVisible?.(...args);
        }
        return undefined;
      } finally {
        noteCallbackStarted();
      }
    };
    return (...args: Args) => {
      if (!preserveProgressCallbackStartOrder) {
        return runProgressCallback(args, () => undefined);
      }
      // Reserve source order synchronously. Release after callback invocation, not completion,
      // so async presentation work stays concurrent without letting later activity overtake it.
      const start = reserveProgressCallbackStart();
      return (async () => {
        await start.previousStart;
        return await runProgressCallback(args, start.releaseStart);
      })();
    };
  };

  // Snapshot verbose progress visibility for this run: commentary
  // classification in the CLI runners is wired once at run start, so a
  // mid-run verbose toggle cannot move inter-tool commentary between lanes.
  const deliverStandaloneCommentaryProgress = shouldEmitVerboseProgress();
  const itemEventForwardingOptions = {
    forwardWhenSourceDeliverySuppressed: true,
    requiresToolSummaryVisibility: true,
  } as const;
  const canForwardItemEvents =
    Boolean(params.replyOptions?.onItemEvent) &&
    shouldForwardProgressCallback(itemEventForwardingOptions);
  const canForwardSuppressedSourceItemEvents =
    suppressAutomaticSourceDelivery &&
    allowSuppressedSourceProgressCallbacks &&
    canForwardItemEvents;
  const forwardItemEvent = canForwardItemEvents
    ? wrapProgressCallback(params.replyOptions?.onItemEvent, {
        ...itemEventForwardingOptions,
        waitForDirectBlockReplyDelivery: true,
        onForward: (payload) =>
          preserveProgressCallbackStartOrder &&
          deliverStandaloneCommentaryProgress &&
          payload.kind === "preamble"
            ? noteCommentaryProgress(payload)
            : undefined,
        onVisible: (payload) => {
          if (hasFailedProgressStatus(payload)) {
            markVisibleToolErrorProgress();
          }
        },
      })
    : undefined;
  const canConsumeItemEvents = deliverStandaloneCommentaryProgress || canForwardItemEvents;
  // Item-event presence gates CLI commentary classification downstream, so
  // the handler exists exactly when verbose buffers it or a channel consumes it.
  const onItemEvent = canConsumeItemEvents
    ? async (payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0]) => {
        if (isDispatchOperationAborted()) {
          return;
        }
        if (!forwardItemEvent) {
          // The wrapped forwarder marks progress itself when present.
          markProgress();
        }
        if (
          (!forwardItemEvent || !preserveProgressCallbackStartOrder) &&
          deliverStandaloneCommentaryProgress &&
          payload.kind === "preamble"
        ) {
          await noteCommentaryProgress(payload);
        }
        return await forwardItemEvent?.(payload);
      }
    : undefined;
  // Let draft-rendering channels yield their ephemeral commentary lines while
  // the durable verbose commentary lane is delivering the same content.
  params.replyOptions?.onVerboseProgressVisibility?.(
    () =>
      deliverStandaloneCommentaryProgress &&
      shouldSendVerboseProgressMessages() &&
      !shouldSuppressProgressDelivery(),
  );

  const replyResolver =
    params.replyResolver ??
    (await traceReplyPhase("reply.load_reply_resolver", () => loadGetReplyFromConfigRuntime()))
      .getReplyFromConfig;
  // Channel runtimes can outlive a config reload. Resolve one live snapshot
  // per turn so reply setup and dispatch callbacks share the same authority.
  const runtimeReplyConfig = getRuntimeConfigSnapshot() ?? cfg;
  const replyConfig = withFullRuntimeReplyConfig(
    params.configOverride
      ? (applyMergePatch(runtimeReplyConfig, params.configOverride) as OpenClawConfig)
      : runtimeReplyConfig,
  );
  recordAgentDispatchStarted();
  const nextState = extendPreparedDispatchState(
    state,
    {
      maybeSendWorkingStatus,
      sendPlanUpdate,
      summarizeApprovalLabel,
      summarizePatchLabel,
      cleanBlockTtsDirectiveText,
      resolveToolDeliveryPayload,
      typing,
      shouldSuppressProgressDelivery,
      markVisibleToolErrorProgress,
      hasFailedProgressStatus,
      shouldSuppressToolErrorWarnings,
      suppressToolErrorWarnings,
      onToolResultFromReplyOptions,
      onPlanUpdateFromReplyOptions,
      onApprovalEventFromReplyOptions,
      onPatchSummaryFromReplyOptions,
      shouldForwardToolResultProgressCallback,
      waitForPendingDirectBlockReplyDelivery,
      shouldForwardProgressCallback,
      preserveProgressCallbackStartOrder,
      wrapProgressCallback,
      deliverStandaloneCommentaryProgress,
      canForwardSuppressedSourceItemEvents,
      onItemEvent,
      replyResolver,
      replyConfig,
    },
    {
      accumulatedBlockText: {
        get: () => accumulatedBlockText,
        set: (value: string) => {
          accumulatedBlockText = value;
        },
      },
      accumulatedBlockTtsText: {
        get: () => accumulatedBlockTtsText,
        set: (value: string) => {
          accumulatedBlockTtsText = value;
        },
      },
      blockCount: {
        get: () => blockCount,
        set: (value: number) => {
          blockCount = value;
        },
      },
      hasPendingDirectBlockReplyDelivery: {
        get: () => hasPendingDirectBlockReplyDelivery,
        set: (value: boolean) => {
          hasPendingDirectBlockReplyDelivery = value;
        },
      },
      progressCallbackStartTail: {
        get: () => progressCallbackStartTail,
        set: (value: typeof progressCallbackStartTail) => {
          progressCallbackStartTail = value;
        },
      },
    },
  );
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchExecutionResult = Awaited<ReturnType<typeof prepareDispatchExecution>>;
export type PrepareDispatchExecutionReadyState = Extract<
  PrepareDispatchExecutionResult,
  { status: "ready" }
>["state"];
