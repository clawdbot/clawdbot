import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { listActiveEmbeddedRunSessionKeys } from "../agents/embedded-agent-runner/run-state.js";
import { transitionMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-state.js";
import {
  type HeartbeatTerminalToolFailure,
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "../auto-reply/heartbeat-reply-payload.js";
import {
  resolveHeartbeatScratchProposalFromReplyResult,
  resolveHeartbeatToolResponseFromReplyResult,
} from "../auto-reply/heartbeat-tool-response.js";
import { isHeartbeatAcknowledgementText } from "../auto-reply/heartbeat.js";
import { resolveReplyOperationAgentTurn } from "../auto-reply/reply/reply-operation-agent-turn-state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import {
  listActiveReplyRunSessionKeys,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.public.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  loadExactSessionEntry,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasActiveCronJobs,
  hasActiveCronJobsExceptMarker,
  isCronActiveJobMarkerCurrent,
  type CronActiveJobMarker,
} from "../cron/active-jobs.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import {
  getQueueSize,
  isCommandLaneTaskMarkerCurrent,
  type CommandLaneTaskMarker,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { formatErrorMessage } from "./errors.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import {
  heartbeatLog,
  resolveHeartbeatForWake,
  resolveHeartbeatTimeoutOverrideSeconds,
  shouldUseHeartbeatResponseToolPrompt,
  tryResolveAmbientHeartbeatAgentId,
  type HeartbeatConfig,
} from "./heartbeat-runner-config.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
  selectSystemEventsConsumedByHeartbeat,
  shouldPreflightExecEventWake,
} from "./heartbeat-runner-prompt.js";
import {
  resolveHeartbeatSession,
  resolveIsolatedHeartbeatSessionKey,
  resolveStaleHeartbeatIsolatedSessionKey,
} from "./heartbeat-runner-session.js";
import { isHeartbeatEnabledForAgent, resolveHeartbeatIntervalMs } from "./heartbeat-summary.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import {
  inferHeartbeatWakeSourceFromReason,
  isConfiguredHeartbeatAgent,
  isTargetedUnscheduledWake,
} from "./heartbeat-wake-policy.js";
import {
  areHeartbeatsEnabled,
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type HeartbeatScheduledTask,
  type HeartbeatWakeIntent,
  type HeartbeatWakeSource,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import {
  resolveHeartbeatDeliveryTargetWithSessionRoute,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";

const log = heartbeatLog;

export type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("./heartbeat-runner.runtime.js").getReplyFromConfig;
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    isReplyRunActive?: (sessionKey: string) => boolean;
    listActiveReplyRunSessionKeys?: () => readonly string[];
    listActiveEmbeddedRunSessionKeys?: () => readonly string[];
    nowMs?: () => number;
  };

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("./heartbeat-runner.runtime.js"),
);

function hasActiveRunForAgent(agentId: string, listSessionKeys: () => readonly string[]): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  return listSessionKeys().some((sessionKey) => {
    const parsed = parseAgentSessionKey(sessionKey);
    return parsed ? normalizeAgentId(parsed.agentId) === normalizedAgentId : false;
  });
}

function hasActiveRunForSession(
  sessionKey: string,
  listSessionKeys: () => readonly string[],
): boolean {
  const normalizedSessionKey = sessionKey.trim();
  return Boolean(normalizedSessionKey) && listSessionKeys().includes(normalizedSessionKey);
}

export type HeartbeatRunOptions = {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatConfig;
  source?: HeartbeatWakeSource;
  intent?: HeartbeatWakeIntent;
  reason?: string;
  /** Persisted monitor cadence carried by a coalesced scheduled wake. */
  scheduledEveryMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
  /** Exact cron run marker whose own activity must not block this wake. */
  owningCronJobMarker?: CronActiveJobMarker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  deps?: HeartbeatDeps;
};

