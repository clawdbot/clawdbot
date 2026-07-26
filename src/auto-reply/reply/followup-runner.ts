/** Runs queued follow-up agent turns and routes their delivery payloads. */
import crypto from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalAgentRuntimeId } from "../../agents/agent-runtime-id.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  markAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import {
  hasCompletedSourceReplyDeliveryEvidence,
  hasCompletedTerminalDeliveryEvidence,
  hasCommittedSourceReplyDeliveryEvidence,
  hasVisibleOutboundDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { hasDeliberateSilentTerminalReply } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { isFallbackSummaryError } from "../../agents/model-fallback.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import {
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { buildAgentRuntimeDeliveryPlan } from "../../agents/runtime-plan/build.js";
import { withLocalSessionPlacementTurnAdmission } from "../../agents/session-placement-admission.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import {
  captureAgentRunLifecycleGeneration,
  clearAgentRunContext,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createAgentLifecycleTerminalBackstop,
  type AgentLifecycleTerminalBackstop,
} from "./agent-lifecycle-terminal.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import {
  clearDroppedCliSessionBinding,
  createCliReasoningStreamBridge,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildPreflightCompactionFailureText,
  buildTerminalAgentRunFailureReplyPayload,
} from "./agent-runner-failure-reply.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
  resolveRunAuthProfile,
} from "./agent-runner-utils.js";
import {
  createCompactionHookNoticePayload,
  createCompactionNoticePayload,
  readCompactionHookMessages,
  shouldNotifyUserAboutCompaction,
  type CompactionNoticePhase,
} from "./compaction-notice.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";
import { type InternalGetReplyOptions, shouldBridgeCliPreambleEvents } from "./get-reply.types.js";
import { refreshActiveGoalContext } from "./inbound-meta.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery.js";
import {
  shouldWarnAboutPrivateMessageToolFinal,
  warnPrivateMessageToolFinal,
} from "./private-message-tool-final.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  isFollowupRunAborted,
  refreshQueuedFollowupSession,
  resolveFollowupAbortSignal,
  type FollowupRun,
  resolveQueueSettings,
} from "./queue.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { buildReplyUsageState } from "./reply-usage-state.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";
import {
  buildStrandedReplyDeliveryFailurePayload,
  buildStrandedReplyRetryFollowupRun,
} from "./stranded-reply-recovery.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedAgent>>;

type FollowupAgentEvent = { stream: string; data: Record<string, unknown> };

function isStrandedReplyRetryFollowup(queued: FollowupRun): boolean {
  return (
    queued.strandedReplyRetry === true &&
    queued.currentInboundEventKind !== "room_event" &&
    queued.run.sourceReplyDeliveryMode === "message_tool_only"
  );
}

function hasSuccessfulFollowupSourceReplyDelivery(params: {
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTargets?: EmbeddedAgentRunResult["messagingToolSentTargets"];
  messagingToolSourceReplyPayloads?: EmbeddedAgentRunResult["messagingToolSourceReplyPayloads"];
}): boolean {
  return hasCompletedSourceReplyDeliveryEvidence(params);
}

function normalizeAssistantFinalDeliveryText(text: string): string {
  const parsed = normalizeReplyPayloadDirectives({
    payload: { text },
    trimLeadingWhitespace: true,
    parseMode: "auto",
  });
  return sanitizePendingFinalDeliveryText(parsed.payload.text ?? "");
}

function readApprovalScopeValue(value: unknown): "turn" | "session" | undefined {
  return value === "turn" || value === "session" ? value : undefined;
}

function filterStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function hasFailedFollowupProgressEvent(evt: FollowupAgentEvent): boolean {
  const commandOutput = buildCommandOutputFromToolResultEvent(evt);
  if (commandOutput) {
    return (
      commandOutput.status === "failed" ||
      commandOutput.status === "error" ||
      (typeof commandOutput.exitCode === "number" && commandOutput.exitCode !== 0)
    );
  }
  if (evt.stream !== "item" && evt.stream !== "command_output") {
    return false;
  }
  const phase = readStringValue(evt.data.phase);
  const status = readStringValue(evt.data.status);
  return (
    phase === "error" ||
    status === "failed" ||
    status === "error" ||
    (typeof evt.data.exitCode === "number" && evt.data.exitCode !== 0)
  );
}

async function forwardFollowupProgressEvent(params: {
  evt: FollowupAgentEvent;
  opts?: GetReplyOptions;
  detailMode?: "explain" | "raw";
  emitChannelProgress?: boolean;
  onCompactionComplete?: () => void;
  notifyUserAboutCompaction?: boolean;
  currentMessageId?: string;
  onCompactionNoticePayload?: (payload: ReplyPayload) => Promise<void> | void;
}): Promise<boolean> {
  const { evt, opts } = params;
  let visible = false;
  const emitChannelProgress = params.emitChannelProgress !== false;
  const allowQuietToolLifecycle =
    evt.stream === "tool" && opts?.allowToolLifecycleWhenProgressHidden === true;
  if (!emitChannelProgress && evt.stream !== "compaction" && !allowQuietToolLifecycle) {
    return false;
  }

  if (evt.stream === "tool" && evt.data.hideFromChannelProgress !== true) {
    const phase = readStringValue(evt.data.phase) ?? "";
    const name = readStringValue(evt.data.name);
    if (phase === "start" || phase === "update") {
      await opts?.onToolStart?.({
        itemId: readStringValue(evt.data.itemId),
        toolCallId: readStringValue(evt.data.toolCallId),
        name,
        phase,
        args:
          evt.data.args && typeof evt.data.args === "object"
            ? (evt.data.args as Record<string, unknown>)
            : undefined,
        detailMode: params.detailMode,
      });
    }
    const commandOutput = buildCommandOutputFromToolResultEvent(evt);
    if (commandOutput && opts?.onCommandOutput) {
      visible = (await opts.onCommandOutput(commandOutput)) !== false;
    }
  }

  const suppressItemChannelProgress =
    evt.stream === "item" &&
    evt.data.suppressChannelProgress === true &&
    Boolean(opts?.onToolStart);
  const hideItemFromChannelProgress =
    evt.stream === "item" && evt.data.hideFromChannelProgress === true;
  if (evt.stream === "item" && !suppressItemChannelProgress && !hideItemFromChannelProgress) {
    if (opts?.onItemEvent) {
      visible =
        (await opts.onItemEvent({
          itemId: readStringValue(evt.data.itemId),
          toolCallId: readStringValue(evt.data.toolCallId),
          kind: readStringValue(evt.data.kind),
          title: readStringValue(evt.data.title),
          name: readStringValue(evt.data.name),
          phase: readStringValue(evt.data.phase),
          status: readStringValue(evt.data.status),
          summary: readStringValue(evt.data.summary),
          progressText: readStringValue(evt.data.progressText),
          meta: readStringValue(evt.data.meta),
          approvalId: readStringValue(evt.data.approvalId),
          approvalSlug: readStringValue(evt.data.approvalSlug),
        })) !== false;
    }
  }

  if (evt.stream === "plan") {
    await opts?.onPlanUpdate?.({
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      explanation: readStringValue(evt.data.explanation),
      steps: normalizeAgentPlanSteps(evt.data.steps),
      source: readStringValue(evt.data.source),
    });
  }

  if (evt.stream === "approval") {
    await opts?.onApprovalEvent?.({
      phase: readStringValue(evt.data.phase),
      kind: readStringValue(evt.data.kind),
      status: readStringValue(evt.data.status),
      title: readStringValue(evt.data.title),
      itemId: readStringValue(evt.data.itemId),
      toolCallId: readStringValue(evt.data.toolCallId),
      approvalId: readStringValue(evt.data.approvalId),
      approvalSlug: readStringValue(evt.data.approvalSlug),
      command: readStringValue(evt.data.command),
      host: readStringValue(evt.data.host),
      reason: readStringValue(evt.data.reason),
      scope: readApprovalScopeValue(evt.data.scope),
      message: readStringValue(evt.data.message),
    });
  }

  if (evt.stream === "command_output" && opts?.onCommandOutput) {
    visible =
      (await opts.onCommandOutput({
        itemId: readStringValue(evt.data.itemId),
        phase: readStringValue(evt.data.phase),
        title: readStringValue(evt.data.title),
        toolCallId: readStringValue(evt.data.toolCallId),
        name: readStringValue(evt.data.name),
        output: readStringValue(evt.data.output),
        status: readStringValue(evt.data.status),
        exitCode:
          typeof evt.data.exitCode === "number" || evt.data.exitCode === null
            ? evt.data.exitCode
            : undefined,
        durationMs: typeof evt.data.durationMs === "number" ? evt.data.durationMs : undefined,
        cwd: readStringValue(evt.data.cwd),
      })) !== false;
  }

  if (evt.stream === "patch") {
    await opts?.onPatchSummary?.({
      itemId: readStringValue(evt.data.itemId),
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      toolCallId: readStringValue(evt.data.toolCallId),
      name: readStringValue(evt.data.name),
      added: filterStringArray(evt.data.added),
      modified: filterStringArray(evt.data.modified),
      deleted: filterStringArray(evt.data.deleted),
      summary: readStringValue(evt.data.summary),
    });
  }

  if (evt.stream === "compaction") {
    const phase = readStringValue(evt.data.phase) ?? "";
    const hookMessages = readCompactionHookMessages(evt.data.messages);
    const sendCompactionUserNotices = async (noticePhase: "start" | "end" | "incomplete") => {
      const hookPayload = createCompactionHookNoticePayload({
        messages: hookMessages,
        currentMessageId: params.currentMessageId,
      });
      if (hookPayload) {
        await params.onCompactionNoticePayload?.(hookPayload);
      }
      if (params.notifyUserAboutCompaction === true) {
        await params.onCompactionNoticePayload?.(
          createCompactionNoticePayload({
            phase: noticePhase,
            currentMessageId: params.currentMessageId,
          }),
        );
      }
    };
    if (phase === "start" && emitChannelProgress) {
      await opts?.onCompactionStart?.();
    }
    if (phase === "start") {
      await sendCompactionUserNotices("start");
    }
    if (phase === "end" && evt.data?.completed === true) {
      params.onCompactionComplete?.();
      if (emitChannelProgress) {
        await opts?.onCompactionEnd?.();
      }
      if (evt.data?.willRetry === true) {
        return visible;
      }
      await sendCompactionUserNotices("end");
    } else if (phase === "end") {
      await sendCompactionUserNotices("incomplete");
    }
  }
  return visible;
}

