// Gateway cron runtime service runs scheduled agent turns, heartbeat wakeups,
// plugin hooks, notifications, and cron lifecycle cleanup.
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { abortAndDrainEmbeddedAgentRun } from "../agents/embedded-agent.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildCronCommandSummary,
  redactCronCommandSummaryForExternalDelivery,
} from "../cron/command-output-summary.js";
import { runCronCommandJob } from "../cron/command-runner.js";
import { resolveCronStoredDeliveryContext } from "../cron/delivery-context.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import { toPublicCronJob } from "../cron/public-job.js";
import { resolveCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { CronService, type CronEvent } from "../cron/service.js";
import {
  abortActiveCronTaskRuns,
  waitForActiveCronTaskRuns,
} from "../cron/service/active-run-cancellation.js";
import { applyJobPatch } from "../cron/service/jobs.js";
import {
  resolveCronDeliverySessionKey,
  resolveCronSessionTargetSessionKey,
} from "../cron/session-target.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStreamScheduleKey } from "../cron/stream-schedule.js";
import { createCronScriptRuntime } from "../cron/trigger-script.js";
import type {
  CronJob,
  CronPayload,
  CronRunErrorClassification,
  CronTriggerFailureCode,
} from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveMainScopedEventSessionKey } from "../infra/event-session-routing.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
} from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type {
  PluginHookCronChangedEvent,
  PluginHookGatewayCronJob,
  PluginHookGatewayCronService,
  PluginHookGatewayContext,
} from "../plugins/hook-types.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  normalizeAgentId,
  resolveEventSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { createCronExitWatchers, type CronExitResult } from "./cron-exit-watchers.js";
import {
  createCronStreamWatchers,
  type CronStreamFireDisposition,
  resolveStreamStopReason,
} from "./cron-stream-watchers.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import { reconcileHeartbeatMonitorJobs } from "./server-cron-heartbeat-jobs.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";
import {
  bumpSessionAutomationVersion,
  claimSessionAutomationEpoch,
  registerSessionAutomationSource,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";
import { loadGatewaySessionRow } from "./session-utils.js";

export type GatewayCronState = {
  cron: GatewayCronServiceContract;
  storePath: string;
  cronEnabled: boolean;
  reconcileExitWatchers?: () => Promise<void>;
  stopExitWatchers?: () => void;
  reconcileStreamWatchers?: () => Promise<void>;
  stopStreamWatchers?: () => Promise<void>;
  reconcileHeartbeatJobs?: (cfg?: OpenClawConfig) => Promise<void>;
};

function classifyCronScriptFailure(code: CronTriggerFailureCode): CronRunErrorClassification {
  if (code === "timeout") {
    return { kind: "reason", reason: "timeout" };
  }
  if (code === "runtime_unavailable") {
    return { kind: "reason", reason: "server_error" };
  }
  return { kind: "permanent" };
}

function formatOnExitRunSummary(exit: CronExitResult): string {
  const lines = [
    "Watched command finished.",
    `Exit code: ${exit.exitCode ?? "none"}`,
    `Reason: ${exit.reason}`,
  ];
  const output = buildCronCommandSummary({ stdout: exit.stdout, stderr: exit.stderr });
  return output ? `${lines.join("\n")}\n\nOutput:\n${output}` : lines.join("\n");
}

function addOnExitRunSummary(payload: CronPayload, exit: CronExitResult): CronPayload {
  const summary = formatOnExitRunSummary(exit);
  if (payload.kind === "systemEvent") {
    return { ...payload, text: `${payload.text}\n\n${summary}` };
  }
  if (payload.kind === "agentTurn") {
    return { ...payload, message: `${payload.message}\n\n${summary}` };
  }
  return payload;
}

/**
 * On-exit jobs use the normal force-run path so every payload kind records
 * run state, history, notifications, and delivery outcomes consistently.
 */
export async function fireOnExitJob(
  job: CronJob,
  exit: CronExitResult,
  deps: {
    run: (jobId: string, payload?: CronPayload) => Promise<unknown>;
  },
): Promise<void> {
  const payload = addOnExitRunSummary(job.payload, exit);
  await deps.run(job.id, payload === job.payload ? undefined : payload);
}

/** Fire one source batch through the normal trigger and payload pipeline. */
export async function fireStreamJob(
  job: CronJob,
  deps: {
    // No payload override: cron.run snapshots the persisted payload under its
    // admission lock, so a batch never executes the owner's stale cache.
    run: (
      jobId: string,
      onDisposition: (disposition: Exclude<CronStreamFireDisposition, "not-run">) => void,
    ) => Promise<{ ok: boolean; ran?: boolean; reason?: string; enabled?: boolean }>;
  },
): Promise<CronStreamFireDisposition> {
  let disposition: Exclude<CronStreamFireDisposition, "not-run"> | undefined;
  const result = await deps.run(job.id, (value) => {
    disposition = value;
  });
  if (!disposition && result.ok && result.ran === false && result.reason === "already-running") {
    return "busy";
  }
  if (disposition === "fired" && result.enabled === false) {
    return "disabled";
  }
  return disposition ?? (result.ok && result.ran === true ? "fired" : "not-run");
}

function reconcileCronExitWatchers(params: {
  cronEnabled: boolean;
  exitWatchers: ReturnType<typeof createCronExitWatchers>;
  jobs: CronJob[];
}) {
  if (!params.cronEnabled) {
    params.exitWatchers.cancelAll();
    return;
  }
  params.exitWatchers.reconcile(params.jobs);
}

/** Pick only the keys whose values are not `undefined` from an object. */
function pickDefined<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<Pick<T, (typeof keys)[number]>> {
  const result: Partial<Pick<T, (typeof keys)[number]>> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) {
      (result as Record<string, unknown>)[k as string] = obj[k];
    }
  }
  return result;
}