export async function resolveHeartbeatWakeStage(opts: HeartbeatRunOptions) {
  const cfg = opts.cfg ?? getRuntimeConfig();
  const explicitAgentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
  const forcedSessionAgentId =
    explicitAgentId.length > 0 ? undefined : parseAgentSessionKey(opts.sessionKey)?.agentId;
  const resolvedAgentId =
    explicitAgentId || forcedSessionAgentId || tryResolveAmbientHeartbeatAgentId(cfg);
  if (!resolvedAgentId) {
    return { kind: "skipped", reason: "disabled" } as const;
  }
  const agentId = normalizeAgentId(resolvedAgentId);
  const wakeSource = opts.source ?? inferHeartbeatWakeSourceFromReason(opts.reason);
  const heartbeat = resolveHeartbeatForWake({
    cfg,
    agentId,
    requestedHeartbeat: opts.heartbeat,
    source: wakeSource,
    mergeRequestedHeartbeat: wakeSource === "cron",
  });
  const scheduledTasks = [...(opts.tasks ?? [])].toSorted((left, right) =>
    left.jobId.localeCompare(right.jobId),
  );
  const allowsUnscheduledTarget =
    isTargetedUnscheduledWake(opts) && isConfiguredHeartbeatAgent(cfg, agentId);
  if (!areHeartbeatsEnabled()) {
    return { kind: "skipped", reason: "disabled" } as const;
  }
  if (!allowsUnscheduledTarget && !isHeartbeatEnabledForAgent(cfg, agentId)) {
    return { kind: "skipped", reason: "disabled" } as const;
  }
  if (!allowsUnscheduledTarget && !resolveHeartbeatIntervalMs(cfg, undefined, heartbeat)) {
    return { kind: "skipped", reason: "disabled" } as const;
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  // Cron uses the heartbeat runner as execution transport; heartbeat scheduling windows do not own it.
  if (
    !allowsUnscheduledTarget &&
    wakeSource !== "cron" &&
    !isWithinActiveHours(cfg, heartbeat, startedAt)
  ) {
    // Documented observable skip (`system heartbeat last` / troubleshooting
    // docs promise reason=quiet-hours); every sibling skip past this point
    // emits, so a silent return here hides the window from operators.
    emitHeartbeatEvent({
      status: "skipped",
      reason: "quiet-hours",
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: "quiet-hours" } as const;
  }

  const shouldInspectExecWakeBeforeBusy = shouldPreflightExecEventWake(
    wakeSource,
    opts.scheduledEveryMs,
    scheduledTasks.length,
  );
  const resolvePreflight = () =>
    resolveHeartbeatPreflight({
      ...opts,
      cfg,
      agentId,
      heartbeat,
      source: wakeSource,
      scheduledTasks,
    });
  let preflight = shouldInspectExecWakeBeforeBusy ? await resolvePreflight() : undefined;
  if (preflight?.skipReason) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: preflight.skipReason,
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: preflight.skipReason } as const;
  }

  const getSize = opts.deps?.getQueueSize ?? getQueueSize;
  if (getSize(CommandLane.Main) > 0) {
    return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
  }

  // Ignore only the exact Cron lane task that owns this wake. Other queued or active
  // Cron work and all CronNested work remain busy signals.
  const owningCronJobMarker = opts.owningCronJobMarker;
  const ownsActiveCronRun = owningCronJobMarker
    ? isCronActiveJobMarkerCurrent(owningCronJobMarker)
    : false;
  const cronBusy =
    ownsActiveCronRun && owningCronJobMarker
      ? hasActiveCronJobsExceptMarker(owningCronJobMarker)
      : hasActiveCronJobs();
  const owningCronLaneTaskMarker = opts.owningCronLaneTaskMarker;
  const ownsCronLaneTask =
    ownsActiveCronRun &&
    owningCronLaneTaskMarker?.lane === CommandLane.Cron &&
    isCommandLaneTaskMarkerCurrent(owningCronLaneTaskMarker);
  const cronLaneDepth = getSize(CommandLane.Cron);
  // HookDispatch is included so moving hook agent runs off `cron-nested` onto
  // their own lane does not silently stop them from suppressing heartbeats.
  // They are still active agent work; only the lane they occupy changed.
  const cronLaneBusy =
    cronLaneDepth > (ownsCronLaneTask ? 1 : 0) ||
    getSize(CommandLane.CronNested) > 0 ||
    getSize(CommandLane.HookDispatch) > 0;
  if (cronBusy || cronLaneBusy) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS } as const;
  }

  const shouldHonorActiveReplyRuns = opts.intent !== "immediate" && opts.intent !== "manual";
  const listActiveReplyRuns =
    opts.deps?.listActiveReplyRunSessionKeys ?? listActiveReplyRunSessionKeys;
  const listActiveEmbeddedRuns =
    opts.deps?.listActiveEmbeddedRunSessionKeys ?? listActiveEmbeddedRunSessionKeys;
  // Scheduled heartbeats are background work, so defer them when any session on
  // the same agent is already replying; immediate/manual wakes keep their
  // existing semantics for explicit user/system actions.
  if (
    shouldHonorActiveReplyRuns &&
    (hasActiveRunForAgent(agentId, listActiveReplyRuns) ||
      hasActiveRunForAgent(agentId, listActiveEmbeddedRuns))
  ) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
  }

  // Phase 2: Stronger heartbeat deferral while a final delivery replay is pending.
  // Plain `updatedAt` changes are normal for heartbeat sessions and should not
  // suppress heartbeat runs; only defer when final delivery recovery is active.
  const { sessionKey: recentSessionKey, entry: recentSessionEntry } = resolveHeartbeatSession(
    cfg,
    agentId,
    heartbeat,
    opts.sessionKey,
  );
  // Recovery can already have admitted its owner and cleared the abort flag;
  // automatic and sentinel wakes must honor that canonical lifecycle fence.
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const mainSessionRecovery =
    opts.intent !== "manual" && recentSessionEntry
      ? transitionMainSessionRecovery(recentSessionEntry, {
          kind: "inspect",
          lifecycleGeneration,
          sessionKey: recentSessionKey,
        })
      : undefined;
  const activeRestartRecoveryRunId = normalizeOptionalString(
    recentSessionEntry?.restartRecoveryDeliveryRunId,
  );
  // Delivery ownership can outlive the recovery aggregate. Only the matching
  // run from this gateway generation may defer an automatic heartbeat.
  const hasCurrentRestartRecoveryDelivery =
    opts.intent !== "manual" &&
    activeRestartRecoveryRunId !== undefined &&
    recentSessionEntry?.restartRecoveryRuns?.some(
      (run) =>
        run.runId === activeRestartRecoveryRunId && run.lifecycleGeneration === lifecycleGeneration,
    ) === true;
  if (
    (mainSessionRecovery?.kind === "observed" &&
      (mainSessionRecovery.view.status === "blocked" ||
        mainSessionRecovery.view.status === "recoverable")) ||
    hasCurrentRestartRecoveryDelivery
  ) {
    return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
  }
  const HEARTBEAT_DEFER_WINDOW_MS = 30_000;
  const pendingFinalDeliveryText =
    recentSessionEntry?.pendingFinalDelivery?.kind === "replayable"
      ? recentSessionEntry.pendingFinalDelivery.text
      : undefined;
  const pendingFinalDeliveryIsHeartbeatAck =
    typeof pendingFinalDeliveryText === "string" &&
    isHeartbeatAcknowledgementText(pendingFinalDeliveryText);
  if (
    recentSessionEntry?.pendingFinalDelivery !== undefined &&
    !pendingFinalDeliveryIsHeartbeatAck &&
    recentSessionEntry?.updatedAt &&
    startedAt - recentSessionEntry.updatedAt < HEARTBEAT_DEFER_WINDOW_MS
  ) {
    return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
  }

  // Preflight centralizes trigger classification, event inspection, and monitor-scratch gating.
  if (!preflight) {
    preflight = await resolvePreflight();
  }
  if (preflight.skipReason) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: preflight.skipReason,
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: preflight.skipReason } as const;
  }
  const { sessionKey } = preflight.session;
  const isReplyRunActive =
    opts.deps?.isReplyRunActive ?? ((key: string) => replyRunRegistry.isActive(key));
  if (isReplyRunActive(sessionKey) || hasActiveRunForSession(sessionKey, listActiveEmbeddedRuns)) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
  }

  // Check the resolved session lane — if it is busy, skip to avoid interrupting
  // an active streaming turn.  The wake-layer retry (heartbeat-wake.ts) will
  // re-schedule this wake automatically.  See #14396 (closed without merge).
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey);
  if (getSize(sessionLaneKey) > 0) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
  }

  return {
    kind: "ready",
    cfg,
    agentId,
    wakeSource,
    heartbeat,
    scheduledTasks,
    startedAt,
    listActiveEmbeddedRuns,
    isReplyRunActive,
    preflight,
  } as const;
}

