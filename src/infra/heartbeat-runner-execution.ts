import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listActiveEmbeddedRunSessionKeys } from "../agents/embedded-agent-runner/active-run-projections.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { transitionMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-state.js";
import { isHeartbeatAcknowledgementText } from "../auto-reply/heartbeat.js";
import {
  listActiveReplyRunSessionKeys,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.public.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  applySessionEntryLifecycleMutation,
  loadExactSessionEntry,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasActiveCronJobs,
  hasActiveCronJobsExceptMarkers,
  listCronHeartbeatWaitOwners,
} from "../cron/active-jobs.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { getQueueSize, isCommandLaneTaskMarkerCurrent } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { formatErrorMessage } from "./errors.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import {
  heartbeatLog as log,
  resolveHeartbeatForWake,
  shouldUseHeartbeatResponseToolPrompt,
  tryResolveAmbientHeartbeatAgentId,
  type HeartbeatConfig,
} from "./heartbeat-runner-config.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
  shouldPreflightWakeBeforeBusy,
} from "./heartbeat-runner-prompt.js";
import {
  resolveHeartbeatSession,
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

const CRON_COMMAND_LANE: string = CommandLane.Cron;

export type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("../auto-reply/reply/get-reply.js").getReplyFromConfig;
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    isReplyRunActive?: (sessionKey: string) => boolean;
    listActiveReplyRunSessionKeys?: () => readonly string[];
    listActiveEmbeddedRunSessionKeys?: () => readonly string[];
    nowMs?: () => number;
  };

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

