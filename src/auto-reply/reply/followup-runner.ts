/** Runs queued follow-up agent turns and routes their delivery payloads. */
import crypto from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  markAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import {
  buildAgentRuntimeDeliveryPlan,
  buildAgentRuntimeOutcomePlan,
} from "../../agents/runtime-plan/build.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { readSessionEntry } from "../../config/sessions/store-load.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  clearDroppedCliSessionBinding,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import {
  buildPreflightCompactionFailureText,
  resolveRunAfterAutoFallbackPrimaryProbeRecheck,
  resolveSessionRuntimeOverrideForProvider,
} from "./agent-runner-execution.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
  resolveRunAuthProfile,
} from "./agent-runner-utils.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import {
  completeFollowupRunLifecycle,
  FollowupRunDeferredError,
  isFollowupRunAborted,
  refreshQueuedFollowupSession,
  type FollowupRun,
} from "./queue.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedAgent>>;

type FollowupAgentEvent = { stream: string; data: Record<string, unknown> };

function readApprovalScopeValue(value: unknown): "turn" | "session" | undefined {
  return value === "turn" || value === "session" ? value : undefined;
}

function filterStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function hasFailedFollowupProgressEvent(evt: FollowupAgentEvent): boolean {
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

function canForwardFailedFollowupProgressEvent(
  evt: FollowupAgentEvent,
  opts?: GetReplyOptions,
): boolean {
  if (evt.stream === "command_output") {
    return typeof opts?.onCommandOutput === "function";
  }
  if (evt.stream !== "item") {
    return false;
  }
  if (evt.data.suppressChannelProgress === true && Boolean(opts?.onToolStart)) {
    return false;
  }
  return typeof opts?.onItemEvent === "function";
}

async function forwardFollowupProgressEvent(params: {
  evt: FollowupAgentEvent;
  opts?: GetReplyOptions;
  detailMode?: "explain" | "raw";
  emitChannelProgress?: boolean;
  onCompactionComplete?: () => void;
}) {
  const { evt, opts } = params;
  const emitChannelProgress = params.emitChannelProgress !== false;
  if (!emitChannelProgress && evt.stream !== "compaction") {
    return;
  }

  if (evt.stream === "tool") {
    const phase = readStringValue(evt.data.phase) ?? "";
    const name = readStringValue(evt.data.name);
    if (phase === "start" || phase === "update") {
      await opts?.onToolStart?.({
        name,
        phase,
        args:
          evt.data.args && typeof evt.data.args === "object"
            ? (evt.data.args as Record<string, unknown>)
            : undefined,
        detailMode: params.detailMode,
      });
    }
  }

  const suppressItemChannelProgress =
    evt.stream === "item" &&
    evt.data.suppressChannelProgress === true &&
    Boolean(opts?.onToolStart);
  if (evt.stream === "item" && !suppressItemChannelProgress) {
    await opts?.onItemEvent?.({
      itemId: readStringValue(evt.data.itemId),
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
    });
  }

  if (evt.stream === "plan") {
    await opts?.onPlanUpdate?.({
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      explanation: readStringValue(evt.data.explanation),
      steps: filterStringArray(evt.data.steps),
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

  if (evt.stream === "command_output") {
    await opts?.onCommandOutput?.({
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
    });
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
    if (phase === "start" && emitChannelProgress) {
      await opts?.onCompactionStart?.();
    }
    if (phase === "end" && evt.data?.completed === true) {
      params.onCompactionComplete?.();
      if (emitChannelProgress) {
        await opts?.onCompactionEnd?.();
      }
    }
  }
}

/** Creates the function that drains one queued follow-up run. */
export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
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
  ) => {
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
        hasOutboundReplyContent(payload) && !deliveryPlan.isSilentPayload(payload),
    );

    if (sendablePayloads.length === 0) {
      return;
    }

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      defaultRuntime.error?.(
        "followup queue: completed with payloads but no origin route or visible dispatcher is available",
      );
      return;
    }

    let crossChannelRouteFailureNeedsNotice = false;
    let routedAnyCrossChannelPayloadToOrigin = false;
    const replyKind = options.kind ?? "final";
    const sendDispatcherPayload = async (payload: ReplyPayload) => {
      if (!opts?.onBlockReply) {
        return;
      }
      if (deliveryPlan.isSilentPayload(payload)) {
        return;
      }
      await opts.onBlockReply(payload);
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
          mirror: options.mirror,
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
              await sendDispatcherPayload(payload);
            } else {
              crossChannelRouteFailureNeedsNotice = true;
            }
          } else {
            defaultRuntime.error?.(`followup queue: route-reply failed: ${errorMsg}`);
          }
        } else {
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
        await sendDispatcherPayload(payload);
      }
    }
    if (
      crossChannelRouteFailureNeedsNotice &&
      !routedAnyCrossChannelPayloadToOrigin &&
      opts?.onBlockReply
    ) {
      await sendDispatcherPayload({
        text:
          "Follow-up completed, but OpenClaw could not deliver it to the originating " +
          "channel. The reply content was not forwarded to this channel to avoid " +
          "cross-channel misdelivery.",
        isError: true,
      });
    }
  };

  return async (queued: FollowupRun) => {
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
    let replyOperation: ReplyOperation | undefined;
    let deferred = false;

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
            const level = readSessionEntry(storePath, replySessionKey)?.verboseLevel;
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
        sessionId: run.sessionId,
        sessionKey: replySessionKey ?? "",
        kind: "queued_followup",
        resetTriggered: false,
        routeThreadId: queued.originatingThreadId,
        upstreamAbortSignal: queued.abortSignal,
      });
      if (admission.status === "skipped") {
        if (admission.reason === "active-run") {
          deferred = true;
          throw new FollowupRunDeferredError("Follow-up reply lane is still active");
        }
        return;
      }
      replyOperation = admission.operation;
      if (replyOperation.sessionId !== run.sessionId) {
        run = { ...run, sessionId: replyOperation.sessionId };
        effectiveQueued = { ...effectiveQueued, run };
        const admittedSessionEntry = replySessionKey
          ? (sessionStore?.[replySessionKey] ??
            (storePath
              ? (readSessionEntry(storePath, replySessionKey) as SessionEntry | undefined)
              : undefined))
          : undefined;
        if (admittedSessionEntry?.sessionId === replyOperation.sessionId) {
          activeSessionEntry = admittedSessionEntry;
          if (admittedSessionEntry.sessionFile) {
            run = { ...run, sessionFile: admittedSessionEntry.sessionFile };
            effectiveQueued = { ...effectiveQueued, run };
          }
        }
      }
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
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        replyOperation.fail("run_failed", err);
        const preflightCompactionFailureText = buildPreflightCompactionFailureText(message, {
          includeDetails: run.verboseLevel === "on" || run.verboseLevel === "full",
        });
        if (preflightCompactionFailureText) {
          await sendFollowupPayloads(
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
        await updateSessionStore(storePath, (store) => {
          const persistedEntry = store[replySessionKey];
          if (!persistedEntry) {
            return;
          }
          if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
            return;
          }
          clearAutoFallbackPrimaryProbeSelection(persistedEntry);
          store[replySessionKey] = persistedEntry;
        });
      };
      fallbackProvider = run.provider;
      fallbackModel = run.model;
      replyOperation.setPhase("running");
      const runAbortSignal = replyOperation.abortSignal;
      let pendingDeferredCliTerminal:
        | {
            provider: string;
            model: string;
            startedAt: number;
          }
        | undefined;
      let queuedUserMessagePersistedAcrossFallback = false;
      let assistantErrorPersistedAcrossFallback = false;
      try {
        const outcomePlan = buildAgentRuntimeOutcomePlan();
        const fallbackResult = await runWithModelFallback<EmbeddedAgentRunResult>({
          ...resolveModelFallbackOptions(run, runtimeConfig),
          cfg: runtimeConfig,
          runId,
          sessionId: run.sessionId,
          abortSignal: runAbortSignal,
          resolveAgentHarnessRuntimeOverride: (provider) =>
            resolveSessionRuntimeOverrideForProvider({
              provider,
              entry: activeSessionEntry,
            }),
          prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
            await ensureSelectedAgentHarnessPlugin({
              config: runtimeConfig,
              provider,
              modelId: model,
              agentId: run.agentId,
              sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
              agentHarnessRuntimeOverride,
              workspaceDir: run.workspaceDir,
            });
          },
          classifyResult: ({ result, provider, model }) =>
            outcomePlan.classifyRunResult({ result, provider, model }),
          run: async (provider, model, runOptions) => {
            const suppressQueuedUserPersistenceForCandidate =
              (run.suppressNextUserMessagePersistence ?? false) ||
              queuedUserMessagePersistedAcrossFallback;
            const suppressAssistantErrorPersistenceForCandidate =
              assistantErrorPersistedAcrossFallback;
            const candidateRun = resolveRunForFallbackCandidate(provider, model);
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
            });
            const cliExecutionProvider =
              (sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, runtimeConfig)
                ? sessionRuntimeOverride
                : undefined) ??
              resolveCliRuntimeExecutionProvider({
                provider,
                cfg: runtimeConfig,
                agentId: run.agentId,
                modelId: model,
                authProfileId: selectedAuthProfile.authProfileId,
              }) ??
              provider;
            let attemptCompactionCount = 0;
            const userTurnTranscriptRecorder =
              effectiveQueued.userTurnTranscriptRecorder ?? opts?.userTurnTranscriptRecorder;
            const notifyUserMessagePersisted = () => {
              queuedUserMessagePersistedAcrossFallback = true;
            };
            try {
              if (isCliProvider(cliExecutionProvider, runtimeConfig)) {
                const cliSessionBinding = getCliSessionBinding(
                  activeSessionEntry,
                  cliExecutionProvider,
                );
                const cliLifecycleStartedAt = Date.now();
                let droppedCliSessionReplacement = false;
                pendingDeferredCliTerminal = {
                  provider,
                  model,
                  startedAt: cliLifecycleStartedAt,
                };
                const isRestartSentinelFollowup =
                  run.inputProvenance?.kind === "internal_system" &&
                  run.inputProvenance.sourceTool === "restart-sentinel";
                const followupCurrentMessageId = isRestartSentinelFollowup
                  ? queued.originatingReplyToId
                  : queued.messageId;
                const result = await runCliAgentWithLifecycle({
                  runId,
                  provider: cliExecutionProvider,
                  startedAt: cliLifecycleStartedAt,
                  emitLifecycleTerminal: false,
                  onAgentRunStart: () => opts?.onAgentRunStart?.(runId),
                  suppressAssistantBridge: run.silentExpected,
                  onToolEvent: async ({ name, phase, args }) => {
                    await forwardFollowupProgressEvent({
                      evt: {
                        stream: "tool",
                        data: { name, phase, args },
                      },
                      opts,
                      detailMode: toolProgressDetail,
                      emitChannelProgress: shouldEmitToolResultProgress(),
                    });
                  },
                  onCommentaryText:
                    opts?.commentaryProgressEnabled === true && opts.onItemEvent
                      ? async ({ text, itemId }) => {
                          await forwardFollowupProgressEvent({
                            evt: {
                              stream: "item",
                              data: { kind: "preamble", progressText: text, itemId },
                            },
                            opts,
                            detailMode: toolProgressDetail,
                          });
                        }
                      : undefined,
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
                    agentId: run.agentId,
                    trigger: opts?.isHeartbeat === true ? "heartbeat" : "user",
                    sessionFile: run.sessionFile,
                    workspaceDir: run.workspaceDir,
                    cwd: run.cwd,
                    config: runtimeConfig,
                    prompt: queued.prompt,
                    transcriptPrompt: queued.transcriptPrompt,
                    suppressNextUserMessagePersistence: suppressQueuedUserPersistenceForCandidate,
                    userTurnTranscriptRecorder,
                    onUserMessagePersisted: notifyUserMessagePersisted,
                    currentInboundEventKind: queued.currentInboundEventKind,
                    currentInboundAudio: queued.currentInboundAudio,
                    currentInboundContext: queued.currentInboundContext,
                    inputProvenance: run.inputProvenance,
                    provider: cliExecutionProvider,
                    model,
                    ...resolveRunAuthProfile(candidateRun, cliExecutionProvider, {
                      config: runtimeConfig,
                    }),
                    classifyCommentaryText: opts?.commentaryProgressEnabled !== undefined,
                    thinkLevel: run.thinkLevel,
                    timeoutMs: run.timeoutMs,
                    runId,
                    extraSystemPrompt: run.extraSystemPrompt,
                    sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
                    silentReplyPromptMode: run.silentReplyPromptMode,
                    allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
                    extraSystemPromptStatic: run.extraSystemPromptStatic,
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
                    skillsSnapshot: run.skillsSnapshot,
                    messageChannel: queued.originatingChannel ?? undefined,
                    messageProvider: resolveOriginMessageProvider({
                      originatingChannel: queued.originatingChannel,
                      provider: run.messageProvider,
                    }),
                    currentChannelId: queued.originatingTo,
                    currentThreadTs:
                      queued.originatingThreadId != null
                        ? String(queued.originatingThreadId)
                        : undefined,
                    currentMessageId: followupCurrentMessageId,
                    agentAccountId: run.agentAccountId,
                    disableTools: opts?.disableTools,
                    abortSignal: runAbortSignal,
                  },
                });
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
              pendingDeferredCliTerminal = undefined;
              const isRestartSentinelFollowup =
                run.inputProvenance?.kind === "internal_system" &&
                run.inputProvenance.sourceTool === "restart-sentinel";
              const followupCurrentMessageId = isRestartSentinelFollowup
                ? queued.originatingReplyToId
                : queued.messageId;
              const result = await runEmbeddedAgent({
                allowGatewaySubagentBinding: true,
                replyOperation,
                sessionId: run.sessionId,
                sessionKey: run.sessionKey,
                agentId: run.agentId,
                trigger: "user",
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: run.messageProvider,
                agentAccountId: run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
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
                currentInboundContext: queued.currentInboundContext,
                extraSystemPrompt: run.extraSystemPrompt,
                silentReplyPromptMode: run.silentReplyPromptMode,
                sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
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
                ...selectedAuthProfile,
                thinkLevel: run.thinkLevel,
                verboseLevel: run.verboseLevel,
                reasoningLevel: run.reasoningLevel,
                suppressToolErrorWarnings: shouldSuppressToolErrorWarnings,
                execOverrides: run.execOverrides,
                bashElevated: run.bashElevated,
                timeoutMs: run.timeoutMs,
                runId,
                abortSignal: runAbortSignal,
                images: queuedImages,
                imageOrder: queuedImageOrder,
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
                onToolResult: (payload) =>
                  enqueueProgressDelivery(async () => {
                    if (
                      run.sourceReplyDeliveryMode === "message_tool_only" &&
                      !shouldEmitToolResultProgress()
                    ) {
                      return;
                    }
                    await sendFollowupPayloads(
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
                  }),
                onAgentEvent: (evt) =>
                  enqueueProgressDelivery(async () => {
                    await forwardFollowupProgressEvent({
                      evt,
                      opts,
                      detailMode: toolProgressDetail,
                      emitChannelProgress: shouldEmitToolResultProgress(),
                      onCompactionComplete: () => {
                        attemptCompactionCount += 1;
                      },
                    });
                    if (
                      hasFailedFollowupProgressEvent(evt) &&
                      canForwardFailedFollowupProgressEvent(evt, opts)
                    ) {
                      markVisibleToolErrorProgress();
                    }
                  }),
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
        if (
          pendingDeferredCliTerminal &&
          pendingDeferredCliTerminal.provider === fallbackProvider &&
          pendingDeferredCliTerminal.model === fallbackModel
        ) {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "end",
              startedAt: pendingDeferredCliTerminal.startedAt,
              endedAt: Date.now(),
            },
          });
        }
        pendingDeferredCliTerminal = undefined;
        await clearRecoveredAutoFallbackPrimaryProbe({
          provider: fallbackProvider,
          model: fallbackModel,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        replyOperation.fail("run_failed", err);
        if (pendingDeferredCliTerminal) {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "error",
              startedAt: pendingDeferredCliTerminal.startedAt,
              endedAt: Date.now(),
              error: message,
            },
          });
          pendingDeferredCliTerminal = undefined;
        }
        await drainProgressDeliveries();
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        return;
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
          preserveUserFacingSessionModelState: preserveUserFacingSessionState,
          modelUsed,
          providerUsed,
          contextTokensUsed,
          systemPromptReport: runResult.meta?.systemPromptReport,
          cliSessionBinding: runResult.meta?.agentMeta?.cliSessionBinding,
          clearCliSessionBinding:
            usedCliProvider && runResult.meta?.agentMeta?.clearCliSessionBinding === true,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) {
        return;
      }
      const finalPayloads = resolveFollowupDeliveryPayloads({
        cfg: runtimeConfig,
        payloads: payloadArray,
        messageProvider: run.messageProvider,
        originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
        originatingChannel: queued.originatingChannel,
        originatingChatType: queued.originatingChatType,
        originatingTo: queued.originatingTo,
        sentMediaUrls: runResult.messagingToolSentMediaUrls,
        sentTargets: runResult.messagingToolSentTargets,
        sentTexts: runResult.messagingToolSentTexts,
      });

      if (finalPayloads.length === 0) {
        return;
      }

      let deliveryPayloads = finalPayloads;
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
            ...finalPayloads,
          ];
        }
      }

      if (run.sourceReplyDeliveryMode === "message_tool_only") {
        logVerbose(
          "followup queue: automatic source delivery suppressed by sourceReplyDeliveryMode: message_tool_only",
        );
        return;
      }

      await sendFollowupPayloads(
        deliveryPayloads,
        effectiveQueued,
        {
          provider: providerUsed,
          modelId: modelUsed,
        },
        { runId },
      );
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
      if (!deferred) {
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
}