type StageResult<T, K extends string> = Extract<Awaited<T>, { kind: K }>;
export type ReadyHeartbeatWake = StageResult<ReturnType<typeof resolveHeartbeatWakeStage>, "ready">;

export async function prepareHeartbeatRunStage(wake: ReadyHeartbeatWake) {
  const { cfg, agentId, heartbeat, preflight } = wake;
  const { scheduledTasks, startedAt } = wake;
  const { listActiveEmbeddedRuns, isReplyRunActive } = wake;
  const { entry, sessionKey } = preflight.session;
  const previousUpdatedAt = entry?.updatedAt;

  // When isolatedSession is enabled, create a fresh session via the same
  // pattern as cron sessionTarget: "isolated". This gives the heartbeat
  // a new session ID (empty transcript) each run, avoiding the cost of
  // sending the full conversation history (~100K tokens) to the LLM.
  // Delivery routing still uses the main session entry (lastChannel, lastTo).
  const useIsolatedSession = heartbeat?.isolatedSession === true;
  const delivery = await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg,
    agentId,
    entry,
    heartbeat,
    currentSessionKey: sessionKey,
    // Isolated heartbeat runs drain system events from their dedicated
    // `:heartbeat` session, not from the base session we peek during preflight.
    // Reusing base-session turnSource routing here can pin later isolated runs
    // to stale channels/threads because that base-session event context remains queued.
    turnSource: useIsolatedSession ? undefined : preflight.turnSourceDeliveryContext,
  });
  // Routeless ambient polls are pure model burn, but only they may skip:
  // triggered wakes (hook/manual/cron/exec), polls with queued events, and
  // scheduled-task wakes must still run to process their payloads even when
  // the reply cannot deliver. An absent source is the plain scheduled poll.
  if (
    delivery.channel === "none" &&
    delivery.reason === "no-route" &&
    (wake.wakeSource === undefined || wake.wakeSource === "interval") &&
    preflight.pendingEventEntries.length === 0 &&
    scheduledTasks.length === 0
  ) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "no-route",
      durationMs: Date.now() - startedAt,
    });
    return { kind: "skipped", reason: "no-route" } as const;
  }
  const heartbeatAccountId = heartbeat?.accountId?.trim();
  if (delivery.reason === "unknown-account") {
    log.warn("heartbeat: unknown accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId ?? null,
      target: heartbeat?.target ?? "owner",
    });
  } else if (heartbeatAccountId) {
    log.info("heartbeat: using explicit accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId,
      target: heartbeat?.target ?? "owner",
      channel: delivery.channel,
    });
  }
  const visibility =
    delivery.channel !== "none"
      ? resolveHeartbeatVisibility({
          cfg,
          channel: delivery.channel,
          accountId: delivery.accountId,
        })
      : { showOk: false, showAlerts: true, useIndicator: true };
  const { sender } = resolveHeartbeatSenderContext({ cfg, entry, delivery });
  const replyPrefix = createReplyPrefixContext({
    cfg,
    agentId,
    channel: delivery.channel !== "none" ? delivery.channel : undefined,
    accountId: delivery.accountId,
  });
  const canRelayToUser = Boolean(
    delivery.channel !== "none" && delivery.to && visibility.showAlerts,
  );
  let useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({
    cfg,
    agentId,
    heartbeat,
    entry,
    sessionKey,
    chatType: delivery.chatType,
  });
  let heartbeatRunPrompt = resolveHeartbeatRunPrompt({
    cfg,
    heartbeat,
    preflight,
    canRelayToUser,
    startedAt,
    scheduledTasks,
    heartbeatScratchContent: preflight.heartbeatScratchContent,
    useHeartbeatResponseTool: useHeartbeatResponseToolPrompt,
  });

  let runSessionKey = sessionKey;
  let runSessionEntry = entry;
  let outboundPolicySessionKey: string | undefined;
  if (useIsolatedSession) {
    const configuredSession = resolveHeartbeatSession(cfg, agentId, heartbeat);
    // Collapse only the repeated `:heartbeat` suffixes introduced by wake-triggered
    // re-entry for heartbeat-created isolated sessions. Real session keys that
    // happen to end with `:heartbeat` still get a distinct isolated sibling.
    const { isolatedSessionKey, isolatedBaseSessionKey } = resolveIsolatedHeartbeatSessionKey({
      agentId,
      sessionKey,
      configuredSessionKey: configuredSession.sessionKey,
      sessionEntry: entry,
    });
    const isolatedStorePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const staleIsolatedSessionKey = resolveStaleHeartbeatIsolatedSessionKey({
      sessionKey,
      isolatedSessionKey,
      isolatedBaseSessionKey,
    });
    if (
      isReplyRunActive(isolatedSessionKey) ||
      hasActiveRunForSession(isolatedSessionKey, listActiveEmbeddedRuns)
    ) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
        durationMs: Date.now() - startedAt,
      });
      return { kind: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
    }
    const staleIsolatedEntry = staleIsolatedSessionKey
      ? loadExactSessionEntry({
          storePath: isolatedStorePath,
          sessionKey: staleIsolatedSessionKey,
        })?.entry
      : undefined;
    const removals: SessionEntryLifecycleRemoval[] = staleIsolatedSessionKey
      ? [
          {
            sessionKey: staleIsolatedSessionKey,
            ...(staleIsolatedEntry ? { expectedEntry: staleIsolatedEntry } : {}),
            ...(staleIsolatedEntry?.sessionId
              ? { expectedSessionId: staleIsolatedEntry.sessionId }
              : {}),
            archiveRemovedTranscript: true,
          },
        ]
      : [];
    const lifecycleResult = await applySessionEntryLifecycleMutation({
      activeSessionKey: isolatedSessionKey,
      storePath: isolatedStorePath,
      removals,
      upserts: [
        {
          sessionKey: isolatedSessionKey,
          buildEntry: ({ store }) => {
            const cronSession = resolveCronSession({
              cfg,
              sessionKey: isolatedSessionKey,
              agentId,
              nowMs: startedAt,
              forceNew: true,
              store,
            });
            const nextEntry = {
              ...cronSession.sessionEntry,
              heartbeatIsolatedBaseSessionKey: isolatedBaseSessionKey,
            };
            runSessionEntry = nextEntry;
            return nextEntry;
          },
        },
      ],
      captureArtifactCleanupError: true,
    });
    if (lifecycleResult.artifactCleanupError) {
      log.warn("heartbeat: failed to archive stale isolated session transcript", {
        err: formatErrorMessage(lifecycleResult.artifactCleanupError),
        sessionKey: staleIsolatedSessionKey,
      });
    }
    runSessionKey = isolatedSessionKey;
    outboundPolicySessionKey = isolatedBaseSessionKey;

    const actualUseHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({
      cfg,
      agentId,
      heartbeat,
      entry: runSessionEntry,
      sessionKey: runSessionKey,
      chatType: delivery.chatType,
    });
    if (actualUseHeartbeatResponseToolPrompt !== useHeartbeatResponseToolPrompt) {
      useHeartbeatResponseToolPrompt = actualUseHeartbeatResponseToolPrompt;
      heartbeatRunPrompt = resolveHeartbeatRunPrompt({
        cfg,
        heartbeat,
        preflight,
        canRelayToUser,
        startedAt,
        scheduledTasks,
        heartbeatScratchContent: preflight.heartbeatScratchContent,
        useHeartbeatResponseTool: useHeartbeatResponseToolPrompt,
      });
    }
  }
  const { hasExecCompletion, hasCronEvents } = heartbeatRunPrompt;
  return {
    kind: "ready",
    ...preflight.session,
    previousUpdatedAt,
    delivery,
    visibility,
    sender,
    replyPrefix,
    runSessionKey,
    outboundPolicySessionKey,
    ...heartbeatRunPrompt,
    inspectedSystemEventsToConsume: selectSystemEventsConsumedByHeartbeat({
      preflight,
      hasExecCompletion,
      hasCronEvents,
    }),
  } as const;
}

