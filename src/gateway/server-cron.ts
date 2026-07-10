// Gateway cron runtime service runs scheduled agent turns, heartbeat wakeups,
// plugin hooks, notifications, and cron lifecycle cleanup.
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
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
import { appendCronRunLog, resolveCronRunLogPruneOptions } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import {
  resolveCronDeliverySessionKey,
  resolveCronSessionTargetSessionKey,
} from "../cron/session-target.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import { createCronTriggerEvaluator } from "../cron/trigger-script.js";
import type { CronJob, CronPayload } from "../cron/types.js";
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
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

export type GatewayCronState = {
  cron: GatewayCronServiceContract;
  storePath: string;
  cronEnabled: boolean;
  reconcileExitWatchers?: () => Promise<void>;
  stopExitWatchers?: () => void;
};

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
    },
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
  };
}

function isCommandCronJob(job: CronJob | null | undefined): boolean {
  return job?.payload?.kind === "command";
}

/** Build the cron service state used by Gateway startup and lazy cron loading. */
export function buildGatewayCronService(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const findAgentEntry = (cfg: OpenClawConfig, agentId: string) =>
    Array.isArray(cfg.agents?.list)
      ? cfg.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        )
      : undefined;

  const hasConfiguredAgent = (cfg: OpenClawConfig, agentId: string) =>
    Boolean(findAgentEntry(cfg, agentId));

  const mergeRuntimeAgentConfig = (runtimeConfig: OpenClawConfig, requestedAgentId: string) => {
    if (hasConfiguredAgent(runtimeConfig, requestedAgentId)) {
      return runtimeConfig;
    }
    const fallbackAgentEntry = findAgentEntry(params.cfg, requestedAgentId);
    if (!fallbackAgentEntry) {
      return runtimeConfig;
    }
    const startupAgents = params.cfg.agents;
    const runtimeAgents = runtimeConfig.agents;
    return {
      ...runtimeConfig,
      agents: {
        ...startupAgents,
        ...runtimeAgents,
        defaults: {
          ...startupAgents?.defaults,
          ...runtimeAgents?.defaults,
        },
        list: [...(runtimeAgents?.list ?? []), fallbackAgentEntry],
      },
    };
  };

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = getRuntimeConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const effectiveConfig =
      normalized !== undefined ? mergeRuntimeAgentConfig(runtimeConfig, normalized) : runtimeConfig;
    const agentId =
      normalized !== undefined && hasConfiguredAgent(effectiveConfig, normalized)
        ? normalized
        : resolveDefaultAgentId(effectiveConfig);
    return { agentId, cfg: effectiveConfig };
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
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const triggerEvaluator =
    params.cfg.cron?.triggers?.enabled === true
      ? createCronTriggerEvaluator({ config: params.cfg })
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
  let exitWatcherReconciliations = 0;
  let exitWatcherGeneration = 0;
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
      reconcileCronExitWatchers({
        cronEnabled,
        exitWatchers: exitWatchersRef.current,
        jobs,
      });
    } catch (err) {
      cronLogger.warn({ err: String(err) }, "cron-exit: reconcile failed");
    } finally {
      exitWatcherReconciliations -= 1;
    }
  };

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    ...(triggerEvaluator
      ? {
          evaluateCronTrigger: ({ job, script, state, abortSignal }) =>
            triggerEvaluator({
              jobId: job.id,
              agentId: job.agentId,
              script,
              state,
              toolsAllow: job.payload.kind === "agentTurn" ? job.payload.toolsAllow : undefined,
              abortSignal,
            }),
        }
      : {}),
    defaultAgentId,
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
            accountId: plan.accountId,
            threadId: plan.threadId,
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
        cronLogger.warn({ jobId: job.id, err: error }, "cron: command delivery failed");
        return {
          ...result,
          status: job.delivery?.bestEffort ? result.status : "error",
          error: job.delivery?.bestEffort ? result.error : error,
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
      params.broadcast("cron", evt, { dropIfSlow: true });
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
      // Re-arm / cancel on-exit watchers when the job set changes.
      if (evt.action === "added" || evt.action === "updated" || evt.action === "removed") {
        void reconcileExitWatchers();
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
          globalFailureDestination: params.cfg.cron?.failureDestination,
        });

        void runWithGatewayIndependentRootWorkAdmission(async () => {
          await appendCronRunLog({
            storePath,
            entry: {
              ts: Date.now(),
              jobId: evt.jobId,
              action: "finished",
              status: evt.status,
              error: evt.error,
              summary: evt.summary,
              diagnostics: evt.diagnostics,
              delivered: evt.delivered,
              deliveryStatus: evt.deliveryStatus,
              deliveryError: evt.deliveryError,
              failureNotificationDelivery: evt.failureNotificationDelivery,
              delivery: evt.delivery,
              sessionId: evt.sessionId,
              sessionKey: evt.sessionKey,
              runId: evt.runId,
              runAtMs: evt.runAtMs,
              durationMs: evt.durationMs,
              nextRunAtMs: evt.nextRunAtMs,
              triggerFired: evt.triggerFired,
              model: evt.model,
              provider: evt.provider,
              usage: evt.usage,
            },
            opts: { keepLines: runLogPrune.keepLines },
          });
        }).catch((err: unknown) => {
          cronLogger.warn(
            { err: String(err), storePath, jobId: evt.jobId },
            "cron: run log append failed",
          );
        });
      }
    },
  });

  exitWatchersRef.current = createCronExitWatchers({
    getProcessSupervisor,
    persistCompletion: async (jobId) =>
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        await cron.update(jobId, { enabled: false });
      }),
    fireOnExit: (job, exit) =>
      runWithGatewayIndependentRootWorkAdmission(async () =>
        fireOnExitJob(job, exit, {
          run: (jobId, payload) => cron.run(jobId, "force", payload ? { payload } : undefined),
        }),
      ),
    logger: cronLogger,
  });
  const getCronSuspensionBlockerCount = cron.getSuspensionBlockerCount.bind(cron);
  cron.getSuspensionBlockerCount = () =>
    getCronSuspensionBlockerCount() +
    exitWatcherReconciliations +
    (exitWatchersRef.current?.activeJobIds().length ?? 0);
  const stopExitWatchers = () => {
    exitWatcherGeneration += 1;
    exitWatchersRef.current?.cancelAll();
  };
  const stopCron = cron.stop.bind(cron);
  cron.stop = () => {
    stopCron();
    stopExitWatchers();
  };

  return {
    cron,
    storePath,
    cronEnabled,
    reconcileExitWatchers,
    stopExitWatchers,
  };
}