function omitExplicitHeartbeatDestination(
  heartbeat: AgentDefaultsConfig["heartbeat"] | undefined,
): AgentDefaultsConfig["heartbeat"] | undefined {
  if (!heartbeat) {
    return undefined;
  }
  return {
    ...heartbeat,
    to: undefined,
    accountId: undefined,
  };
}

function sanitizeCronHeartbeatOverride(
  heartbeat: AgentDefaultsConfig["heartbeat"] | undefined,
): AgentDefaultsConfig["heartbeat"] | undefined {
  return heartbeat?.target === "last" ? omitExplicitHeartbeatDestination(heartbeat) : heartbeat;
}

/** Map internal CronJob to the public plugin SDK shape. */
function toPluginCronJob(job: CronJob): PluginHookGatewayCronJob {
  return {
    id: job.id,
    agentId: job.agentId,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    schedule: job.schedule ? structuredClone(job.schedule) : undefined,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload ? structuredClone(job.payload) : undefined,
    state: {
      nextRunAtMs: job.state.nextRunAtMs,
      runningAtMs: job.state.runningAtMs,
      lastRunAtMs: job.state.lastRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
      lastError: job.state.lastError,
      lastDurationMs: job.state.lastDurationMs,
      lastDelivered: job.state.lastDelivered,
      lastDeliveryStatus: job.state.lastDeliveryStatus,
      lastDeliveryError: job.state.lastDeliveryError,
      lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
      lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
      lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
      streamStatus: job.state.streamStatus,
      streamError: job.state.streamError,
      streamConsecutiveFailures: job.state.streamConsecutiveFailures,
      streamRestartExhausted: job.state.streamRestartExhausted,
      streamDroppedBatches: job.state.streamDroppedBatches,
      streamCoalescedBatches: job.state.streamCoalescedBatches,
      streamLastStartedAtMs: job.state.streamLastStartedAtMs,
      streamLastExitAtMs: job.state.streamLastExitAtMs,
    },
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
  };
}

function isCommandCronJob(job: CronJob | null | undefined): boolean {
  return job?.payload?.kind === "command";
}

const CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS = 10_000;

