import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { formatErrorMessage } from "./errors.js";
import { recordRunStart, shouldDeferWake, type DeferDecision } from "./heartbeat-cooldown.js";
import {
  heartbeatLog,
  isHeartbeatOwnerUnresolved,
  resolveHeartbeatAgents,
  resolveHeartbeatForWake,
  resolveHeartbeatIntervalMs,
  tryResolveAmbientHeartbeatAgentId,
  type HeartbeatConfig,
} from "./heartbeat-runner-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner-run.js";
import { isConfiguredHeartbeatAgent, isTargetedUnscheduledWake } from "./heartbeat-wake-policy.js";
import {
  areHeartbeatsEnabled,
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  type HeartbeatWakeIntent,
  isRetryableHeartbeatSkipReason,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

const log = heartbeatLog;

type HeartbeatAgentState = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  intervalMs?: number;
  cooldownUntilMs: number;
  /** Wall-clock start time of the most recent run for this agent. */
  lastRunStartedAtMs?: number;
  /** Bounded ring buffer of recent run-start timestamps for flood detection. */
  recentRunStarts: number[];
  /** Set true after a flood-defer is logged to avoid log spam. Reset when a run actually fires. */
  floodLoggedSinceLastRun: boolean;
};

export type HeartbeatRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

export function startHeartbeatRunner(opts: {
  cfg?: OpenClawConfig;
  readCurrentConfig?: () => OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  runOnce?: typeof runHeartbeatOnce;
}): HeartbeatRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const runOnce = opts.runOnce ?? runHeartbeatOnce;
  // Cron owns monitor anchors and due slots; local cooldown only limits event
  // follow-ups. Persisted monitor ticks bypass it.
  const state = {
    cfg: opts.cfg ?? getRuntimeConfig(),
    runtime,
    agents: new Map<string, HeartbeatAgentState>(),
    stopped: false,
  };
  const readCurrentConfig = opts.readCurrentConfig ?? (() => state.cfg);
  let initialized = false;

  const createAgentState = (
    agentId: string,
    now: number,
    heartbeat?: HeartbeatConfig,
    intervalMs?: number,
  ): HeartbeatAgentState => {
    // In-flight runs settle against this object; reload must keep their accounting live.
    const agent: HeartbeatAgentState = state.agents.get(agentId) ?? {
      agentId,
      cooldownUntilMs: now,
      recentRunStarts: [],
      floodLoggedSinceLastRun: false,
    };
    agent.heartbeat = heartbeat;
    agent.intervalMs = intervalMs;
    agent.cooldownUntilMs =
      agent.lastRunStartedAtMs === undefined ? now : agent.lastRunStartedAtMs + (intervalMs ?? 0);
    return agent;
  };

  // Centralized cooldown gate. Both targeted and broadcast dispatch branches
  // call this before invoking `runOnce`. Manual wakes are never deferred.
  // Everything else respects the event cooldown, minimum spacing, and flood
  // guard owned by heartbeat-cooldown.ts.
  const evaluateWakeDeferral = (
    agent: HeartbeatAgentState,
    now: number,
    reason?: string,
    intent: HeartbeatWakeIntent = "event",
    options: { authoritativeScheduledTick?: boolean; retainedWork?: boolean } = {},
  ): DeferDecision => {
    const decision = shouldDeferWake({
      intent,
      reason,
      now,
      nextDueMs: options.authoritativeScheduledTick ? now : agent.cooldownUntilMs,
      lastRunStartedAtMs: agent.lastRunStartedAtMs,
      recentRunStarts: agent.recentRunStarts,
      retainedWork: options.retainedWork,
    });
    if (decision.defer && decision.reason === "flood") {
      if (!agent.floodLoggedSinceLastRun) {
        log.warn("heartbeat: flood guard tripped, deferring wake", {
          agentId: agent.agentId,
          reason: reason ?? "(none)",
          recentRunCount: agent.recentRunStarts.length,
        });
        agent.floodLoggedSinceLastRun = true;
      }
    }
    return decision;
  };

  // Called immediately before `runOnce` actually executes. Updates the
  // bookkeeping that the cooldown gate consults on the next wake.
  const recordRunBookkeeping = (agent: HeartbeatAgentState, now: number) => {
    agent.lastRunStartedAtMs = now;
    agent.cooldownUntilMs = now + (agent.intervalMs ?? 0);
    recordRunStart(agent.recentRunStarts, now);
    agent.floodLoggedSinceLastRun = false;
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    if (state.stopped) {
      return;
    }
    const now = Date.now();
    const prevEnabled = Array.from(state.agents.values()).some(
      (agent) => agent.intervalMs !== undefined,
    );
    const nextAgents = new Map<string, HeartbeatAgentState>();
    const intervals: number[] = [];
    const enrolled = new Map(resolveHeartbeatAgents(cfg).map((agent) => [agent.agentId, agent]));
    for (const agentId of new Set([...listAgentIds(cfg), ...enrolled.keys()])) {
      const agent = enrolled.get(agentId);
      const intervalMs = agent
        ? resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat)
        : undefined;
      if (intervalMs) {
        intervals.push(intervalMs);
      }
      nextAgents.set(
        agentId,
        createAgentState(agentId, now, agent?.heartbeat, intervalMs ?? undefined),
      );
    }

    state.cfg = cfg;
    state.agents = nextAgents;
    const nextEnabled = intervals.length > 0;
    if (!initialized || prevEnabled !== nextEnabled) {
      if (nextEnabled) {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      } else {
        log.info("heartbeat: disabled", { enabled: false });
        if (isHeartbeatOwnerUnresolved(cfg)) {
          log.warn(
            "heartbeat: multi-agent config has no ambient heartbeat owner; set agents.defaults.heartbeat.agentId or agents.defaults.systemAgent.agentId",
          );
        }
      }
    }
    initialized = true;
  };

  const run: HeartbeatWakeHandler = async (params) => {
    if (state.stopped) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }
    if (!areHeartbeatsEnabled()) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }

    const reason = params.reason;
    const intent = params.intent;
    const execEventWake = params.source === "exec-event";
    const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const requestedSessionKey = normalizeOptionalString(params.sessionKey);
    const requestedHeartbeat = params.heartbeat;
    const scheduledEveryMs =
      typeof params.scheduledEveryMs === "number" &&
      Number.isSafeInteger(params.scheduledEveryMs) &&
      params.scheduledEveryMs > 0
        ? params.scheduledEveryMs
        : undefined;
    const authoritativeScheduledTick = scheduledEveryMs !== undefined;
    const requestedTasks = params.tasks ?? [];
    const retainedWork = params.retainedWork === true;
    const wakeConfig = readCurrentConfig();
    const requestedTargetAgentId =
      requestedAgentId ??
      (requestedSessionKey ? resolveAgentIdFromSessionKey(requestedSessionKey) : undefined);
    const isInterval = reason === "interval";
    const startedAt = Date.now();
    const now = startedAt;

    type AgentWakeOutcome = {
      ran: boolean;
      retryableSkip?: HeartbeatRunResult;
      result?: HeartbeatRunResult;
    };
    const runOneAgent = async (
      agent: HeartbeatAgentState,
      targeted = false,
    ): Promise<AgentWakeOutcome> => {
      const { agentId } = agent;
      if (agent.intervalMs !== undefined && scheduledEveryMs !== undefined) {
        agent.intervalMs = scheduledEveryMs;
        agent.heartbeat = { ...agent.heartbeat, every: `${scheduledEveryMs}ms` };
      }
      const deferral = evaluateWakeDeferral(agent, now, reason, intent, {
        authoritativeScheduledTick,
        retainedWork,
      });
      if (deferral.defer) {
        // Retained exec work never owns cadence unless a scheduled tick joined it.
        if (
          deferral.reason !== "not-due" &&
          agent.cooldownUntilMs <= now &&
          (!execEventWake || authoritativeScheduledTick)
        ) {
          agent.cooldownUntilMs = now + (agent.intervalMs ?? 0);
        }
        return {
          ran: false,
          result: {
            status: "skipped",
            reason: deferral.reason,
            retryAtMs: deferral.retryAtMs,
          },
        };
      }

      // Persisted ticks use their enrolled config; targeted wakes merge their
      // destination override before the execution boundary.
      const useEnrolledHeartbeat =
        !targeted ||
        ((isInterval || authoritativeScheduledTick) && !requestedSessionKey && !requestedHeartbeat);
      let res: HeartbeatRunResult;
      try {
        res = await runOnce({
          cfg: wakeConfig,
          agentId,
          heartbeat: useEnrolledHeartbeat
            ? agent.heartbeat
            : resolveHeartbeatForWake({
                cfg: wakeConfig,
                agentId,
                configuredHeartbeat: agent.heartbeat,
                requestedHeartbeat,
                source: params.source,
              }),
          source: params.source,
          intent,
          reason,
          ...(scheduledEveryMs !== undefined ? { scheduledEveryMs } : {}),
          ...(targeted ? { sessionKey: requestedSessionKey } : {}),
          tasks: requestedTasks,
          deps: { runtime: state.runtime },
        });
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        log.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, {
          error: errMsg,
          agentId,
        });
        recordRunBookkeeping(agent, now);
        return { ran: false, result: { status: "failed", reason: errMsg } };
      }
      if (res.status === "skipped" && isRetryableHeartbeatSkipReason(res.reason)) {
        // Retryable busy attempts own no cooldown; the wake layer retains them.
        return { ran: false, retryableSkip: res };
      }
      if (
        params.source === "exec-event" &&
        res.status === "skipped" &&
        res.reason === HEARTBEAT_SKIP_NO_PENDING_EVENT
      ) {
        // An acknowledged exec completion owns neither cooldown nor retry.
        return { ran: false, result: res };
      }
      recordRunBookkeeping(agent, now);
      return { ran: res.status === "ran", result: res };
    };

    if (requestedSessionKey || requestedAgentId) {
      const targetAgentId = requestedTargetAgentId ?? tryResolveAmbientHeartbeatAgentId(wakeConfig);
      if (!targetAgentId) {
        return { status: "skipped", reason: "disabled" };
      }
      let targetAgent = state.agents.get(targetAgentId);
      // A user-present targeted event may wake an unscheduled agent once. It
      // must not enroll that agent in the recurring heartbeat scheduler.
      if (targetAgent?.intervalMs === undefined) {
        const allowsUnscheduledTarget =
          requestedTargetAgentId !== undefined &&
          isConfiguredHeartbeatAgent(wakeConfig, requestedTargetAgentId) &&
          isTargetedUnscheduledWake({
            source: params.source,
            intent,
            reason,
            agentId: requestedAgentId,
            sessionKey: requestedSessionKey,
          });
        if (!allowsUnscheduledTarget) {
          return { status: "skipped", reason: "disabled" };
        }
      }
      if (!targetAgent) {
        targetAgent = createAgentState(targetAgentId, now);
        state.agents.set(targetAgentId, targetAgent);
      }
      const outcome = await runOneAgent(targetAgent, true);
      if (outcome.retryableSkip) {
        return outcome.retryableSkip;
      }
      return outcome.ran
        ? { status: "ran", durationMs: Date.now() - startedAt }
        : (outcome.result ?? { status: "skipped", reason: "not-due" });
    }

    const enrolledAgents = Array.from(state.agents.values()).filter(
      (agent) => agent.intervalMs !== undefined,
    );
    if (enrolledAgents.length === 0) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }

    // Agent state is disjoint; concurrent broadcast dispatch prevents a slow
    // session from starving another agent's independent wake.
    const agentOutcomes = await Promise.all(enrolledAgents.map((agent) => runOneAgent(agent)));
    let ran = false;
    let firstResult: HeartbeatRunResult | undefined;
    let firstGuardSkip: Extract<HeartbeatRunResult, { status: "skipped" }> | undefined;
    for (const outcome of agentOutcomes) {
      if (outcome.retryableSkip) {
        // Busy agents own the retry. Successful siblings already advanced their
        // cooldown, so the retry does not replay their completed work.
        return outcome.retryableSkip;
      }
      ran ||= outcome.ran;
      firstResult ??= outcome.result;
      const result = outcome.result;
      if (
        !ran &&
        result?.status === "skipped" &&
        result.retryAtMs !== undefined &&
        (!firstGuardSkip || result.retryAtMs < (firstGuardSkip.retryAtMs ?? Infinity))
      ) {
        // Keep the original result identity and first agent on equal deadlines;
        // wake-layer retention consumes the exact guard reason and retry time.
        firstGuardSkip = result;
      }
    }
    if (ran) {
      return { status: "ran", durationMs: Date.now() - startedAt };
    }
    return (
      firstGuardSkip ??
      firstResult ?? {
        status: "skipped",
        reason: isInterval ? "not-due" : "disabled",
      }
    );
  };

  const disposeWakeHandler = setHeartbeatWakeHandler(run);
  updateConfig(state.cfg);

  const cleanup = () => {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    opts.abortSignal?.removeEventListener("abort", cleanup);
    disposeWakeHandler();
  };

  if (opts.abortSignal?.aborted) {
    cleanup();
  } else {
    opts.abortSignal?.addEventListener("abort", cleanup, { once: true });
  }

  return { stop: cleanup, updateConfig };
}