/** Creates the function that drains one queued follow-up run. */
export function createFollowupRunner(params: {
  opts?: InternalGetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  toolProgressDetail?: "explain" | "raw";
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    toolProgressDetail,
  } = params;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (
    payloads: ReplyPayload[],
    queued: FollowupRun,
    resolvedRun: { provider: string; modelId: string },
    options: { kind?: ReplyDispatchKind; mirror?: boolean; runId?: string } = {},
  ): Promise<boolean> => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;
    const deliveryPlan = buildAgentRuntimeDeliveryPlan({
      provider: resolvedRun.provider,
      modelId: resolvedRun.modelId,
      config: runtimeConfig,
      workspaceDir: queued.run.workspaceDir,
      agentDir: queued.run.agentDir,
    });

    const sendablePayloads = payloads.filter(
      (payload): payload is ReplyPayload =>
        hasOutboundReplyContent(payload) &&
        (!deliveryPlan.isSilentPayload(payload) ||
          getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
    );

    if (sendablePayloads.length === 0) {
      return false;
    }

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      defaultRuntime.error?.(
        "followup queue: completed with payloads but no origin route or visible dispatcher is available",
      );
      return false;
    }

    let deliveredAnyPayload = false;
    let crossChannelRouteFailureNeedsNotice = false;
    let routedAnyCrossChannelPayloadToOrigin = false;
    const replyKind = options.kind ?? "final";
    const sendDispatcherPayload = async (payload: ReplyPayload): Promise<boolean> => {
      if (!opts?.onBlockReply) {
        return false;
      }
      if (deliveryPlan.isSilentPayload(payload)) {
        return false;
      }
      await opts.onBlockReply(payload);
      return true;
    };
    for (const payload of sendablePayloads) {
      const providerRoute = deliveryPlan.resolveFollowupRoute({
        payload,
        originatingChannel,
        originatingTo,
        originRoutable: Boolean(shouldRouteToOriginating),
        dispatcherAvailable: Boolean(opts?.onBlockReply),
      });
      if (providerRoute?.route === "drop") {
        logVerbose(
          `followup queue: provider hook dropped payload route reason=${providerRoute.reason ?? "unspecified"}`,
        );
        continue;
      }
      const deliveryRoute =
        providerRoute?.route === "origin" && shouldRouteToOriginating
          ? "origin"
          : providerRoute?.route === "dispatcher" && opts?.onBlockReply
            ? "dispatcher"
            : shouldRouteToOriginating
              ? "origin"
              : opts?.onBlockReply
                ? "dispatcher"
                : undefined;
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (deliveryRoute === "origin" && isRoutableChannel(originatingChannel) && originatingTo) {
        const payloadMetadata = getReplyPayloadMetadata(payload);
        const hasTranscriptOwner =
          payloadMetadata?.assistantMessageIndex !== undefined ||
          payloadMetadata?.assistantTranscriptOwned === true;
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          requesterSenderId: queued.run.senderId,
          requesterSenderName: queued.run.senderName,
          requesterSenderUsername: queued.run.senderUsername,
          requesterSenderE164: queued.run.senderE164,
          threadId: queued.originatingThreadId,
          cfg: runtimeConfig,
          mirror: hasTranscriptOwner ? false : options.mirror,
          replyKind,
          runId: options.runId,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (opts?.onBlockReply) {
            if (origin && origin === provider) {
              deliveredAnyPayload = (await sendDispatcherPayload(payload)) || deliveredAnyPayload;
            } else {
              crossChannelRouteFailureNeedsNotice = true;
            }
          } else {
            defaultRuntime.error?.(`followup queue: route-reply failed: ${errorMsg}`);
          }
        } else if (!result.suppressed) {
          deliveredAnyPayload = true;
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (origin && provider && origin !== provider) {
            routedAnyCrossChannelPayloadToOrigin = true;
          }
        }
      } else if (deliveryRoute === "dispatcher") {
        deliveredAnyPayload = (await sendDispatcherPayload(payload)) || deliveredAnyPayload;
      }
    }
    if (
      crossChannelRouteFailureNeedsNotice &&
      !routedAnyCrossChannelPayloadToOrigin &&
      opts?.onBlockReply
    ) {
      if (queued.currentInboundEventKind === "room_event") {
        logVerbose("followup queue: cross-channel failure notice suppressed for room_event");
        return deliveredAnyPayload;
      }
      deliveredAnyPayload =
        (await sendDispatcherPayload({
          text:
            "Follow-up completed, but OpenClaw could not deliver it to the originating " +
            "channel. The reply content was not forwarded to this channel to avoid " +
            "cross-channel misdelivery.",
          isError: true,
        })) || deliveredAnyPayload;
    }
    return deliveredAnyPayload;
  };

  const runFollowupTurn = async (queued: FollowupRun) => {
    if (isFollowupRunAborted(queued)) {
      completeFollowupRunLifecycle(queued);
      typing.markRunComplete();
      typing.markDispatchIdle();
      return;
    }
    const endDeliveryCorrelations = (queued.deliveryCorrelations ?? [])
      .map((correlation) => correlation.begin())
      .filter((end): end is () => void => typeof end === "function");
    const queuedImages = queued.images ?? opts?.images;
    const queuedImageOrder = queued.imageOrder ?? opts?.imageOrder;
    const queuedMedia = queued.media ?? opts?.media;
    let replyOperation: ReplyOperation | undefined;
    let deferred = false;
    let failed = false;

    try {
      queued.run.config = await resolveQueuedReplyExecutionConfig(queued.run.config, {
        originatingChannel: queued.originatingChannel,
        messageProvider: queued.run.messageProvider,
        originatingAccountId: queued.originatingAccountId,
        agentAccountId: queued.run.agentAccountId,
      });
      const replySessionKey = queued.run.sessionKey ?? sessionKey;
      const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
      let effectiveQueued =
        runtimeConfig === queued.run.config
          ? queued
          : { ...queued, run: { ...queued.run, config: runtimeConfig } };
      let run = effectiveQueued.run;
      let activeSessionEntry =
        (replySessionKey ? sessionStore?.[replySessionKey] : undefined) ??
        (replySessionKey === sessionKey ? sessionEntry : undefined);
      run = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: activeSessionEntry,
        sessionKey: replySessionKey,
      });
      if (run !== effectiveQueued.run) {
        effectiveQueued = { ...effectiveQueued, run };
      }
      const resolveCurrentVerboseLevel = () => {
        if (replySessionKey && storePath) {
          try {
            const level = loadSessionEntryReadOnly({
              storePath,
              sessionKey: replySessionKey,
            })?.verboseLevel;
            if (typeof level === "string" && level.trim()) {
              return level;
            }
          } catch {
            // Keep queued delivery resilient to transient session-store reads.
          }
        }
        const liveEntryLevel = replySessionKey
          ? sessionStore?.[replySessionKey]?.verboseLevel
          : undefined;
        return liveEntryLevel ?? activeSessionEntry?.verboseLevel ?? run.verboseLevel;
      };
      const shouldEmitVerboseProgress = () => {
        const verboseLevel = resolveCurrentVerboseLevel();
        return verboseLevel === "on" || verboseLevel === "full";
      };
      const shouldSuppressDefaultToolProgressMessages = () => !shouldEmitVerboseProgress();
      const shouldEmitToolResultProgress = () =>
        shouldEmitVerboseProgress() && !shouldSuppressDefaultToolProgressMessages();
      const shouldEmitToolOutputProgress = () =>
        resolveCurrentVerboseLevel() === "full" && !shouldSuppressDefaultToolProgressMessages();
      const isRoomEventFollowup = () => queued.currentInboundEventKind === "room_event";
      let observedVisibleToolErrorProgress = false;
      const markVisibleToolErrorProgress = () => {
        if (resolveCurrentVerboseLevel() === "on" && shouldEmitToolResultProgress()) {
          observedVisibleToolErrorProgress = true;
        }
      };
      const shouldSuppressToolErrorWarnings = () => {
        if (opts?.suppressToolErrorWarnings !== undefined) {
          return opts.suppressToolErrorWarnings;
        }
        if (!shouldEmitVerboseProgress()) {
          return false;
        }
        return observedVisibleToolErrorProgress ? true : undefined;
      };
      let progressDeliveryChain: Promise<void> = Promise.resolve();
      const pendingProgressDeliveries = new Set<Promise<void>>();
      const enqueueProgressDelivery = (deliver: () => Promise<void>) => {
        progressDeliveryChain = progressDeliveryChain.then(deliver).catch((err: unknown) => {
          logVerbose(`followup queue: progress delivery failed: ${formatErrorMessage(err)}`);
        });
        const task = progressDeliveryChain.finally(() => {
          pendingProgressDeliveries.delete(task);
        });
        pendingProgressDeliveries.add(task);
        return task;
      };
      const drainProgressDeliveries = async () => {
        while (pendingProgressDeliveries.size > 0) {
          await Promise.all(pendingProgressDeliveries);
        }
      };
      const admission = await admitReplyTurn({
        sessionId: effectiveQueued.admissionSessionId ?? run.sessionId,
        sessionKey: replySessionKey ?? "",
        expectedSessionId: activeSessionEntry?.sessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
        routeThreadId: queued.originatingThreadId,
        upstreamAbortSignal: resolveFollowupAbortSignal(queued),
        onReplyAdmissionWaitChange: effectiveQueued.onReplyAdmissionWaitChange,
      });
      if (admission.status === "skipped") {
        if (admission.reason === "active-run") {
          deferred = true;
          throw new FollowupRunDeferredError("Follow-up reply lane is still active");
        }
        return;
      }
      replyOperation = admission.operation;
      // Failure paths may still drain progress or route a recovery payload. Keep lane ownership
      // until finally completes so the next turn cannot overtake that asynchronous delivery.
      replyOperation.retainFailureUntilComplete();
      // Multi-source collected turns become atomic at reply-lane admission.
      // Their queue owner uses this boundary to retire source cancellation ids.
      await admitFollowupRunLifecycle(effectiveQueued);
      // Admission can await transport-owned durability. Supersession during that handoff is
      // sticky; stop before preflight can emit notices or start provider work for the stale turn.
      if (isFollowupRunAborted(effectiveQueued)) {
        return;
      }
      // Channel delivery state belongs to one admitted run. Give the active
      // dispatcher a boundary before callbacks from this followup can reuse it.
      await opts?.onQueuedFollowupAdmitted?.();
      if (replyOperation.sessionId !== run.sessionId) {
        run = { ...run, sessionId: replyOperation.sessionId };
        effectiveQueued = { ...effectiveQueued, run };
      }
      // Admission may wait while session policy changes. Reload persisted state before any
      // delivery decision; the enqueue-time in-memory snapshot is not authoritative here.
      const admittedSessionEntry = replySessionKey
        ? storePath
          ? loadSessionEntry({ storePath, sessionKey: replySessionKey })
          : sessionStore?.[replySessionKey]
        : undefined;
      if (admittedSessionEntry?.sessionId === replyOperation.sessionId) {
        activeSessionEntry = admittedSessionEntry;
        // Admission is the authority for policy on this exact session generation. A queued
        // snapshot may predate catalog adoption, but a replacement session must not inherit it.
        run = {
          ...run,
          ...(admittedSessionEntry.sessionFile
            ? { sessionFile: admittedSessionEntry.sessionFile }
            : {}),
          modelSelectionLocked: admittedSessionEntry.modelSelectionLocked === true,
        };
        effectiveQueued = { ...effectiveQueued, run };
      }
      const sendPolicyDenied =
        resolveSendPolicy({
          cfg: runtimeConfig,
          entry: activeSessionEntry,
          sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
          channel: queued.originatingChannel ?? run.messageProvider,
          chatType: run.chatType ?? activeSessionEntry?.chatType,
        }) === "deny";
      const progressOpts = sendPolicyDenied ? undefined : opts;
      const preserveProgressCallbackStartOrder =
        progressOpts?.preserveProgressCallbackStartOrder === true;
      // Carry the admission-time policy through every queued delivery path; direct origin routing
      // bypasses the outer dispatcher that normally enforces sendPolicy.
      const sendRunPayloads: typeof sendFollowupPayloads = async (...args) => {
        if (sendPolicyDenied) {
          return false;
        }
        return sendFollowupPayloads(...args);
      };
      // Admission already loads the latest entry under the lifecycle fence.
      const goalContextSessionEntry = admission.sessionEntry ?? activeSessionEntry;
      const currentInboundContext =
        opts?.isHeartbeat === true
          ? effectiveQueued.currentInboundContext
          : refreshActiveGoalContext(
              effectiveQueued.currentInboundContext,
              goalContextSessionEntry,
            );
      const runId = crypto.randomUUID();
      const shouldSurfaceToControlUi = isInternalMessageChannel(
        resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: run.messageProvider,
        }),
      );
      let autoCompactionCount = 0;
      let runResult: Awaited<ReturnType<typeof runEmbeddedAgent>>;
      let fallbackProvider = run.provider;
      let fallbackModel = run.model;
      let fallbackExhausted = false;
      let terminalRunFailed = false;
      const resolveFollowupCurrentMessageId = () =>
        run.inputProvenance?.kind === "internal_system" &&
        run.inputProvenance.sourceTool === "restart-sentinel"
          ? queued.originatingReplyToId
          : queued.messageId;
      const compactionNoticeReplyToId = resolveFollowupCurrentMessageId();
      const sendCompactionNoticePayload = async (
        payload: ReplyPayload,
        resolvedRun: { provider: string; modelId: string } = {
          provider: fallbackProvider,
          modelId: fallbackModel,
        },
      ) => {
        if (isRoomEventFollowup()) {
          logVerbose("followup queue: compaction notice suppressed for room_event");
          return;
        }
        const noticePayloads = resolveFollowupDeliveryPayloads({
          cfg: runtimeConfig,
          payloads: [payload],
          messageProvider: run.messageProvider,
          originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
          originatingChannel: queued.originatingChannel,
          originatingChatType: queued.originatingChatType,
          originatingReplyToMode: queued.originatingReplyToMode,
          originatingTo: queued.originatingTo,
          reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
          commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
        });
        if (noticePayloads.length === 0) {
          return;
        }
        await sendRunPayloads(noticePayloads, effectiveQueued, resolvedRun, {
          kind: "block",
          mirror: false,
          runId,
        });
      };
      const notifyPreflightCompaction = shouldNotifyUserAboutCompaction(runtimeConfig)
        ? async (phase: CompactionNoticePhase) => {
            await sendCompactionNoticePayload(
              createCompactionNoticePayload({
                phase,
                currentMessageId: compactionNoticeReplyToId,
              }),
            );
          }
        : undefined;
      let lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
      if (run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: run.sessionKey,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          agentId: run.agentId,
          lifecycleGeneration,
          verboseLevel: run.verboseLevel,
          isControlUiVisible: shouldSurfaceToControlUi,
        });
      }
      const prePreflightCompactionCount = activeSessionEntry?.compactionCount ?? 0;
      let preflightCompactionApplied;
      try {
        activeSessionEntry = await runPreflightCompactionIfNeeded({
          cfg: runtimeConfig,
          followupRun: effectiveQueued,
          promptForEstimate: queued.prompt,
          defaultModel,
          agentCfgContextTokens,
          sessionEntry: activeSessionEntry,
          sessionStore,
          sessionKey: replySessionKey,
          storePath,
          isHeartbeat: opts?.isHeartbeat === true,
          replyOperation,
          onCompactionNotice: notifyPreflightCompaction,
        });
        preflightCompactionApplied =
          (activeSessionEntry?.compactionCount ?? 0) > prePreflightCompactionCount;
      } catch (err) {
        clearAgentRunContext(runId, lifecycleGeneration);
        const message = formatErrorMessage(err);
        replyOperation.fail("run_failed", err);
        const preflightCompactionFailureText = buildPreflightCompactionFailureText(message, {
          includeDetails: run.verboseLevel === "on" || run.verboseLevel === "full",
        });
        if (preflightCompactionFailureText) {
          if (isRoomEventFollowup()) {
            logVerbose(
              "followup queue: preflight compaction failure notice suppressed for room_event",
            );
            return;
          }
          await sendRunPayloads(
            [
              markReplyPayloadForSourceSuppressionDelivery({
                text: preflightCompactionFailureText,
              }),
            ],
            effectiveQueued,
            { provider: fallbackProvider, modelId: fallbackModel },
          );
          return;
        }
        throw err;
      }
      if (run.sessionKey) {
        const owningSessionId =
          activeSessionEntry?.sessionId === run.sessionId
            ? activeSessionEntry.sessionId
            : run.sessionId;
        registerAgentRunContext(runId, {
          sessionKey: run.sessionKey,
          ...(owningSessionId ? { sessionId: owningSessionId } : {}),
          agentId: run.agentId,
          lifecycleGeneration,
          verboseLevel: run.verboseLevel,
          isControlUiVisible: shouldSurfaceToControlUi,
        });
      }
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );
      const preserveUserFacingSessionState = shouldPreserveUserFacingSessionStateForInputProvenance(
        queued.run.inputProvenance,
      );
      const resolveRunForFallbackCandidate = (
        provider: string,
        model: string,
      ): FollowupRun["run"] => {
        const probe = run.autoFallbackPrimaryProbe;
        const isPrimaryProbeCandidate =
          probe && provider === probe.provider && model === probe.model;
        if (
          probe &&
          provider === probe.fallbackProvider &&
          !isPrimaryProbeCandidate &&
          probe.fallbackAuthProfileId
        ) {
          const candidateRun: FollowupRun["run"] = {
            ...run,
            provider,
            model,
            authProfileId: probe.fallbackAuthProfileId,
          };
          if (probe.fallbackAuthProfileIdSource) {
            candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
          } else {
            delete candidateRun.authProfileIdSource;
          }
          return candidateRun;
        }
        return run;
      };
      const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear: {
        provider: string;
        model: string;
      }): Promise<void> => {
        if (preserveUserFacingSessionState) {
          return;
        }
        const probe = run.autoFallbackPrimaryProbe;
        if (!probe) {
          return;
        }
        if (paramsForClear.provider !== probe.provider || paramsForClear.model !== probe.model) {
          return;
        }
        if (!replySessionKey || !sessionStore) {
          return;
        }
        const entry = sessionStore[replySessionKey] ?? activeSessionEntry;
        if (!entry || !entryMatchesAutoFallbackPrimaryProbe(entry, probe)) {
          return;
        }
        clearAutoFallbackPrimaryProbeSelection(entry);
        sessionStore[replySessionKey] = entry;
        activeSessionEntry = entry;
        if (!storePath) {
          return;
        }
        await updateSessionEntry({ storePath, sessionKey: replySessionKey }, (persistedEntry) => {
          if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
            return null;
          }
          const shouldClearAuthProfile =
            persistedEntry.authProfileOverrideSource === "auto" ||
            (persistedEntry.authProfileOverrideSource === undefined &&
              persistedEntry.authProfileOverrideCompactionCount !== undefined);
          clearAutoFallbackPrimaryProbeSelection(persistedEntry);
          return {
            providerOverride: undefined,
            modelOverride: undefined,
            modelOverrideSource: undefined,
            modelOverrideFallbackOriginProvider: undefined,
            modelOverrideFallbackOriginModel: undefined,
            ...(shouldClearAuthProfile
              ? {
                  authProfileOverride: undefined,
                  authProfileOverrideSource: undefined,
                  authProfileOverrideCompactionCount: undefined,
                }
              : {}),
            fallbackNoticeSelectedModel: undefined,
            fallbackNoticeActiveModel: undefined,
            fallbackNoticeReason: undefined,
            updatedAt: persistedEntry.updatedAt,
          };
        });
      };
      fallbackProvider = run.provider;
      fallbackModel = run.model;
      replyOperation.setPhase("running");
      const runAbortSignal = replyOperation.abortSignal;
      let pendingLifecycleTerminal:
        | {
            provider: string;
            model: string;
            backstop: AgentLifecycleTerminalBackstop;
          }
        | undefined;
      let queuedUserMessagePersistedAcrossFallback = false;
      let assistantErrorPersistedAcrossFallback = false;
      const fastModeStartedAtMs = Date.now();
      const fastModeAutoProgressState: FastModeAutoProgressState = {
        offAnnounced: false,
        resetAnnounced: false,
      };
      try {
        const selection = resolveModelFallbackOptions(run, runtimeConfig);
        const fallbackResult = await runEmbeddedAgentEntry<EmbeddedAgentRunResult>({
          selection: {
            cfg: selection.cfg,
            provider: selection.provider,
            model: selection.model,
            agentDir: selection.agentDir,
            fallbacksOverride: selection.fallbacksOverride,
          },
          identity: {
            runId,
            agentId: run.agentId,
            sessionId: run.sessionId,
            sessionKey: selection.sessionKey,
          },
          harness: {
            workspaceDir: run.workspaceDir,
            sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
            preparation: { kind: "direct" },
            resolveRuntimeOverride: (provider) =>
              resolveSessionRuntimeOverrideForProvider({
                provider,
                entry: activeSessionEntry,
                cfg: runtimeConfig,
              }),
          },
          behavior: { kind: "followup-delivery" },
          sessionOverride: {
            kind: "reconcile-completed",
            reconcile: clearRecoveredAutoFallbackPrimaryProbe,
          },
          abortSignal: runAbortSignal,
          runCandidate: async (provider, model, runOptions) => {
            const suppressQueuedUserPersistenceForCandidate =
              (run.suppressNextUserMessagePersistence ?? false) ||
              queuedUserMessagePersistedAcrossFallback;
            const suppressAssistantErrorPersistenceForCandidate =
              assistantErrorPersistedAcrossFallback;
            const candidateRun = resolveRunForFallbackCandidate(provider, model);
            const candidateThinkLevel = resolveCandidateThinkingLevel({
              cfg: runtimeConfig,
              provider,
              modelId: model,
              level: run.thinkLevel,
              agentId: run.agentId,
              sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
              sessionEntry: activeSessionEntry,
            });
            const candidateFastMode = resolveRunFastModeForFallbackCandidate({
              run: candidateRun,
              config: runtimeConfig,
              provider,
              model,
              sessionEntry: activeSessionEntry,
            });
            const activeProbe = run.autoFallbackPrimaryProbe;
            if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) {
              markAutoFallbackPrimaryProbe({
                probe: activeProbe,
                sessionKey: replySessionKey,
              });
            }
            const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, {
              config: runtimeConfig,
            });
            const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
              provider,
              entry: activeSessionEntry,
              cfg: runtimeConfig,
            });
            // A locked harness owns the transcript. A configured CLI backend with the
            // same id must not steal dispatch from that persisted harness.
            const locksPersistedHarness =
              activeSessionEntry?.modelSelectionLocked === true &&
              normalizeOptionalAgentRuntimeId(activeSessionEntry.agentHarnessId) ===
                sessionRuntimeOverride;
            const pinnedCliRuntime =
              !locksPersistedHarness &&
              sessionRuntimeOverride &&
              isCliProvider(sessionRuntimeOverride, runtimeConfig)
                ? sessionRuntimeOverride
                : undefined;
            const cliExecutionProvider =
              pinnedCliRuntime ??
              (sessionRuntimeOverride
                ? provider
                : (resolveCliRuntimeExecutionProvider({
                    provider,
                    cfg: runtimeConfig,
                    agentId: run.agentId,
                    modelId: model,
                    authProfileId: selectedAuthProfile.authProfileId,
                  }) ?? provider));
            const useCliExecution =
              pinnedCliRuntime !== undefined ||
              (!sessionRuntimeOverride && isCliProvider(cliExecutionProvider, runtimeConfig));
            let attemptCompactionCount = 0;
            const userTurnTranscriptRecorder =
              effectiveQueued.userTurnTranscriptRecorder ?? opts?.userTurnTranscriptRecorder;
            const notifyUserMessagePersisted = () => {
              queuedUserMessagePersistedAcrossFallback = true;
            };
            // Shared by the embedded onToolResult callback and the CLI tool
            // summary tracker so both runners deliver identical durable summaries.
            const deliverFollowupToolSummary = (payload: ReplyPayload) =>
              enqueueProgressDelivery(async () => {
                // room_event turns are ambient; only an explicit message tool call
                // may post back into the source chat.
                if (isRoomEventFollowup()) {
                  return;
                }
                if (
                  run.sourceReplyDeliveryMode === "message_tool_only" &&
                  !shouldEmitToolResultProgress()
                ) {
                  return;
                }
                await sendRunPayloads(
                  [payload],
                  effectiveQueued,
                  {
                    provider,
                    modelId: model,
                  },
                  { kind: "tool", mirror: false, runId },
                );
                if (payload.isError === true) {
                  markVisibleToolErrorProgress();
                }
              });
            try {
              if (useCliExecution) {
                const cliSessionBinding = getCliSessionBinding(
                  activeSessionEntry,
                  cliExecutionProvider,
                );
                const cliLifecycleStartedAt = Date.now();
                const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
                  runId,
                  sessionKey: replySessionKey,
                  startedAt: cliLifecycleStartedAt,
                  getLifecycleGeneration: () => lifecycleGeneration,
                  resolveTerminationFields: (error) =>
                    resolveAgentRunErrorLifecycleFields(error, runAbortSignal),
                });
                let droppedCliSessionReplacement = false;
                pendingLifecycleTerminal = { provider, model, backstop: lifecycleBackstop };
                const followupCurrentMessageId = resolveFollowupCurrentMessageId();
                const cliToolSummaryTracker = createCliToolSummaryTracker({
                  detailMode: toolProgressDetail,
                  shouldEmitToolResult: shouldEmitToolResultProgress,
                  shouldEmitToolOutput: shouldEmitToolOutputProgress,
                  deliver: deliverFollowupToolSummary,
                });
                const result = await withLocalSessionPlacementTurnAdmission(
                  {
                    sessionId: run.sessionId,
                    sessionKey: replySessionKey,
                    agentId: run.agentId,
                    runId,
                  },
                  () =>
                    runCliAgentWithLifecycle({
                      runId,
                      lifecycleGeneration,
                      provider: cliExecutionProvider,
                      startedAt: cliLifecycleStartedAt,
                      emitLifecycleTerminal: false,
                      onAgentRunStart: () => opts?.onAgentRunStart?.(runId),
                      suppressAssistantBridge: run.silentExpected,
                      onActivity: () => replyOperation?.recordActivity(),
                      preserveProgressCallbackStartOrder,
                      onReasoningText: createCliReasoningStreamBridge(
                        progressOpts?.onReasoningStream,
                      ),
                      onPlanUpdate: progressOpts?.onPlanUpdate,
                      onReasoningProgress: async (payload) => {
                        await progressOpts?.onReasoningProgress?.(payload);
                      },
                      onToolEvent: async (payload) => {
                        if (!preserveProgressCallbackStartOrder) {
                          await cliToolSummaryTracker.noteToolEvent(payload);
                          if (payload.phase === "result") {
                            return;
                          }
                          await forwardFollowupProgressEvent({
                            evt: {
                              stream: "tool",
                              data: {
                                name: payload.name,
                                phase: payload.phase,
                                args: payload.args,
                              },
                            },
                            opts: progressOpts,
                            detailMode: toolProgressDetail,
                            emitChannelProgress: shouldEmitToolResultProgress(),
                          });
                          return;
                        }
                        if (payload.phase === "result") {
                          await cliToolSummaryTracker.noteToolEvent(payload);
                          return;
                        }
                        // CLI bridges drain independently. Start channel presentation before
                        // summary bookkeeping can yield and let later progress overtake this tool.
                        const presentationPromise = forwardFollowupProgressEvent({
                          evt: {
                            stream: "tool",
                            data: { name: payload.name, phase: payload.phase, args: payload.args },
                          },
                          opts: progressOpts,
                          detailMode: toolProgressDetail,
                          emitChannelProgress: shouldEmitToolResultProgress(),
                        });
                        await Promise.all([
                          presentationPromise,
                          cliToolSummaryTracker.noteToolEvent(payload),
                        ]);
                      },
                      onCommentaryText:
                        progressOpts?.onItemEvent && shouldBridgeCliPreambleEvents(progressOpts)
                          ? async ({ text, itemId }) => {
                              await forwardFollowupProgressEvent({
                                evt: {
                                  stream: "item",
                                  data: { kind: "preamble", progressText: text, itemId },
                                },
                                opts: progressOpts,
                                detailMode: toolProgressDetail,
                              });
                            }
                          : undefined,
                      onFastModeAutoProgress: async (payload) => {
                        await enqueueProgressDelivery(async () => {
                          // Mirrors direct dispatch progress suppression: ambient
                          // room events never get automatic fast-mode notices.
                          if (isRoomEventFollowup()) {
                            return;
                          }
                          await sendRunPayloads(
                            [payload],
                            effectiveQueued,
                            {
                              provider,
                              modelId: model,
                            },
                            { kind: "tool", mirror: false, runId },
                          );
                        });
                      },
                      transformResult:
                        queued.currentInboundEventKind === "room_event"
                          ? (resultLocal) =>
                              keepCliSessionBindingOnlyWhenReused({
                                result: resultLocal,
                                existingSessionId: cliSessionBinding?.sessionId,
                                onDroppedReplacement: () => {
                                  droppedCliSessionReplacement = true;
                                },
                              })
                          : undefined,
                      runParams: {
                        replyOperation,
                        sessionId: run.sessionId,
                        sessionKey: replySessionKey,
                        runtimePolicySessionKey: run.runtimePolicySessionKey,
                        agentId: run.agentId,
                        trigger: opts?.isHeartbeat === true ? "heartbeat" : "user",
                        sessionFile: run.sessionFile,
                        workspaceDir: run.workspaceDir,
                        cwd: run.cwd,
                        config: runtimeConfig,
                        prompt: queued.prompt,
                        transcriptPrompt: queued.transcriptPrompt,
                        suppressNextUserMessagePersistence:
                          suppressQueuedUserPersistenceForCandidate,
                        userTurnTranscriptRecorder,
                        onUserMessagePersisted: notifyUserMessagePersisted,
                        persistAssistantTranscript:
                          queued.currentInboundEventKind !== "room_event" &&
                          run.suppressTranscriptOnlyAssistantPersistence !== true,
                        storePath,
                        currentInboundEventKind: queued.currentInboundEventKind,
                        currentInboundAudio: queued.currentInboundAudio,
                        currentInboundContext,
                        inputProvenance: run.inputProvenance,
                        modelProvider: provider,
                        provider: cliExecutionProvider,
                        execOverrides: run.execOverrides,
                        bashElevated: run.bashElevated,
                        model,
                        ...resolveRunAuthProfile(candidateRun, cliExecutionProvider, {
                          config: runtimeConfig,
                        }),
                        thinkLevel: candidateThinkLevel,
                        fastMode: candidateFastMode.fastMode,
                        fastModeStartedAtMs,
                        fastModeAutoOnSeconds: candidateFastMode.fastModeAutoOnSeconds,
                        fastModeAutoProgressState,
                        isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
                        timeoutMs: run.timeoutMs,
                        runTimeoutOverrideMs: run.runTimeoutOverrideMs,
                        runId,
                        extraSystemPrompt: run.extraSystemPrompt,
                        sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
                        taskSuggestionDeliveryMode: run.taskSuggestionDeliveryMode,
                        silentReplyPromptMode: run.silentReplyPromptMode,
                        allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
                        extraSystemPromptStatic: run.extraSystemPromptStatic,
                        cliSessionBindingFacts: run.cliSessionBindingFacts,
                        ownerNumbers: run.ownerNumbers,
                        cliSessionId: cliSessionBinding?.sessionId,
                        cliSessionBinding,
                        bootstrapPromptWarningSignaturesSeen,
                        bootstrapPromptWarningSignature:
                          bootstrapPromptWarningSignaturesSeen[
                            bootstrapPromptWarningSignaturesSeen.length - 1
                          ],
                        images: queuedImages,
                        imageOrder: queuedImageOrder,
                        media: queuedMedia,
                        skillsSnapshot: run.skillsSnapshot,
                        messageChannel: queued.originatingChannel ?? undefined,
                        messageProvider: resolveOriginMessageProvider({
                          originatingChannel: queued.originatingChannel,
                          provider: run.messageProvider,
                        }),
                        clientCaps: run.clientCaps,
                        currentChannelId: queued.originatingTo,
                        senderId: run.senderId,
                        senderName: run.senderName,
                        senderUsername: run.senderUsername,
                        senderE164: run.senderE164,
                        groupId: run.groupId,
                        groupChannel: run.groupChannel,
                        groupSpace: run.groupSpace,
                        spawnedBy: run.spawnedBy,
                        chatId: queued.originatingChatId,
                        channelContext: run.channelContext,
                        currentThreadTs:
                          queued.originatingThreadId != null
                            ? String(queued.originatingThreadId)
                            : undefined,
                        currentMessageId: followupCurrentMessageId,
                        agentAccountId: run.agentAccountId,
                        senderIsOwner: run.senderIsOwner,
                        disableTools: opts?.disableTools,
                        abortSignal: runAbortSignal,
                      },
                    }),
                );
                if (droppedCliSessionReplacement) {
                  await clearDroppedCliSessionBinding({
                    provider: cliExecutionProvider,
                    sessionKey: replySessionKey,
                    sessionStore,
                    storePath,
                    activeSessionEntry,
                  });
                }
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  result.meta?.systemPromptReport,
                );
                return result;
              }
              const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
                runId,
                sessionKey: replySessionKey,
                getLifecycleGeneration: () => lifecycleGeneration,
                resolveTerminationFields: (error) =>
                  resolveAgentRunErrorLifecycleFields(error, runAbortSignal),
              });
              pendingLifecycleTerminal = { provider, model, backstop: lifecycleBackstop };
              const followupCurrentMessageId = resolveFollowupCurrentMessageId();
              const runSessionTarget =
                storePath && run.sessionKey
                  ? {
                      ...(run.agentId ? { agentId: run.agentId } : {}),
                      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
                      sessionKey: run.sessionKey,
                      storePath,
                    }
                  : undefined;
              const result = await runEmbeddedAgent({
                allowGatewaySubagentBinding: true,
                lifecycleGeneration,
                replyOperation,
                sessionId: run.sessionId,
                sessionKey: run.sessionKey,
                agentId: run.agentId,
                sessionTarget: runSessionTarget,
                trigger: "user",
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: run.messageProvider,
                // Queued turns must keep the originating client's declared caps or
                // capability-gated tools vanish between the live turn and its drain.
                clientCaps: run.clientCaps,
                chatType: run.chatType,
                agentAccountId: run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
                chatId: queued.originatingChatId,
                currentThreadTs:
                  queued.originatingThreadId != null
                    ? String(queued.originatingThreadId)
                    : undefined,
                currentMessageId: followupCurrentMessageId,
                groupId: run.groupId,
                groupChannel: run.groupChannel,
                groupSpace: run.groupSpace,
                senderId: run.senderId,
                senderName: run.senderName,
                senderUsername: run.senderUsername,
                senderE164: run.senderE164,
                channelContext: run.channelContext,
                sessionFile: run.sessionFile,
                agentDir: run.agentDir,
                workspaceDir: run.workspaceDir,
                cwd: run.cwd,
                config: runtimeConfig,
                skillsSnapshot: run.skillsSnapshot,
                prompt: queued.prompt,
                transcriptPrompt: queued.transcriptPrompt,
                userTurnTranscriptRecorder,
                currentInboundEventKind: queued.currentInboundEventKind,
                currentInboundAudio: queued.currentInboundAudio,
                currentInboundContext,
                extraSystemPrompt: run.extraSystemPrompt,
                silentReplyPromptMode: run.silentReplyPromptMode,
                sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
                taskSuggestionDeliveryMode: run.taskSuggestionDeliveryMode,
                forceMessageTool: run.sourceReplyDeliveryMode === "message_tool_only",
                suppressNextUserMessagePersistence: suppressQueuedUserPersistenceForCandidate,
                onUserMessagePersisted: notifyUserMessagePersisted,
                suppressTranscriptOnlyAssistantPersistence:
                  run.suppressTranscriptOnlyAssistantPersistence,
                suppressAssistantErrorPersistence: suppressAssistantErrorPersistenceForCandidate,
                onAssistantErrorMessagePersisted: () => {
                  assistantErrorPersistedAcrossFallback = true;
                },
                ownerNumbers: run.ownerNumbers,
                enforceFinalTag: run.enforceFinalTag,
                allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
                provider,
                model,
                modelSelectionLocked: run.modelSelectionLocked,
                agentHarnessId: sessionRuntimeOverride,
                agentHarnessRuntimeOverride: sessionRuntimeOverride,
                ...selectedAuthProfile,
                thinkLevel: candidateThinkLevel,
                fastMode: candidateFastMode.fastMode,
                fastModeStartedAtMs,
                fastModeAutoOnSeconds: candidateFastMode.fastModeAutoOnSeconds,
                fastModeAutoProgressState,
                verboseLevel: run.verboseLevel,
                reasoningLevel: run.reasoningLevel,
                suppressToolErrorWarnings: shouldSuppressToolErrorWarnings,
                execOverrides: run.execOverrides,
                bashElevated: run.bashElevated,
                timeoutMs: run.timeoutMs,
                runTimeoutOverrideMs: run.runTimeoutOverrideMs,
                runId,
                isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
                abortSignal: runAbortSignal,
                deferTerminalLifecycle: true,
                onExecutionStarted: (info) => {
                  if (info?.lifecycleGeneration) {
                    lifecycleGeneration = info.lifecycleGeneration;
                  }
                },
                images: queuedImages,
                imageOrder: queuedImageOrder,
                media: queuedMedia,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                blockReplyBreak: run.blockReplyBreak,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                toolProgressDetail,
                shouldEmitToolResult: shouldEmitToolResultProgress,
                shouldEmitToolOutput: shouldEmitToolOutputProgress,
                onToolResult: deliverFollowupToolSummary,
                onAgentEvent: (evt) => {
                  replyOperation?.recordActivity();
                  lifecycleBackstop.note(evt);
                  return enqueueProgressDelivery(async () => {
                    const visible = await forwardFollowupProgressEvent({
                      evt,
                      opts: progressOpts,
                      detailMode: toolProgressDetail,
                      emitChannelProgress: shouldEmitToolResultProgress(),
                      onCompactionComplete: () => {
                        attemptCompactionCount += 1;
                      },
                      notifyUserAboutCompaction: shouldNotifyUserAboutCompaction(runtimeConfig),
                      currentMessageId: compactionNoticeReplyToId,
                      onCompactionNoticePayload: (payload) =>
                        sendCompactionNoticePayload(payload, { provider, modelId: model }),
                    });
                    if (visible && hasFailedFollowupProgressEvent(evt)) {
                      markVisibleToolErrorProgress();
                    }
                  });
                },
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
        fallbackExhausted = fallbackResult.outcome === "exhausted";
        const settledLifecycleTerminal =
          pendingLifecycleTerminal?.provider === fallbackProvider &&
          pendingLifecycleTerminal.model === fallbackModel
            ? pendingLifecycleTerminal.backstop
            : undefined;
        pendingLifecycleTerminal = undefined;
        if (isAgentRunRestartAbortReason(runAbortSignal.reason)) {
          settledLifecycleTerminal?.emit("end", runResult);
          throw runAbortSignal.reason;
        }
        if (
          replyOperation.result?.kind === "aborted" &&
          replyOperation.result.code === "aborted_by_user"
        ) {
          settledLifecycleTerminal?.emit("end", runResult);
          await drainProgressDeliveries();
          return;
        }
        replyOperation.freezeAbort();
        const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
          if (settledLifecycleTerminal) {
            settledLifecycleTerminal.emit("error", error, extraData);
            return;
          }
          emitAgentEvent({
            runId,
            lifecycleGeneration,
            ...(replySessionKey ? { sessionKey: replySessionKey } : {}),
            stream: "lifecycle",
            data: {
              phase: "error",
              error: error.message,
              endedAt: Date.now(),
              ...extraData,
            },
          });
        };
        const deferredLifecycleError = settledLifecycleTerminal?.getDeferredError();
        const userFacingErrorPayload = runResult.payloads?.find(
          (payload) => payload.isError === true && typeof payload.text === "string",
        )?.text;
        const terminalErrorMessage =
          deferredLifecycleError ??
          userFacingErrorPayload ??
          (runResult.meta?.error ? "Agent run failed" : undefined);
        const terminalMetadata = fallbackResult.terminal.metadata;
        if (fallbackExhausted) {
          const exhaustionError = new Error(
            terminalErrorMessage ?? "All model fallback candidates failed",
          );
          emitSettledLifecycleError(exhaustionError, {
            ...terminalMetadata,
            fallbackExhaustedFailure: true,
          });
          replyOperation.fail("run_failed", exhaustionError);
          terminalRunFailed = true;
        } else if (deferredLifecycleError || runResult.meta?.error) {
          const terminalError = new Error(terminalErrorMessage ?? "Agent run failed");
          emitSettledLifecycleError(terminalError, terminalMetadata);
          replyOperation.fail("run_failed", terminalError);
          terminalRunFailed = true;
        } else {
          settledLifecycleTerminal?.emit("end", runResult);
        }
        if (!fallbackExhausted) {
          await fallbackResult.settleSessionOverride();
        }
      } catch (err) {
        if (
          replyOperation.result?.kind === "aborted" &&
          replyOperation.result.code === "aborted_by_user"
        ) {
          pendingLifecycleTerminal?.backstop.emit("error", err);
          pendingLifecycleTerminal = undefined;
          if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
            clearAgentRunContext(runId, lifecycleGeneration);
          }
          await drainProgressDeliveries();
          return;
        }
        const message = formatErrorMessage(err);
        const shouldRouteFallbackExhaustion = isFallbackSummaryError(err);
        replyOperation.freezeAbort();
        replyOperation.fail("run_failed", err);
        pendingLifecycleTerminal?.backstop.emit("error", err);
        pendingLifecycleTerminal = undefined;
        if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
          clearAgentRunContext(runId, lifecycleGeneration);
        }
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        if (!shouldRouteFallbackExhaustion) {
          await drainProgressDeliveries();
          return;
        }
        // Fallback exhaustion can throw without preserving a candidate result.
        // Continue through the owner delivery path so interactive turns still get safe failure copy.
        runResult = { payloads: [], meta: { durationMs: 0 } };
        fallbackExhausted = true;
        terminalRunFailed = true;
      }

      await drainProgressDeliveries();

      const usage = runResult.meta?.agentMeta?.usage;
      const promptTokens = runResult.meta?.agentMeta?.promptTokens;
      const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const providerUsed =
        runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? queued.run.provider;
      const usedCliProvider = isCliProvider(providerUsed, runtimeConfig);
      const contextTokensUsed =
        resolveContextTokensForModel({
          cfg: queued.run.config,
          provider: providerUsed,
          model: modelUsed,
          contextTokensOverride: agentCfgContextTokens,
          fallbackContextTokens: activeSessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS;
      const deliverStrandedReplyRetryFailureDiagnostic = async () => {
        if (!isStrandedReplyRetryFollowup(effectiveQueued)) {
          return false;
        }
        const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
          cfg: runtimeConfig,
          ctx: {
            ChatType: queued.originatingChatType ?? run.chatType,
            InboundEventKind: queued.currentInboundEventKind,
            Provider: queued.originatingChannel ?? run.messageProvider,
            Surface: queued.originatingChannel ?? run.messageProvider,
          },
          requested: run.sourceReplyDeliveryMode ?? opts?.sourceReplyDeliveryMode,
          sendPolicy: resolveSendPolicy({
            cfg: runtimeConfig,
            entry: activeSessionEntry,
            sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
            channel:
              queued.originatingChannel ??
              run.messageProvider ??
              sessionDeliveryChannel(activeSessionEntry),
            chatType: activeSessionEntry?.chatType,
          }),
        });
        if (sourceReplyPolicy.sendPolicyDenied) {
          return false;
        }
        if (
          hasSuccessfulFollowupSourceReplyDelivery({
            didDeliverSourceReplyViaMessageTool: runResult.didDeliverSourceReplyViaMessageTool,
            messagingToolSentTargets: runResult.messagingToolSentTargets,
            messagingToolSourceReplyPayloads: runResult.messagingToolSourceReplyPayloads,
          })
        ) {
          await opts?.onObservedReplyDelivery?.();
          return false;
        }
        await sendFollowupPayloads(
          [buildStrandedReplyDeliveryFailurePayload()],
          effectiveQueued,
          {
            provider: providerUsed,
            modelId: modelUsed,
          },
          { runId },
        );
        return true;
      };
      const enqueueStrandedReplyRecoveryRetry = async () => {
        if (isStrandedReplyRetryFollowup(effectiveQueued)) {
          return false;
        }
        // Heartbeat turns can reach this path: runReplyAgent builds the
        // followup runner with opts.isHeartbeat and may enqueue-followup while
        // another run is active. Heartbeats already deliver fallback finals
        // via sendDurableMessageBatch, so recovery would duplicate delivery.
        if (opts?.isHeartbeat === true) {
          return false;
        }
        const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
          cfg: runtimeConfig,
          ctx: {
            ChatType: queued.originatingChatType ?? run.chatType,
            InboundEventKind: queued.currentInboundEventKind,
            Provider: queued.originatingChannel ?? run.messageProvider,
            Surface: queued.originatingChannel ?? run.messageProvider,
          },
          requested: run.sourceReplyDeliveryMode ?? opts?.sourceReplyDeliveryMode,
          sendPolicy: resolveSendPolicy({
            cfg: runtimeConfig,
            entry: activeSessionEntry,
            sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
            channel:
              queued.originatingChannel ??
              run.messageProvider ??
              sessionDeliveryChannel(activeSessionEntry),
            chatType: activeSessionEntry?.chatType,
          }),
        });
        const assistantFinalText =
          typeof runResult.meta?.finalAssistantVisibleText === "string"
            ? normalizeAssistantFinalDeliveryText(runResult.meta.finalAssistantVisibleText)
            : "";
        const isStrandedReply =
          queued.currentInboundEventKind !== "room_event" &&
          shouldWarnAboutPrivateMessageToolFinal({
            sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
            sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
            successfulSourceReplyDelivery: hasSuccessfulFollowupSourceReplyDelivery({
              didDeliverSourceReplyViaMessageTool: runResult.didDeliverSourceReplyViaMessageTool,
              messagingToolSentTargets: runResult.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: runResult.messagingToolSourceReplyPayloads,
            }),
            finalText: assistantFinalText,
          });
        if (!isStrandedReply) {
          return false;
        }
        warnPrivateMessageToolFinal({
          sessionKey: replySessionKey,
          channel:
            queued.originatingChannel ??
            run.messageProvider ??
            sessionDeliveryChannel(activeSessionEntry),
          finalTextLength: assistantFinalText.trim().length,
        });
        const retryEnqueued =
          typeof replySessionKey === "string" &&
          replySessionKey.length > 0 &&
          enqueueFollowupRun(
            replySessionKey,
            buildStrandedReplyRetryFollowupRun(effectiveQueued, {
              finalText: assistantFinalText,
              sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
            }),
            resolveQueueSettings({
              cfg: runtimeConfig,
              channel: queued.originatingChannel ?? run.messageProvider,
              sessionEntry: activeSessionEntry,
            }),
            "none",
            runFollowupTurn,
            false,
            { position: "front" },
          );
        if (!retryEnqueued) {
          await sendFollowupPayloads(
            [buildStrandedReplyDeliveryFailurePayload()],
            effectiveQueued,
            {
              provider: providerUsed,
              modelId: modelUsed,
            },
            { runId },
          );
        }
        return true;
      };
      if (storePath && replySessionKey) {
        await persistRunSessionUsage({
          storePath,
          sessionKey: replySessionKey,
          cfg: runtimeConfig,
          usage,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
          promptTokens,
          isHeartbeat: opts?.isHeartbeat === true,
          preserveRuntimeModel: fallbackExhausted,
          preserveUserFacingSessionModelState: preserveUserFacingSessionState,
          modelUsed,
          providerUsed,
          contextTokensUsed,
          systemPromptReport: runResult.meta?.systemPromptReport,
          cliSessionBinding: runResult.meta?.agentMeta?.cliSessionBinding,
          clearCliSessionBinding:
            usedCliProvider && runResult.meta?.agentMeta?.clearCliSessionBinding === true,
          preserveFreshTotalTokensOnStaleUsage: preflightCompactionApplied,
          logLabel: "followup",
        });
      }
      const hasCommittedDelivery =
        hasVisibleOutboundDeliveryEvidence(runResult) ||
        hasCommittedSourceReplyDeliveryEvidence(runResult) ||
        runResult.didSendDeterministicApprovalPrompt === true;
      const hasCompletedTerminalDelivery = hasCompletedTerminalDeliveryEvidence(runResult);
      const hasDeliveryDestination = Boolean(
        (isRoutableChannel(queued.originatingChannel) && queued.originatingTo) ||
        opts?.onBlockReply,
      );
      const isInteractive =
        hasDeliveryDestination &&
        queued.currentInboundEventKind !== "room_event" &&
        (run.inputProvenance?.kind === undefined || run.inputProvenance.kind === "external_user");
      const failureConversationContext = {
        ChatType: queued.originatingChatType,
        Provider: run.messageProvider,
        SessionKey: replySessionKey,
        Surface: queued.originatingChannel,
      };
      const fallbackPayload = terminalRunFailed
        ? isInteractive && !hasCompletedTerminalDelivery
          ? buildTerminalAgentRunFailureReplyPayload({
              isHeartbeat: opts?.isHeartbeat,
              sessionCtx: failureConversationContext,
              cfg: runtimeConfig,
            })
          : undefined
        : buildEmptyInteractiveReplyPayload({
            isInteractive,
            isHeartbeat: opts?.isHeartbeat,
            silentExpected: run.silentExpected,
            allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
            isMessageToolOnly: run.sourceReplyDeliveryMode === "message_tool_only",
            hasPendingContinuation:
              runResult.meta?.yielded === true ||
              (runResult.meta?.pendingToolCalls?.length ?? 0) > 0,
            hasExplicitSilentReply: hasDeliberateSilentTerminalReply(runResult),
            hasCommittedDelivery,
            sessionCtx: failureConversationContext,
            cfg: runtimeConfig,
          });
      const deliveryPlan = buildAgentRuntimeDeliveryPlan({
        provider: providerUsed,
        modelId: modelUsed,
        config: runtimeConfig,
        workspaceDir: run.workspaceDir,
        agentDir: run.agentDir,
      });
      const resolveDeliveryPayloads = (payloads: ReplyPayload[]) =>
        resolveFollowupDeliveryPayloads({
          cfg: runtimeConfig,
          payloads,
          messageProvider: run.messageProvider,
          originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
          originatingChannel: queued.originatingChannel,
          originatingChatType: queued.originatingChatType,
          originatingReplyToMode: queued.originatingReplyToMode,
          originatingTo: queued.originatingTo,
          originatingThreadId: queued.originatingThreadId,
          reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
          commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
          sentMediaUrls: runResult.messagingToolSentMediaUrls,
          sentTargets: runResult.messagingToolSentTargets,
          sentTexts: runResult.messagingToolSentTexts,
        }).filter(
          (payload) => hasOutboundReplyContent(payload) && !deliveryPlan.isSilentPayload(payload),
        );
      let finalPayloads = resolveDeliveryPayloads(runResult.payloads ?? []);
      const hasTerminalReplyPayload = finalPayloads.some(
        (payload) =>
          payload.isReasoning !== true &&
          payload.isCommentary !== true &&
          !isReplyPayloadStatusNotice(payload),
      );
      if (!hasTerminalReplyPayload && fallbackPayload) {
        finalPayloads = [...finalPayloads, ...resolveDeliveryPayloads([fallbackPayload])];
      }
      if (finalPayloads.length === 0) {
        if (await enqueueStrandedReplyRecoveryRetry()) {
          return;
        }
        if (await deliverStrandedReplyRetryFailureDiagnostic()) {
          return;
        }
        return;
      }
      if (
        !terminalRunFailed &&
        fallbackPayload &&
        finalPayloads.some(
          (payload) => payload.isError === true && payload.text === fallbackPayload.text,
        )
      ) {
        replyOperation.fail(
          "run_failed",
          new Error("interactive follow-up completed without a visible reply"),
        );
      }
      let deliveryPayloads = finalPayloads;
      const responseUsageSessionRaw =
        activeSessionEntry?.responseUsage ??
        (replySessionKey ? sessionStore?.[replySessionKey]?.responseUsage : undefined);
      const winnerProvider = fallbackExhausted
        ? undefined
        : (runResult.meta?.executionTrace?.winnerProvider ?? providerUsed);
      const winnerModel = fallbackExhausted
        ? undefined
        : (runResult.meta?.executionTrace?.winnerModel ?? modelUsed);
      const lastCallUsage = runResult.meta?.agentMeta?.lastCallUsage;
      const replyUsageState = buildReplyUsageState({
        config: runtimeConfig,
        provider: providerUsed,
        model: modelUsed,
        fallbackExhausted,
        winnerProvider,
        winnerModel,
        reasoningEffort: typeof run.thinkLevel === "string" ? run.thinkLevel : undefined,
        fallbackUsed: runResult.meta?.executionTrace?.fallbackUsed === true,
        agentId: run.agentId,
        sessionId: run.sessionId,
        chatType: queued.originatingChatType,
        authMode: runResult.meta?.requestShaping?.authMode ?? undefined,
        overrideSource: activeSessionEntry?.modelOverrideSource ?? undefined,
        requestedProvider: run.provider,
        requestedModel: run.model,
        compactionCount:
          typeof runResult.meta?.agentMeta?.compactionCount === "number"
            ? runResult.meta.agentMeta.compactionCount
            : undefined,
        contextTokenBudget:
          typeof contextTokensUsed === "number" && Number.isFinite(contextTokensUsed)
            ? contextTokensUsed
            : undefined,
        promptTokens,
        usage,
        lastCallUsage,
      });
      const responseUsageLine = resolveResponseUsageLine({
        config: runtimeConfig,
        sessionRaw: responseUsageSessionRaw,
        channel: resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: run.messageProvider,
        }),
        usage,
        provider: providerUsed,
        model: modelUsed,
        preserveUserFacingSessionState,
        replyUsageState,
      });
      if (responseUsageLine) {
        deliveryPayloads = appendUsageLine(deliveryPayloads, responseUsageLine);
      }
      if (autoCompactionCount > 0) {
        const previousSessionId = run.sessionId;
        const count = await incrementRunCompactionCount({
          cfg: runtimeConfig,
          sessionEntry: activeSessionEntry,
          sessionStore,
          sessionKey: replySessionKey,
          storePath,
          amount: autoCompactionCount,
          compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          contextTokensUsed,
          newSessionId: runResult.meta?.agentMeta?.sessionId,
          newSessionFile: runResult.meta?.agentMeta?.sessionFile,
        });
        const refreshedSessionEntry =
          replySessionKey && sessionStore ? sessionStore[replySessionKey] : undefined;
        if (refreshedSessionEntry) {
          const queueKey = run.sessionKey ?? sessionKey;
          if (queueKey) {
            refreshQueuedFollowupSession({
              key: queueKey,
              previousSessionId,
              nextSessionId: refreshedSessionEntry.sessionId,
              nextSessionFile: refreshedSessionEntry.sessionFile,
            });
          }
        }
        if (shouldEmitVerboseProgress()) {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          deliveryPayloads = [
            {
              text: `🧹 Auto-compaction complete${suffix}.`,
            },
            ...deliveryPayloads,
          ];
        }
      }
      if (run.sourceReplyDeliveryMode === "message_tool_only") {
        const suppressionDeliverablePayloads = deliveryPayloads.filter(
          (payload) =>
            getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
        );
        if (suppressionDeliverablePayloads.length > 0) {
          // Marked runtime output bypasses source-reply suppression, not the
          // admission-time send policy or ambient room-event silence.
          if (isRoomEventFollowup()) {
            return;
          }
          await sendRunPayloads(
            suppressionDeliverablePayloads,
            effectiveQueued,
            {
              provider: providerUsed,
              modelId: modelUsed,
            },
            { runId },
          );
          return;
        }
        if (await enqueueStrandedReplyRecoveryRetry()) {
          return;
        }
        if (await deliverStrandedReplyRetryFailureDiagnostic()) {
          return;
        }
        logVerbose(
          "followup queue: automatic source delivery suppressed by sourceReplyDeliveryMode: message_tool_only",
        );
        return;
      }
      await sendRunPayloads(
        deliveryPayloads,
        effectiveQueued,
        {
          provider: providerUsed,
          modelId: modelUsed,
        },
        { runId },
      );
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      for (const end of endDeliveryCorrelations.toReversed()) {
        try {
          end();
        } catch (err) {
          defaultRuntime.error?.(
            `followup queue: delivery correlation cleanup failed: ${formatErrorMessage(err)}`,
          );
        }
      }
      // A thrown attempt stays in the drain queue for retry. Its lifecycle
      // identity remains live until the drain later consumes or drops it.
      if (!deferred && !failed) {
        completeFollowupRunLifecycle(queued);
      }
      replyOperation?.complete();
      // Both signals are required for the typing controller to clean up.
      // The main inbound dispatch path calls markDispatchIdle() from the
      // buffered dispatcher's finally block, but followup turns bypass the
      // dispatcher entirely — so we must fire both signals here.  Without
      // this, NO_REPLY / empty-payload followups leave the typing indicator
      // stuck (the keepalive loop keeps sending "typing" to Telegram
      // indefinitely until the TTL expires).
      typing.markRunComplete();
      typing.markDispatchIdle();
    }
  };
  return runFollowupTurn;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