/** Build the cron service state used by Gateway startup and lazy cron loading. */
export function buildGatewayCronService(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  env?: NodeJS.ProcessEnv;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const cronEnabled = env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const findAgentEntry = (cfg: OpenClawConfig, agentId: string) =>
    listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === agentId);

  const hasConfiguredAgent = (cfg: OpenClawConfig, agentId: string) =>
    Boolean(findAgentEntry(cfg, agentId));

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = getRuntimeConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const defaultAgentId = resolveDefaultAgentId(runtimeConfig);
    if (
      normalized !== undefined &&
      normalized !== defaultAgentId &&
      !hasConfiguredAgent(runtimeConfig, normalized)
    ) {
      throw new Error(`cron job agent is unavailable: ${normalized}`);
    }
    const agentId = normalized ?? defaultAgentId;
    if (isAgentDeletionBlocked(agentId)) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (paramsValue: {
    runtimeConfig: OpenClawConfig;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = paramsValue.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: paramsValue.runtimeConfig,
        agentId: paramsValue.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: paramsValue.agentId,
      requestKey: requested,
      mainKey: paramsValue.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: paramsValue.runtimeConfig,
      agentId: paramsValue.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(paramsValue.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: paramsValue.runtimeConfig,
          agentId: paramsValue.agentId,
        });
      }
    }
    return (
      resolveMainScopedEventSessionKey({
        cfg: paramsValue.runtimeConfig,
        sessionKey: canonical,
        agentId: paramsValue.agentId,
      }) ?? canonical
    );
  };

  const resolveCronTarget = (opts?: {
    agentId?: string | null;
    sessionKey?: string | null;
    preserveUntargeted?: boolean;
  }) => {
    const requestedAgentId =
      typeof opts?.agentId === "string" && opts.agentId.trim()
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const requestedSessionKey =
      typeof opts?.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey : undefined;
    if (opts?.preserveUntargeted && !requestedAgentId && !requestedSessionKey) {
      return { runtimeConfig: getRuntimeConfig(), agentId: undefined, sessionKey: undefined };
    }

    // Derive from canonical agent-prefixed keys only. Relative keys intentionally
    // fall through to the configured default instead of hardcoding "main".
    const derivedAgentId =
      requestedSessionKey && parseAgentSessionKey(requestedSessionKey)
        ? resolveAgentIdFromSessionKey(requestedSessionKey)
        : undefined;
    const { agentId: resolvedAgentId, cfg: runtimeConfig } = resolveCronAgent(
      requestedAgentId ?? derivedAgentId,
    );
    const agentId = resolvedAgentId || undefined;
    const resolvedSessionKey = agentId
      ? resolveCronSessionKey({
          runtimeConfig,
          agentId,
          requestedSessionKey,
        })
      : undefined;
    const sessionKey =
      resolvedSessionKey && runtimeConfig.session?.scope === "global"
        ? resolveEventSessionKey(
            resolvedSessionKey,
            runtimeConfig.session?.mainKey,
            runtimeConfig.session?.scope,
          )
        : resolvedSessionKey;
    return { runtimeConfig, agentId, sessionKey };
  };

  const resolveCronHeartbeatOverride = (paramsLocal: {
    runtimeConfig: OpenClawConfig;
    agentId?: string;
    heartbeat?: AgentDefaultsConfig["heartbeat"];
  }) => {
    if (!paramsLocal.heartbeat) {
      return undefined;
    }
    const agentEntry =
      paramsLocal.agentId !== undefined
        ? findAgentEntry(paramsLocal.runtimeConfig, paramsLocal.agentId)
        : undefined;
    const agentHeartbeat =
      agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
    const baseHeartbeat = {
      ...paramsLocal.runtimeConfig.agents?.defaults?.heartbeat,
      ...agentHeartbeat,
    };
    const heartbeatOverride = { ...baseHeartbeat, ...paramsLocal.heartbeat };
    return sanitizeCronHeartbeatOverride(heartbeatOverride);
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const scriptRuntime =
    params.cfg.cron?.triggers?.enabled === true
      ? createCronScriptRuntime({ config: params.cfg })
      : undefined;

  const runCronChangedHook = (evt: PluginHookCronChangedEvent) => {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("cron_changed")) {
      return;
    }
    const hookCtx: PluginHookGatewayContext = {
      config: getRuntimeConfig(),
      getCron: () => cron as PluginHookGatewayCronService,
    };
    // Hook execution is detached from the cron mutation/tick that emitted it.
    // Keep the whole plugin callback visible until its user-state effects settle.
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      await hookRunner.runCronChanged(evt, hookCtx);
    }).catch((err: unknown) => {
      cronLogger.warn(
        { err: formatErrorMessage(err), jobId: evt.jobId },
        "cron_changed hook failed",
      );
    });
  };

  // Built after cron so watcher exit callbacks can call back into the service.
  const exitWatchersRef: { current: ReturnType<typeof createCronExitWatchers> | undefined } = {
    current: undefined,
  };
  const streamWatchersRef: {
    current: ReturnType<typeof createCronStreamWatchers> | undefined;
  } = { current: undefined };
  let exitWatcherReconciliations = 0;
  let streamWatcherReconciliations = 0;
  const terminalExitCompletionTokens = new Map<string, object>();
  let exitWatcherGeneration = 0;
  let streamWatcherGeneration = 0;
  // Bumped when a direct watcher route begins; fences reconcile's async list
  // snapshot against mutations that commit inside the list await.
  let streamWatcherMutationRevision = 0;
  let streamWatchersStopped = false;
  const reconcileExitWatchers = async () => {
    const generation = exitWatcherGeneration;
    exitWatcherReconciliations += 1;
    try {
      if (!exitWatchersRef.current) {
        return;
      }
      const result = await cron.list({ includeDisabled: true });
      if (generation !== exitWatcherGeneration) {
        return;
      }
      const jobs: CronJob[] = Array.isArray(result) ? result : (result as { jobs: CronJob[] }).jobs;
      const watcherJobs: CronJob[] = [];
      for (const job of jobs) {
        watcherJobs.push(
          terminalExitCompletionTokens.has(job.id) && job.schedule.kind === "on-exit"
            ? { ...job, enabled: true }
            : job,
        );
      }
      reconcileCronExitWatchers({
        cronEnabled,
        exitWatchers: exitWatchersRef.current,
        jobs: watcherJobs,
      });
    } catch (err) {
      cronLogger.warn({ err: String(err) }, "cron-exit: reconcile failed");
    } finally {
      exitWatcherReconciliations -= 1;
    }
  };
  const reconcileStreamWatchers = async () => {
    const generation = streamWatcherGeneration;
    streamWatcherReconciliations += 1;
    try {
      const watchers = streamWatchersRef.current;
      if (!watchers || streamWatchersStopped) {
        return;
      }
      // The list snapshot is captured across an await; a direct mutation route
      // that commits inside that window makes it stale, and reconciling a
      // stale snapshot could stop a just-added owner as "removed" and retire
      // its durable identity. Re-list until no route interleaved. Bounded:
      // under pathological mutation churn we skip this sweep (every mutation
      // was already routed directly) rather than loop forever.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const revision = streamWatcherMutationRevision;
        const result = await cron.list({ includeDisabled: true });
        if (generation !== streamWatcherGeneration || streamWatchersStopped) {
          return;
        }
        if (revision !== streamWatcherMutationRevision) {
          continue;
        }
        const jobs: CronJob[] = Array.isArray(result)
          ? result
          : (result as { jobs: CronJob[] }).jobs;
        await watchers.reconcile(
          jobs,
          cronEnabled && params.cfg.cron?.triggers?.enabled === true,
          params.cfg.cron?.triggers?.enabled === true,
        );
        return;
      }
      cronLogger.warn({}, "cron-stream: reconcile skipped after repeated concurrent mutations");
    } catch (err) {
      cronLogger.warn({ err: String(err) }, "cron-stream: reconcile failed");
    } finally {
      streamWatcherReconciliations -= 1;
    }
  };

  const routeStreamWatcherMutation = async (
    jobId: string,
    job: CronJob | undefined,
    action: "added" | "updated" | "removed" | "finished",
  ) => {
    const watchers = streamWatchersRef.current;
    if (!watchers || streamWatchersStopped) {
      return;
    }
    streamWatcherMutationRevision += 1;
    streamWatcherReconciliations += 1;
    try {
      if (action === "removed") {
        await watchers.stop(jobId, "removed");
        return;
      }
      if (
        job?.schedule.kind === "stream" &&
        job.enabled &&
        !job.state.streamRestartExhausted &&
        cronEnabled &&
        params.cfg.cron?.triggers?.enabled === true
      ) {
        await watchers.start(job);
        return;
      }
      const reason = resolveStreamStopReason({
        triggersEnabled: params.cfg.cron?.triggers?.enabled === true,
        cronEnabled,
        restartExhausted: job?.state.streamRestartExhausted === true,
        isStream: job?.schedule.kind === "stream",
      });
      await watchers.stop(jobId, reason, job);
    } finally {
      streamWatcherReconciliations -= 1;
    }
  };

  // Cron job changes flip session automation badges; push refreshed rows so
  // subscribed session lists update without waiting for unrelated session events.
  const broadcastCronBoundSessionChanges = (evt: CronEvent) => {
    const job = evt.job ?? cron.getJob(evt.jobId);
    if (!job) {
      return;
    }
    const boundKeys = resolveCronJobBoundSessionKeys(job, {
      cfg: getRuntimeConfig(),
      defaultAgentId: cron.getDefaultAgentId(),
    });
    for (const sessionKey of boundKeys) {
      // Emit even without a stored row: clients run a canonical list refresh on
      // every sessions.changed, which also clears badges on prior bindings
      // (e.g. after retargeting a job to a not-yet-created session).
      const sessionRow = loadGatewaySessionRow(sessionKey);
      params.broadcast(
        "sessions.changed",
        {
          sessionKey,
          reason: "cron-binding",
          ts: Date.now(),
          ...(sessionRow ? buildGatewaySessionEventFields({ sessionRow }) : {}),
        },
        { dropIfSlow: true },
      );
    }
  };

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    ...(scriptRuntime
      ? {
          evaluateCronTrigger: ({ job, script, state, streamBatch, abortSignal }) =>
            scriptRuntime.evaluateTrigger({
              jobId: job.id,
              agentId: job.agentId,
              script,
              state,
              streamBatch,
              toolsAllow: job.payload.toolsAllow,
              scheduledToolPolicy: resolveCronScheduledToolPolicy({
                toolsAllow: job.payload.toolsAllow,
                scheduledToolPolicy: job.scheduledToolPolicy,
                owner: job.owner,
              }),
              abortSignal,
            }),
        }
      : {}),
    defaultAgentId,
    resolveDefaultAgentId: () => resolveDefaultAgentId(getRuntimeConfig()),
    isAgentAvailable: (agentId) =>
      !isAgentDeletionBlocked(agentId) &&
      listAgentIds(getRuntimeConfig()).some((id) => normalizeAgentId(id) === agentId),
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { sessionKey } = resolveCronTarget(opts);
      if (!sessionKey) {
        throw new Error("Cron system event target did not resolve a session key.");
      }
      const event = enqueueSystemEventEntry(text, {
        sessionKey,
        contextKey: opts?.contextKey,
        deliveryContext: opts?.deliveryContext,
      });
      return event
        ? {
            accepted: true,
            remove: () => consumeSelectedSystemEventEntries(sessionKey, [event]).length > 0,
          }
        : { accepted: false };
    },
    resolveOriginDeliveryContext: (opts) => {
      // Resolve the wake target the same way the enqueue/heartbeat deps do,
      // then read the channel-correct delivery context from that session's
      // store entry (NOT by string-splitting the composite session key).
      const { runtimeConfig, sessionKey } = resolveCronTarget({
        ...opts,
        preserveUntargeted: true,
      });
      if (!sessionKey) {
        return undefined;
      }
      return resolveCronStoredDeliveryContext({ cfg: runtimeConfig, sessionKey });
    },
    requestHeartbeat: (opts) => {
      const { agentId, sessionKey } = resolveCronTarget({ ...opts, preserveUntargeted: true });
      requestHeartbeat({
        source: opts?.source ?? "cron",
        intent: opts?.intent ?? "event",
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: sanitizeCronHeartbeatOverride(opts?.heartbeat),
        ...(opts?.scheduledEveryMs !== undefined
          ? { scheduledEveryMs: opts.scheduledEveryMs }
          : {}),
        ...(opts?.scheduledAnchorMs !== undefined
          ? { scheduledAnchorMs: opts.scheduledAnchorMs }
          : {}),
        ...(opts.tasks?.length ? { tasks: opts.tasks } : {}),
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronTarget({
        ...opts,
        preserveUntargeted: true,
      });
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        source: opts?.source ?? "cron",
        intent: opts?.intent ?? "event",
        reason: opts?.reason,
        agentId,
        sessionKey,
        // Preserve ownership across this adapter so the wake does not self-block on
        // the cron run that is awaiting it.
        owningCronJobMarker: opts?.owningCronJobMarker,
        owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
        heartbeat: resolveCronHeartbeatOverride({
          runtimeConfig,
          agentId,
          heartbeat: opts?.heartbeat,
        }),
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({
      job,
      message,
      abortSignal,
      onExecutionStarted,
      onExecutionPhase,
      onLaneWait,
    }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`;
      try {
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps: params.deps,
          job,
          message,
          abortSignal,
          onExecutionStarted,
          onExecutionPhase,
          onLaneWait,
          agentId,
          sessionKey,
          lane: "cron",
        });
      } finally {
        await cleanupBrowserSessionsForLifecycleEnd({
          sessionKeys: [sessionKey],
          onWarn: (msg) => cronLogger.warn({ jobId: job.id }, msg),
        });
      }
    },
    runCommandJob: async ({ job, abortSignal }) => {
      const result = await runCronCommandJob({
        job,
        abortSignal,
        nowMs: Date.now,
      });
      const plan = resolveCronDeliveryPlan(job);
      const deliveryTrace = {
        intended: pickDefined(
          {
            channel: plan.channel,
            to: plan.to,
            threadId: plan.threadId,
            accountId: plan.accountId,
            source: "explicit" as const,
          },
          ["channel", "to", "accountId", "threadId", "source"],
        ),
      };
      const summaryIsSilent =
        typeof result.summary === "string" && isSilentReplyText(result.summary, SILENT_REPLY_TOKEN);
      if (summaryIsSilent) {
        const { summary: _summary, ...silentResult } = result;
        return {
          ...silentResult,
          deliveryAttempted: false,
          delivered: false,
          delivery: deliveryTrace,
        };
      }
      const shouldAnnounce =
        plan.mode === "announce" && typeof result.summary === "string" && result.summary.trim();
      if (!shouldAnnounce) {
        return {
          ...result,
          deliveryAttempted: false,
          delivered: false,
          delivery: deliveryTrace,
        };
      }
      const message = isCommandCronJob(job)
        ? redactCronCommandSummaryForExternalDelivery(result.summary)
        : result.summary;
      if (typeof message !== "string") {
        return {
          ...result,
          deliveryAttempted: false,
          delivered: false,
          delivery: deliveryTrace,
        };
      }
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      try {
        await sendCronAnnouncePayloadStrict({
          deps: params.deps,
          cfg: runtimeConfig,
          agentId,
          jobId: job.id,
          target: {
            channel: plan.channel,
            to: plan.to,
            threadId: plan.threadId,
            accountId: plan.accountId,
            sessionKey: resolveCronDeliverySessionKey(job),
          },
          message,
          abortSignal: abortSignal ?? new AbortController().signal,
        });
        return {
          ...result,
          deliveryAttempted: true,
          delivered: true,
          delivery: {
            ...deliveryTrace,
            delivered: true,
          },
        };
      } catch (err) {
        const error = formatErrorMessage(err);
        const requiredDeliveryFailed = job.delivery?.bestEffort === false && result.status === "ok";
        cronLogger.warn({ jobId: job.id, err: error }, "cron: command delivery failed");
        return {
          ...result,
          // Default announce delivery is best-effort, but an explicit
          // bestEffort:false keeps delivery inside the job's success contract.
          status: requiredDeliveryFailed ? ("error" as const) : result.status,
          ...(requiredDeliveryFailed ? { error } : { deliveryError: error }),
          deliveryAttempted: true,
          delivered: false,
          delivery: {
            ...deliveryTrace,
            delivered: false,
            resolved: {
              channel: plan.channel,
              to: plan.to,
              accountId: plan.accountId,
              threadId: plan.threadId,
              source: "explicit" as const,
              ok: false,
              error,
            },
          },
        };
      }
    },
    runScriptJob: async ({ job, streamBatch, abortSignal }) => {
      if (!scriptRuntime || job.payload.kind !== "script") {
        return { status: "error", error: "cron script payload executor is unavailable" };
      }
      const execution = await scriptRuntime.executePayload({
        jobId: job.id,
        agentId: job.agentId,
        script: job.payload.script,
        state: job.state.triggerState,
        streamBatch,
        toolsAllow: job.payload.toolsAllow,
        scheduledToolPolicy: resolveCronScheduledToolPolicy({
          toolsAllow: job.payload.toolsAllow,
          scheduledToolPolicy: job.scheduledToolPolicy,
          owner: job.owner,
        }),
        timeoutSeconds: job.payload.timeoutSeconds,
        toolBudget: job.payload.toolBudget,
        abortSignal,
      });
      if (execution.kind === "error") {
        return {
          status: "error",
          error: `cron script payload failed (${execution.code}): ${execution.error}`,
          errorClassification: classifyCronScriptFailure(execution.code),
        };
      }
      if (execution.nextCheck && !job.pacing) {
        return {
          status: "error",
          error: "cron script payload returned nextCheck, but this job has no pacing bounds",
        };
      }

      const notify = execution.notify?.trim() ? execution.notify : undefined;
      const plan = resolveCronDeliveryPlan(job);
      const deliveryTrace = {
        intended: pickDefined(
          {
            channel: plan.channel,
            to: plan.to,
            accountId: plan.accountId,
            threadId: plan.threadId,
            source: "explicit" as const,
          },
          ["channel", "to", "accountId", "threadId", "source"],
        ),
      };
      const base = {
        status: "ok" as const,
        notify,
        wake: execution.wake,
        stateChanged: execution.stateChanged,
        ...(execution.stateChanged ? { state: execution.state } : {}),
        nextCheck: execution.nextCheck,
        delivery: deliveryTrace,
      };
      if (job.sessionTarget === "main" || plan.mode !== "announce" || !notify) {
        return { ...base, deliveryAttempted: false, delivered: false };
      }

      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      try {
        await sendCronAnnouncePayloadStrict({
          deps: params.deps,
          cfg: runtimeConfig,
          agentId,
          jobId: job.id,
          target: {
            channel: plan.channel,
            to: plan.to,
            threadId: plan.threadId,
            accountId: plan.accountId,
            sessionKey: resolveCronDeliverySessionKey(job),
          },
          message: notify,
          abortSignal: abortSignal ?? new AbortController().signal,
        });
        return {
          ...base,
          deliveryAttempted: true,
          delivered: true,
          delivery: { ...deliveryTrace, delivered: true },
        };
      } catch (err) {
        const error = formatErrorMessage(err);
        cronLogger.warn({ jobId: job.id, err: error }, "cron: script payload delivery failed");
        return {
          ...base,
          status: job.delivery?.bestEffort ? ("ok" as const) : ("error" as const),
          ...(job.delivery?.bestEffort ? { deliveryError: error } : { error }),
          deliveryAttempted: true,
          delivered: false,
          delivery: { ...deliveryTrace, delivered: false },
        };
      }
    },
    cleanupTimedOutAgentRun: async ({ job, execution }) => {
      if (!execution?.sessionId) {
        return;
      }
      const result = await abortAndDrainEmbeddedAgentRun({
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
        settleMs: 15_000,
        forceClear: true,
        reason: "cron_timeout",
      });
      cronLogger.warn(
        {
          jobId: job.id,
          sessionId: execution.sessionId,
          sessionKey: execution.sessionKey,
          aborted: result.aborted,
          drained: result.drained,
          forceCleared: result.forceCleared,
        },
        "cron: cleaned up timed-out agent run",
      );
      await retireSessionMcpRuntime({
        sessionId: execution.sessionId,
        reason: "cron-timeout-cleanup",
        onError: (error, sid) => {
          cronLogger.warn(
            { jobId: job.id, sessionId: sid },
            `cron: failed to retire MCP runtime for timed-out session: ${String(error)}`,
          );
        },
      }).catch(() => {});
    },
    onIsolatedAgentSetupTimeout: ({ job, error, timeoutMs }) => {
      cronLogger.warn(
        {
          jobId: job.id,
          jobName: job.name,
          timeoutMs,
          error,
        },
        "cron: isolated agent setup timed out before runner start; backing off job without gateway restart",
      );
    },
    sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) =>
      await sendGatewayCronFailureAlert({
        deps: params.deps,
        logger: cronLogger,
        resolveCronAgent,
        webhookToken: params.cfg.cron?.webhookToken,
        job,
        text,
        channel,
        to,
        mode,
        accountId,
      }),
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      // Any job/store change can alter session automation bindings, including
      // in-place enable flips during runs; run/schedule events bump too (cheap).
      bumpSessionAutomationVersion();
      params.broadcast("cron", evt.job ? { ...evt, job: toPublicCronJob(evt.job) } : evt, {
        dropIfSlow: true,
      });
      // Build hook event from CronEvent. The job snapshot is carried on the
      // internal event so it's available even for "removed" actions where
      // getJob() would return undefined. `delivery` and `usage` are
      // intentionally omitted — they contain internal channel/token detail
      // that is not part of the public plugin SDK surface.
      // Resolve job snapshot from the event or live service so top-level
      // convenience fields (sessionTarget, agentId) are always populated
      // when the job is known.
      const jobSnapshot = evt.job ?? cron.getJob(evt.jobId);
      const pluginJob = jobSnapshot ? toPluginCronJob(jobSnapshot) : undefined;
      const hookSummary =
        isCommandCronJob(jobSnapshot) && typeof evt.summary === "string"
          ? redactCronCommandSummaryForExternalDelivery(evt.summary)
          : evt.summary;
      const hookEvt: PluginHookCronChangedEvent = {
        action: evt.action,
        jobId: evt.jobId,
        ...(pluginJob ? { job: pluginJob } : {}),
        // Top-level routing fields so plugins don't have to dig into job.
        sessionTarget: jobSnapshot?.sessionTarget,
        agentId: jobSnapshot?.agentId,
        ...pickDefined(evt, [
          "runAtMs",
          "durationMs",
          "status",
          "error",
          "delivered",
          "deliveryStatus",
          "deliveryError",
          "sessionId",
          "sessionKey",
          "runId",
          "nextRunAtMs",
          "model",
          "provider",
        ]),
        ...(hookSummary !== undefined ? { summary: hookSummary } : {}),
      };
      runCronChangedHook(hookEvt);
      // Re-arm / cancel scheduler-owned process watchers when the job set changes.
      if (evt.action === "added" || evt.action === "updated" || evt.action === "removed") {
        broadcastCronBoundSessionChanges(evt);
        void reconcileExitWatchers();
        // cron.update and cron.add (including declarative convergence) route
        // lifecycle after the mutation. Ignoring state-only update events keeps
        // owner status/counter persistence from recursively restarting its process.
        if (evt.action !== "updated") {
          void routeStreamWatcherMutation(
            evt.jobId,
            evt.job ?? cron.getJob(evt.jobId),
            evt.action,
          ).catch((err: unknown) => {
            cronLogger.warn(
              { err: formatErrorMessage(err), jobId: evt.jobId },
              "cron-stream: route failed",
            );
          });
        }
      } else if (evt.action === "finished") {
        // Runs can flip enabled without an "updated" event (one-shot success,
        // trigger.once, schedule-error auto-disable); refresh badges then too.
        // Fully deleted jobs emit their own "removed" event instead.
        const finishedJob = evt.job ?? cron.getJob(evt.jobId);
        if (finishedJob?.enabled === false) {
          broadcastCronBoundSessionChanges(evt);
          void routeStreamWatcherMutation(evt.jobId, finishedJob, "finished").catch(
            (err: unknown) => {
              cronLogger.warn(
                { err: formatErrorMessage(err), jobId: evt.jobId },
                "cron-stream: route failed",
              );
            },
          );
        }
      }
      if (evt.action === "finished") {
        const job = evt.job ?? cron.getJob(evt.jobId);
        dispatchGatewayCronFinishedNotifications({
          evt,
          job,
          deps: params.deps,
          logger: cronLogger,
          resolveCronAgent,
          webhookToken: params.cfg.cron?.webhookToken,
          globalFailureDestination: params.cfg.cron?.failureAlert,
        });
      }
    },
  });

  exitWatchersRef.current = createCronExitWatchers({
    getProcessSupervisor,
    persistCompletion: async (job) => {
      const completionToken = {};
      terminalExitCompletionTokens.set(job.id, completionToken);
      const releaseCompletionToken = () => {
        if (terminalExitCompletionTokens.get(job.id) === completionToken) {
          terminalExitCompletionTokens.delete(job.id);
        }
      };
      try {
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await cron.updateWithPrecondition(job.id, { enabled: false }, (current) => {
            if (!current.enabled || current.updatedAtMs !== job.updatedAtMs) {
              throw new Error("cron on-exit job changed before completion");
            }
          });
        });
        return () => {
          releaseCompletionToken();
          void reconcileExitWatchers();
        };
      } catch (err) {
        releaseCompletionToken();
        throw err;
      }
    },
    fireOnExit: async (job, exit) => {
      await runWithGatewayIndependentRootWorkAdmission(async () =>
        fireOnExitJob(job, exit, {
          run: (jobId, payload) => cron.run(jobId, "force", payload ? { payload } : undefined),
        }),
      );
    },
    logger: cronLogger,
  });
  const updateCron = cron.update.bind(cron);
  streamWatchersRef.current = createCronStreamWatchers({
    getProcessSupervisor,
    updateState: async (jobId, patch, streamScheduleKey, streamSourceIdentity) => {
      return await cron.updateExternalState(jobId, streamScheduleKey, streamSourceIdentity, patch);
    },
    retireSource: async (jobId, streamScheduleKey, streamSourceIdentity) =>
      await cron.retireExternalStreamSource(jobId, streamScheduleKey, streamSourceIdentity),
    updateCounters: async (jobId, counters) => {
      await cron.updateExternalCounters(jobId, counters);
    },
    recordFailure: async (jobId, error, patch, streamScheduleKey, streamSourceIdentity) => {
      await cron.recordExternalFailure(jobId, error, patch, {
        scheduleKey: streamScheduleKey,
        identity: streamSourceIdentity,
      });
    },
    fireBatch: (job, batch, streamScheduleKey, streamSourceIdentity) =>
      runWithGatewayIndependentRootWorkAdmission(async () =>
        fireStreamJob(job, {
          run: async (jobId, onDisposition) => {
            const result = await cron.run(jobId, "force", {
              evaluateTrigger: true,
              streamBatch: batch,
              streamScheduleKey,
              streamSourceIdentity,
              onTriggerDisposition: onDisposition,
            });
            return { ...result, enabled: cron.getJob(jobId)?.enabled };
          },
        }),
      ),
    logger: cronLogger,
  });
  const routeCurrentStreamJob = async (
    jobId: string,
    job: CronJob | undefined,
    action: "added" | "updated" | "removed",
  ) => {
    await routeStreamWatcherMutation(jobId, job, action);
  };
  const routeLiveStreamJob = async (jobId: string) => {
    const current = cron.getJob(jobId);
    await routeCurrentStreamJob(jobId, current, current ? "updated" : "removed");
  };
  const queueStreamStopAfterValidation = (
    current: CronJob,
    patch: Parameters<typeof updateCron>[1],
    nowMs: number,
  ): Promise<void> | undefined => {
    if (
      current.schedule.kind !== "stream" ||
      (patch.enabled !== false && patch.schedule === undefined)
    ) {
      return undefined;
    }
    // Validate before fencing the owner. A rejected conditional or malformed
    // update must leave the live source and its buffered events untouched.
    const validated = structuredClone(current);
    applyJobPatch(validated, patch, {
      defaultAgentId: cron.getDefaultAgentId(),
      scheduleValidationNowMs: nowMs,
      cronConfig: params.cfg.cron,
    });
    if (
      validated.enabled &&
      validated.schedule.kind === "stream" &&
      cronStreamScheduleKey(validated.schedule) === cronStreamScheduleKey(current.schedule)
    ) {
      return undefined;
    }
    // Do not await under the cron store lock: stop synchronously closes owner
    // admission, then drains through its queue while the update commits.
    return streamWatchersRef.current?.stop(
      current.id,
      patch.schedule !== undefined ? "schedule-update" : "disabled",
    );
  };
  const addCron = cron.add.bind(cron);
  cron.add = async (input, options) => {
    const result = await addCron(input, options);
    const addedJob = "job" in result ? result.job : result;
    await routeCurrentStreamJob(addedJob.id, addedJob, "added");
    return result;
  };
  const settleStopAfterCommittedUpdate = async (
    jobId: string,
    lifecycleStop: Promise<void> | undefined,
  ) => {
    try {
      await lifecycleStop;
    } catch (error) {
      // The durable update already committed and the owner persisted its own
      // terminal stream diagnostic. Failing the caller here would claim a
      // rollback that never happened; routeLiveStreamJob below retries teardown.
      cronLogger.warn(
        { jobId, err: String(error) },
        "cron-stream: source teardown failed after committed update",
      );
    }
  };
  // Watcher routing after a committed mutation is lifecycle repair, not part
  // of the mutation result: a stubborn child failing again must not turn an
  // already-persisted change into a caller-visible error.
  const routeLiveStreamJobLogged = async (jobId: string) => {
    try {
      await routeLiveStreamJob(jobId);
    } catch (error) {
      cronLogger.warn(
        { jobId, err: String(error) },
        "cron-stream: post-commit lifecycle routing failed",
      );
    }
  };
  const updateCronWithPrecondition = cron.updateWithPrecondition.bind(cron);
  cron.update = async (jobId, patch) => {
    let lifecycleStop: Promise<void> | undefined;
    try {
      const result = await updateCronWithPrecondition(jobId, patch, (current, nowMs) => {
        lifecycleStop = queueStreamStopAfterValidation(current, patch, nowMs);
      });
      await settleStopAfterCommittedUpdate(jobId, lifecycleStop);
      await routeLiveStreamJobLogged(jobId);
      return result;
    } catch (error) {
      await lifecycleStop?.catch(() => undefined);
      if (lifecycleStop) {
        await routeLiveStreamJobLogged(jobId);
      }
      throw error;
    }
  };
  cron.updateWithPrecondition = async (jobId, patch, precondition) => {
    let lifecycleStop: Promise<void> | undefined;
    try {
      const result = await updateCronWithPrecondition(jobId, patch, async (current, nowMs) => {
        await precondition(current, nowMs);
        lifecycleStop = queueStreamStopAfterValidation(current, patch, nowMs);
      });
      await settleStopAfterCommittedUpdate(jobId, lifecycleStop);
      await routeLiveStreamJobLogged(jobId);
      return result;
    } catch (error) {
      await lifecycleStop?.catch(() => undefined);
      if (lifecycleStop) {
        await routeLiveStreamJobLogged(jobId);
      }
      throw error;
    }
  };
  const removeCron = cron.remove.bind(cron);
  cron.remove = async (jobId, opts) => {
    const previous = cron.getJob(jobId);
    try {
      if (previous?.schedule.kind === "stream") {
        await streamWatchersRef.current?.stop(jobId, "removed", previous);
      }
      const result = await removeCron(jobId, opts);
      if (!result.removed) {
        await routeLiveStreamJobLogged(jobId);
      }
      return result;
    } catch (error) {
      // Preserve the original stop/removal error; recovery routing is advisory.
      await routeLiveStreamJobLogged(jobId);
      throw error;
    }
  };
  const getCronSuspensionBlockerCount = cron.getSuspensionBlockerCount.bind(cron);
  cron.getSuspensionBlockerCount = () =>
    getCronSuspensionBlockerCount() +
    exitWatcherReconciliations +
    streamWatcherReconciliations +
    (exitWatchersRef.current?.activeJobIds().length ?? 0) +
    (streamWatchersRef.current?.activeJobIds().length ?? 0);
  const stopExitWatchers = () => {
    exitWatcherGeneration += 1;
    exitWatchersRef.current?.cancelAll();
  };
  // cron.stop launches this teardown asynchronously and stopAndDrain awaits
  // it; memoizing keeps that one drain instead of queueing every owner a
  // second shutdown stop whose bounded wait could spuriously time out.
  let streamWatchersStopPromise: Promise<void> | undefined;
  const stopStreamWatchers = (): Promise<void> => {
    if (streamWatchersStopPromise) {
      return streamWatchersStopPromise;
    }
    const stopPromise = (async () => {
      streamWatcherGeneration += 1;
      streamWatchersStopped = true;
      await streamWatchersRef.current?.stopAll("shutdown");
    })();
    streamWatchersStopPromise = stopPromise;
    void stopPromise.catch(() => {
      // Owners retain failed process handles so a later drain can retry them;
      // only overlapping callers should share the rejected attempt.
      if (streamWatchersStopPromise === stopPromise) {
        streamWatchersStopPromise = undefined;
      }
    });
    return stopPromise;
  };
  const automationSource = {
    getJobs: () => cron.getLoadedJobs(),
    getDefaultAgentId: () => cron.getDefaultAgentId(),
  };
  const automationEpoch = claimSessionAutomationEpoch();
  const stopCron = cron.stop.bind(cron);
  cron.stop = () => {
    stopCron();
    stopExitWatchers();
    stopHeartbeatReconcileRetry();
    void stopStreamWatchers().catch((err: unknown) => {
      cronLogger.warn(
        { err: formatErrorMessage(err) },
        "cron-stream: asynchronous teardown failed",
      );
    });
    // Session rows must stop reporting automation from a stopped scheduler,
    // but a reload's replacement service may already own the registration.
    unregisterSessionAutomationSource(automationSource);
  };
  cron.stopAndDrain = async () => {
    stopCron();
    stopExitWatchers();
    stopHeartbeatReconcileRetry();
    const streamWatchersStop = stopStreamWatchers().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const abortedRuns = abortActiveCronTaskRuns("Gateway shutting down.");
    const [activeRunDrain, streamWatchersResult] = await Promise.all([
      waitForActiveCronTaskRuns(CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS),
      streamWatchersStop,
    ]);
    if (!activeRunDrain.drained) {
      cronLogger.warn(
        { abortedRuns, activeRuns: activeRunDrain.active },
        "cron: active runs did not drain before shutdown timeout",
      );
    }
    if (!streamWatchersResult.ok) {
      throw streamWatchersResult.error;
    }
    unregisterSessionAutomationSource(automationSource);
  };
  // Reconciliations serialize on one tail and only the latest requested epoch
  // executes, so an older reload's convergence can never clobber a newer one.
  // A failed pass schedules one bounded retry; a newer request supersedes it.
  let heartbeatReconcileEpoch = 0;
  let heartbeatReconcileTail: Promise<void> = Promise.resolve();
  let heartbeatRetryTimer: NodeJS.Timeout | undefined;
  const stopHeartbeatReconcileRetry = () => {
    // Also invalidate any in-flight pass so a post-stop retry cannot fire.
    heartbeatReconcileEpoch += 1;
    if (heartbeatRetryTimer) {
      clearTimeout(heartbeatRetryTimer);
      heartbeatRetryTimer = undefined;
    }
  };
  const reconcileHeartbeatJobs = (cfgOverride?: OpenClawConfig): Promise<void> => {
    const epoch = ++heartbeatReconcileEpoch;
    if (heartbeatRetryTimer) {
      clearTimeout(heartbeatRetryTimer);
      heartbeatRetryTimer = undefined;
    }
    const pass = async () => {
      if (epoch !== heartbeatReconcileEpoch) {
        return;
      }
      const { ok } = await reconcileHeartbeatMonitorJobs({
        cron,
        cfg: cfgOverride ?? getRuntimeConfig(),
        logger: cronLogger,
      });
      if (!ok && epoch === heartbeatReconcileEpoch) {
        heartbeatRetryTimer = setTimeout(() => {
          heartbeatRetryTimer = undefined;
          void reconcileHeartbeatJobs(cfgOverride);
        }, 30_000);
        heartbeatRetryTimer.unref?.();
      }
    };
    heartbeatReconcileTail = heartbeatReconcileTail.then(pass, pass);
    return heartbeatReconcileTail;
  };
  const startCron = cron.start.bind(cron);
  cron.start = async () => {
    const generation = streamWatcherGeneration;
    await startCron();
    if (generation !== streamWatcherGeneration) {
      return;
    }
    streamWatchersStopped = false;
    // A reload restart owns a fresh watcher lifecycle; the next stop must run.
    streamWatchersStopPromise = undefined;
    streamWatchersRef.current?.resume();
    if (generation !== streamWatcherGeneration) {
      return;
    }
    await reconcileStreamWatchers();
    if (generation !== streamWatcherGeneration) {
      return;
    }
    await reconcileHeartbeatJobs();
    if (generation !== streamWatcherGeneration) {
      return;
    }
    // Register only once started, under the build-time epoch, so a stale lazy
    // service resolving after a config reload cannot clobber the replacement.
    registerSessionAutomationSource(automationSource, automationEpoch);
    // Nudge subscribed clients into a canonical list refresh so automation
    // badges match this scheduler's bindings — including clearing them when a
    // reload lands on an empty or disabled store.
    params.broadcast(
      "sessions.changed",
      { reason: "cron-bindings-loaded", ts: Date.now() },
      { dropIfSlow: true },
    );
  };

  return {
    cron,
    storePath,
    cronEnabled,
    reconcileExitWatchers,
    stopExitWatchers,
    reconcileStreamWatchers,
    stopStreamWatchers,
    reconcileHeartbeatJobs,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