export type PreparedHeartbeatRun = StageResult<
  ReturnType<typeof prepareHeartbeatRunStage>,
  "ready"
>;

export async function invokeHeartbeatAgentRun(
  opts: HeartbeatRunOptions,
  wake: ReadyHeartbeatWake,
  prepared: PreparedHeartbeatRun,
) {
  const { cfg, agentId, heartbeat, startedAt, preflight } = wake;
  const { delivery, hasExecCompletion, hasCronEvents, prompt } = prepared;
  const { replyPrefix, runSessionKey, sender, suppressOriginatingContext } = prepared;
  const { usesHeartbeatResponseTool } = prepared;
  const replyOperationRunState: ReplyOperationRunState = {};
  const heartbeatModelOverride = normalizeOptionalString(heartbeat?.model);
  const getReplyFromConfig =
    opts.deps?.getReplyFromConfig ?? (await loadHeartbeatRunnerRuntime()).getReplyFromConfig;
  const heartbeatWakeAbortSignal = getHeartbeatWakeAbortSignal();
  const replyOpts = {
    isHeartbeat: true,
    [REPLY_OPERATION_RUN_STATE]: replyOperationRunState,
    ...(heartbeatModelOverride ? { heartbeatModelOverride } : {}),
    suppressToolErrorWarnings: false,
    ...(usesHeartbeatResponseTool ? { enableHeartbeatTool: true, forceHeartbeatTool: true } : {}),
    ...(usesHeartbeatResponseTool ? { sourceReplyDeliveryMode: "message_tool_only" as const } : {}),
    ...(heartbeatWakeAbortSignal ? { abortSignal: heartbeatWakeAbortSignal } : {}),
    // Heartbeat timeout is a per-run override so user turns keep the global default.
    timeoutOverrideSeconds: resolveHeartbeatTimeoutOverrideSeconds(cfg, heartbeat),
    bootstrapContextMode: heartbeat?.lightContext === true ? ("lightweight" as const) : undefined,
    onModelSelected: replyPrefix.onModelSelected,
  };
  const replyResult = await getReplyFromConfig(
    {
      Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
      From: sender,
      To: sender,
      OriginatingChannel:
        !suppressOriginatingContext && delivery.channel !== "none" ? delivery.channel : undefined,
      OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
      AccountId: delivery.accountId,
      MessageThreadId: delivery.threadId,
      Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "heartbeat",
      SessionKey: runSessionKey,
      AgentId: agentId,
    },
    replyOpts,
    cfg,
  );
  const agentTurnStatus = resolveReplyOperationAgentTurn(replyOperationRunState);
  if (agentTurnStatus === "superseded" || agentTurnStatus === "cancelled") {
    return { kind: agentTurnStatus === "superseded" ? "preempted" : "cancelled" } as const;
  }
  const heartbeatToolResponse = resolveHeartbeatToolResponseFromReplyResult(replyResult);
  const heartbeatScratchProposal = resolveHeartbeatScratchProposalFromReplyResult(replyResult);
  const heartbeatTerminalToolFailure: HeartbeatTerminalToolFailure | undefined =
    resolveHeartbeatTerminalToolFailure(replyResult);
  const replyPayload = resolveHeartbeatReplyPayload(replyResult);
  const agentRunFailed = agentTurnStatus === "failed";
  if (
    heartbeatScratchProposal !== undefined &&
    heartbeatToolResponse &&
    !heartbeatTerminalToolFailure
  ) {
    if (!preflight.scratchJobId) {
      log.warn("heartbeat: scratch update ignored because no monitor job exists");
    } else {
      try {
        const scratchWrite = writeCronJobScratch({
          storePath: resolveCronJobsStorePathFromConfig(cfg),
          jobId: preflight.scratchJobId,
          content: heartbeatScratchProposal,
          expectedRevision: preflight.scratchRevision ?? 0,
        });
        if (!scratchWrite.ok) {
          log.warn("heartbeat: scratch update lost a concurrent revision race");
        }
      } catch (error) {
        log.warn(`heartbeat: scratch update failed: ${formatErrorMessage(error)}`);
      }
    }
  }
  if (
    !heartbeatToolResponse &&
    (!replyPayload || !hasOutboundReplyContent(replyPayload)) &&
    replyOperationRunState.admission?.status === "skipped" &&
    replyOperationRunState.admission.reason === "active-run"
  ) {
    return { kind: "busy" } as const;
  }
  return {
    kind: "completed",
    heartbeatToolResponse,
    heartbeatTerminalToolFailure,
    agentRunFailed,
    replyPayload,
  } as const;
}

export type CompletedHeartbeatAgentRun = StageResult<
  ReturnType<typeof invokeHeartbeatAgentRun>,
  "completed"
>;