function skippedHeartbeatStage<T extends string>(reason: T, startedAt: number) {
  emitHeartbeatEvent({
    status: "skipped",
    reason,
    durationMs: Date.now() - startedAt,
  });
  return { kind: "skipped", reason } as const;
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
    return skippedHeartbeatStage("quiet-hours", startedAt);
  }

  const shouldPreflightBeforeBusy = shouldPreflightWakeBeforeBusy(
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
  let preflight = shouldPreflightBeforeBusy ? await resolvePreflight() : undefined;
  if (preflight?.skipReason) {
    return skippedHeartbeatStage(preflight.skipReason, startedAt);
  }

  const getSize = opts.deps?.getQueueSize ?? getQueueSize;
  if (getSize(CommandLane.Main) > 0) {
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
  }

  // Cron executions awaiting heartbeat settlement are idle owners, not competing work.
  // Keep unrelated Cron work and all CronNested work as busy signals.
  const heartbeatWaitOwners = listCronHeartbeatWaitOwners();
  const cronBusy =
    heartbeatWaitOwners.activeJobMarkers.length > 0
      ? hasActiveCronJobsExceptMarkers(heartbeatWaitOwners.activeJobMarkers)
      : hasActiveCronJobs();
  const owningCronLaneTaskIds = new Set(
    heartbeatWaitOwners.owningCronLaneTaskMarkers
      .filter(
        (marker) => marker.lane === CRON_COMMAND_LANE && isCommandLaneTaskMarkerCurrent(marker),
      )
      .map((marker) => marker.taskId),
  );
  const cronLaneDepth = getSize(CommandLane.Cron);
  // HookDispatch is included so moving hook agent runs off `cron-nested` onto
  // their own lane does not silently stop them from suppressing heartbeats.
  // They are still active agent work; only the lane they occupy changed.
  const cronLaneBusy =
    cronLaneDepth > owningCronLaneTaskIds.size ||
    getSize(CommandLane.CronNested) > 0 ||
    getSize(CommandLane.HookDispatch) > 0;
  if (cronBusy || cronLaneBusy) {
    return skippedHeartbeatStage(HEARTBEAT_SKIP_CRON_IN_PROGRESS, startedAt);
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
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
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
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
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
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
  }

  // Preflight centralizes trigger classification, event inspection, and monitor-scratch gating.
  if (!preflight) {
    preflight = await resolvePreflight();
  }
  if (preflight.skipReason) {
    return skippedHeartbeatStage(preflight.skipReason, startedAt);
  }
  const { sessionKey } = preflight.session;
  const isReplyRunActive =
    opts.deps?.isReplyRunActive ?? ((key: string) => replyRunRegistry.isActive(key));
  if (isReplyRunActive(sessionKey) || hasActiveRunForSession(sessionKey, listActiveEmbeddedRuns)) {
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
  }

  // Check the resolved session lane — if it is busy, skip to avoid interrupting
  // an active streaming turn.  The wake-layer retry (heartbeat-wake.ts) will
  // re-schedule this wake automatically.  See #14396 (closed without merge).
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey);
  if (getSize(sessionLaneKey) > 0) {
    return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
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
  const { entry, sessionKey, run, conversationEntry } = preflight.session;
  const previousUpdatedAt = entry?.updatedAt;

  // When isolatedSession is enabled, create a fresh session via the same
  // pattern as cron sessionTarget: "isolated". This gives the heartbeat
  // a new session ID (empty transcript) each run, avoiding the cost of
  // sending the full conversation history (~100K tokens) to the LLM.
  // Delivery routing uses the selected conversation, not the fresh execution row.
  const delivery = await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg,
    agentId,
    entry: conversationEntry,
    heartbeat,
    currentSessionKey: sessionKey,
    // A base queue's route stays excluded; events on the actual isolated queue
    // own their route, including exec completion after the base route moves.
    turnSource: preflight.session.inspectsRunQueue
      ? preflight.turnSourceDeliveryContext
      : undefined,
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
    return skippedHeartbeatStage("no-route", startedAt);
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

  const runSessionKey = run.sessionKey;
  let runSessionEntry = entry;
  let outboundPolicySessionKey: string | undefined;
  if (run.kind === "isolated") {
    const { sessionKey: isolatedSessionKey, baseSessionKey: isolatedBaseSessionKey } = run;
    const isolatedStorePath = preflight.session.storePath;
    // The follow-up still needs the legacy row's explicit base binding for its original queue.
    const staleIsolatedSessionKey =
      heartbeatRunPrompt.hasExecCompletion && heartbeatRunPrompt.hasCronEvents
        ? undefined
        : resolveStaleHeartbeatIsolatedSessionKey({
            sessionKey,
            isolatedSessionKey,
            isolatedBaseSessionKey,
          });
    if (
      isReplyRunActive(isolatedSessionKey) ||
      hasActiveRunForSession(isolatedSessionKey, listActiveEmbeddedRuns)
    ) {
      return skippedHeartbeatStage(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, startedAt);
    }
    const staleIsolatedEntry = staleIsolatedSessionKey
      ? loadExactSessionEntry({
          agentId,
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
      agentId,
      activeSessionKey: isolatedSessionKey,
      storePath: isolatedStorePath,
      removals,
      upserts: [
        {
          // Seed next-user context only for conversation bases, never absent transient cron runs.
          sessionKey: isolatedBaseSessionKey,
          buildEntry: ({ currentEntry, sessionKey: baseSessionKey }) =>
            currentEntry || isCronRunSessionKey(baseSessionKey)
              ? undefined
              : mergeSessionEntry(undefined, { updatedAt: startedAt }),
        },
        {
          sessionKey: isolatedSessionKey,
          buildEntry: ({ currentEntry }) => {
            const cronSession = resolveCronSession({
              cfg,
              sessionKey: isolatedSessionKey,
              agentId,
              nowMs: startedAt,
              forceNew: true,
              store: currentEntry ? { [isolatedSessionKey]: currentEntry } : {},
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
  return {
    kind: "ready",
    ...preflight.session,
    previousUpdatedAt,
    policySessionEntry:
      outboundPolicySessionKey && (outboundPolicySessionKey !== sessionKey || !entry)
        ? loadExactSessionEntry({
            agentId,
            storePath: preflight.session.storePath,
            sessionKey: outboundPolicySessionKey,
          })?.entry
        : entry,
    delivery,
    visibility,
    sender,
    replyPrefix,
    runSessionKey,
    outboundPolicySessionKey,
    ...heartbeatRunPrompt,
  } as const;
}

export type PreparedHeartbeatRun = StageResult<
  ReturnType<typeof prepareHeartbeatRunStage>,
  "ready"
>;
