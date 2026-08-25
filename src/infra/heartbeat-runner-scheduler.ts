import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { formatErrorMessage } from "./errors.js";
import { createActiveHoursPredicate } from "./heartbeat-active-hours.js";
import { recordRunStart, shouldDeferWake, type DeferDecision } from "./heartbeat-cooldown.js";
import {
  activeHoursConfigMatch,
  heartbeatLog,
  isHeartbeatOwnerUnresolved,
  resolveActiveHoursSchedule,
  resolveHeartbeatAgents,
  resolveHeartbeatForWake,
  resolveHeartbeatSchedulerSeed,
  tryResolveAmbientHeartbeatAgentId,
  type HeartbeatConfig,
} from "./heartbeat-runner-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner-run.js";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
  seekNextActivePhaseDueMs,
} from "./heartbeat-schedule.js";
import { resolveHeartbeatIntervalMs } from "./heartbeat-summary.js";
import { isConfiguredHeartbeatAgent, isTargetedUnscheduledWake } from "./heartbeat-wake-policy.js";
import {
  areHeartbeatsEnabled,
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  type HeartbeatWakeIntent,
  type HeartbeatWakeRequest,
  isRetryableHeartbeatSkipReason,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

const log = heartbeatLog;

type HeartbeatAgentState = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  activeHoursSchedule?: ReturnType<typeof resolveActiveHoursSchedule>;
  intervalMs: number;
  phaseMs: number;
  nextDueMs: number;
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
  stableSchedulerSeed?: string;
}): HeartbeatRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const runOnce = opts.runOnce ?? runHeartbeatOnce;
  // Interval cadence is owned by the system cron monitor jobs (one per
  // heartbeat agent, converged by the gateway); this runner only executes
  // wakes. `nextDueMs` survives as the cooldown gate for event-driven wakes.
  // A scheduled monitor tick carries its persisted cadence and is authoritative.
  const state = {
    cfg: opts.cfg ?? getRuntimeConfig(),
    runtime,
    schedulerSeed: resolveHeartbeatSchedulerSeed(opts.stableSchedulerSeed),
    agents: new Map<string, HeartbeatAgentState>(),
    stopped: false,
  };
  const readCurrentConfig = opts.readCurrentConfig ?? (() => state.cfg);
  let initialized = false;

  const resolveNextDue = (
    now: number,
    intervalMs: number,
    phaseMs: number,
    prevState?: HeartbeatAgentState,
  ) =>
    resolveNextHeartbeatDueMs({
      nowMs: now,
      intervalMs,
      phaseMs,
      prev: prevState
        ? {
            intervalMs: prevState.intervalMs,
            phaseMs: prevState.phaseMs,
            nextDueMs: prevState.nextDueMs,
          }
        : undefined,
    });

  const seekActiveSlotForAgent = (agent: HeartbeatAgentState, rawDueMs: number) => {
    const isActive = createActiveHoursPredicate(state.cfg, agent.heartbeat);
    return seekNextActivePhaseDueMs({
      startMs: rawDueMs,
      intervalMs: agent.intervalMs,
      phaseMs: agent.phaseMs,
      isActive,
    });
  };

  const advanceAgentSchedule = (agent: HeartbeatAgentState, now: number, reason?: string) => {
    const rawDueMs =
      reason === "interval"
        ? computeNextHeartbeatPhaseDueMs({
            nowMs: now,
            intervalMs: agent.intervalMs,
            phaseMs: agent.phaseMs,
          })
        : // Targeted and action-driven wakes still count as a fresh heartbeat run
          // for cooldown purposes, so keep the existing now + interval behavior.
          now + agent.intervalMs;
    agent.nextDueMs = seekActiveSlotForAgent(agent, rawDueMs);
  };

  const applyScheduledCadence = (
    agent: HeartbeatAgentState,
    intervalMs: number | undefined,
    anchorMs: number | undefined,
  ) => {
    if (intervalMs === undefined) {
      return;
    }
    agent.intervalMs = intervalMs;
    agent.phaseMs =
      anchorMs ??
      resolveHeartbeatPhaseMs({
        schedulerSeed: state.schedulerSeed,
        agentId: agent.agentId,
        intervalMs,
      });
    agent.heartbeat = {
      ...agent.heartbeat,
      every: `${intervalMs}ms`,
    };
  };

  const advanceStaleScheduleAfterDeferral = (
    agent: HeartbeatAgentState,
    now: number,
    reason?: string,
    decision?: DeferDecision,
    options: { authoritativeScheduledTick?: boolean; execEventWake?: boolean } = {},
  ) => {
    if (
      !decision?.defer ||
      decision.reason === "not-due" ||
      agent.nextDueMs > now ||
      (options.execEventWake && !options.authoritativeScheduledTick)
    ) {
      return;
    }
    // A stale exec wake can be retained by the wake layer after a guard
    // deferral, but it never owns cadence unless a scheduled tick joined it.
    // Deferrals that do not have wake-layer retry ownership still move the due
    // slot forward so repeated event wakes cannot retry a stale interval.
    advanceAgentSchedule(agent, now, reason);
  };

  // Centralized cooldown gate. Both targeted and broadcast dispatch branches
  // call this before invoking `runOnce`. Manual wakes are never deferred.
  // Everything else respects `nextDueMs`, the min-spacing floor, and the flood
  // guard — see `heartbeat-cooldown.ts` for rationale and #75436.
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
      nextDueMs: options.authoritativeScheduledTick ? now : agent.nextDueMs,
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
    recordRunStart(agent.recentRunStarts, now);
    agent.floodLoggedSinceLastRun = false;
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    if (state.stopped) {
      return;
    }
    const now = Date.now();
    const prevAgents = state.agents;
    const prevEnabled = prevAgents.size > 0;
    const nextAgents = new Map<string, HeartbeatAgentState>();
    const intervals: number[] = [];
    for (const agent of resolveHeartbeatAgents(cfg)) {
      const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat);
      if (!intervalMs) {
        continue;
      }
      const phaseMs = resolveHeartbeatPhaseMs({
        schedulerSeed: state.schedulerSeed,
        agentId: agent.agentId,
        intervalMs,
      });
      intervals.push(intervalMs);
      const prevState = prevAgents.get(agent.agentId);
      const activeHoursSchedule = resolveActiveHoursSchedule(cfg, agent.heartbeat);
      // resolveNextDue only compares intervalMs/phaseMs, so discard
      // prevState when the effective activeHours window changed to avoid a stale far-future slot.
      const ahChanged =
        prevState && !activeHoursConfigMatch(prevState.activeHoursSchedule, activeHoursSchedule);
      const rawNextDueMs = resolveNextDue(
        now,
        intervalMs,
        phaseMs,
        ahChanged ? undefined : prevState,
      );
      const isActive = createActiveHoursPredicate(cfg, agent.heartbeat);
      const nextDueMs = seekNextActivePhaseDueMs({
        startMs: rawNextDueMs,
        intervalMs,
        phaseMs,
        isActive,
      });
      nextAgents.set(agent.agentId, {
        agentId: agent.agentId,
        heartbeat: agent.heartbeat,
        activeHoursSchedule,
        intervalMs,
        phaseMs,
        nextDueMs,
        lastRunStartedAtMs: prevState?.lastRunStartedAtMs,
        recentRunStarts: prevState?.recentRunStarts ?? [],
        floodLoggedSinceLastRun: prevState?.floodLoggedSinceLastRun ?? false,
      });
    }

    state.cfg = cfg;
    state.agents = nextAgents;
    const nextEnabled = nextAgents.size > 0;
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
    const scheduledAnchorMs =
      typeof params.scheduledAnchorMs === "number" &&
      Number.isSafeInteger(params.scheduledAnchorMs) &&
      params.scheduledAnchorMs >= 0
        ? params.scheduledAnchorMs
        : undefined;
    const requestedTasks = params.tasks ?? [];
    const retainedWork = params.retainedWork === true;
    const wakeConfig = readCurrentConfig();
    const requestedTargetAgentId =
      requestedAgentId ??
      (requestedSessionKey ? resolveAgentIdFromSessionKey(requestedSessionKey) : undefined);
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
    if (state.agents.size === 0 && !allowsUnscheduledTarget) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }

    const isInterval = reason === "interval";
    const startedAt = Date.now();
    const now = startedAt;

    // Run each agent's wake concurrently. Heartbeat work is per-agent —
    // separate session stores, lanes, and delivery targets — so awaiting
    // one slow agent (e.g. one whose heartbeat spawns a multi-minute
    // subagent) must not starve the others. Bookkeeping mutations only
    // touch the owning agent's `HeartbeatAgentState`, so the per-agent
    // closures are safe to fan out under `Promise.all`.
    type AgentWakeOutcome = {
      ran: boolean;
      retryableSkip?: HeartbeatRunResult;
      // Terminal per-agent result so targeted callers can report the real
      // skip reason instead of collapsing everything to not-due.
      result?: HeartbeatRunResult;
    };
    const runOneAgent = async (
      agent: HeartbeatAgentState,
      scheduledTickIsAuthoritative = false,
    ): Promise<AgentWakeOutcome> => {
      const deferral = evaluateWakeDeferral(agent, now, reason, intent, {
        authoritativeScheduledTick: scheduledTickIsAuthoritative,
        retainedWork,
      });
      if (deferral.defer) {
        advanceStaleScheduleAfterDeferral(agent, now, reason, deferral, {
          authoritativeScheduledTick: scheduledTickIsAuthoritative,
          execEventWake,
        });
        return {
          ran: false,
          result: {
            status: "skipped",
            reason: deferral.reason,
            retryAtMs: deferral.retryAtMs,
          },
        };
      }

      let res: HeartbeatRunResult;
      try {
        res = await runOnce({
          cfg: wakeConfig,
          agentId: agent.agentId,
          heartbeat: agent.heartbeat,
          source: params.source,
          intent,
          reason,
          ...(scheduledEveryMs !== undefined ? { scheduledEveryMs } : {}),
          tasks: requestedTasks,
          deps: { runtime: state.runtime },
        });
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        log.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, {
          error: errMsg,
          agentId: agent.agentId,
        });
        // Throw counts as a non-retryable terminal attempt for cooldown
        // purposes — record bookkeeping so the wake layer doesn't tight-loop
        // on the same reason.
        recordRunBookkeeping(agent, now);
        advanceAgentSchedule(agent, now, reason);
        return { ran: false, result: { status: "failed", reason: formatErrorMessage(err) } };
      }
      if (res.status === "skipped" && isRetryableHeartbeatSkipReason(res.reason)) {
        // Do not advance the schedule or record run bookkeeping for this
        // agent — its target runtime is busy and the wake layer retries.
        return { ran: false, retryableSkip: res };
      }
      if (
        params.source === "exec-event" &&
        res.status === "skipped" &&
        res.reason === HEARTBEAT_SKIP_NO_PENDING_EVENT
      ) {
        // Poll already acknowledged the exec completion. This wake owns no
        // cadence work, so it must remain a true no-op.
        return { ran: false, result: res };
      }
      // Non-retryable outcome — record bookkeeping for cooldown gates.
      recordRunBookkeeping(agent, now);
      advanceAgentSchedule(agent, now, reason);
      return { ran: res.status === "ran", result: res };
    };

    if (requestedSessionKey || requestedAgentId) {
      const targetAgentId = requestedTargetAgentId ?? tryResolveAmbientHeartbeatAgentId(wakeConfig);
      if (!targetAgentId) {
        return { status: "skipped", reason: "disabled" };
      }
      const targetAgent = state.agents.get(targetAgentId);
      // Task intent wins scheduled-task coalescing, so the cadence payload—not
      // the final intent—proves that the persisted monitor tick joined this turn.
      if (targetAgent && authoritativeScheduledTick) {
        applyScheduledCadence(targetAgent, scheduledEveryMs, scheduledAnchorMs);
      }
      // A user-present targeted event may wake an unscheduled agent once. It
      // must not enroll that agent in the recurring heartbeat scheduler.
      if (!targetAgent && !allowsUnscheduledTarget) {
        return { status: "skipped", reason: "disabled" };
      }
      if (
        (isInterval || authoritativeScheduledTick) &&
        targetAgent &&
        !requestedSessionKey &&
        !requestedHeartbeat
      ) {
        // Cron monitor tick for one enrolled agent: use the full per-agent
        // path that the broadcast interval owned before cadence moved to cron.
        // Wakes carrying
        // heartbeat overrides fall through to the targeted merge path.
        // Intentional: interval ticks run on the enrollment snapshot
        // (agent.heartbeat, refreshed by updateConfig), exactly like the
        // replaced broadcast timer — not resolveHeartbeatForWake, which only
        // ever served override-carrying targeted event wakes.
        const outcome = await runOneAgent(targetAgent, authoritativeScheduledTick);
        if (outcome.retryableSkip) {
          return outcome.retryableSkip;
        }
        if (outcome.ran) {
          return { status: "ran", durationMs: Date.now() - startedAt };
        }
        return outcome.result ?? { status: "skipped", reason: "not-due" };
      }
      if (targetAgent) {
        const deferral = evaluateWakeDeferral(targetAgent, now, reason, intent, {
          authoritativeScheduledTick,
          retainedWork,
        });
        if (deferral.defer) {
          advanceStaleScheduleAfterDeferral(targetAgent, now, reason, deferral, {
            authoritativeScheduledTick,
            execEventWake,
          });
          return {
            status: "skipped",
            reason: deferral.reason,
            retryAtMs: deferral.retryAtMs,
          };
        }
      }
      try {
        const res = await runOnce({
          cfg: wakeConfig,
          agentId: targetAgentId,
          heartbeat: resolveHeartbeatForWake({
            cfg: wakeConfig,
            agentId: targetAgentId,
            configuredHeartbeat: targetAgent?.heartbeat,
            requestedHeartbeat,
            source: params.source,
            mergeRequestedHeartbeat: true,
          }),
          source: params.source,
          intent,
          reason,
          ...(scheduledEveryMs !== undefined ? { scheduledEveryMs } : {}),
          sessionKey: requestedSessionKey,
          tasks: requestedTasks,
          deps: { runtime: state.runtime },
        });
        if (res.status === "skipped" && isRetryableHeartbeatSkipReason(res.reason)) {
          // Retryable busy — do NOT record run bookkeeping. The wake layer
          // retries the same reason shortly; if we recorded `lastRunStartedAtMs`
          // here, the retry would falsely defer with `not-due`/`min-spacing`
          // because the cooldown would treat this skipped attempt as a real run.
          return res;
        }
        if (
          params.source === "exec-event" &&
          res.status === "skipped" &&
          res.reason === HEARTBEAT_SKIP_NO_PENDING_EVENT
        ) {
          return res;
        }
        // Non-retryable outcome (ran, disabled, failed-but-not-busy). Record
        // bookkeeping and move the due slot so scheduleNext() cannot hot-loop
        // on a stale past-due agent.
        if (targetAgent) {
          recordRunBookkeeping(targetAgent, now);
          advanceAgentSchedule(targetAgent, now, reason);
        }
        return res.status === "ran" ? { status: "ran", durationMs: Date.now() - startedAt } : res;
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        log.error(`heartbeat runner: targeted runOnce threw unexpectedly: ${errMsg}`, {
          error: errMsg,
        });
        // Throw counts as a non-retryable terminal attempt for cooldown
        // purposes — record bookkeeping so the wake layer doesn't tight-loop
        // on the same reason.
        if (targetAgent) {
          recordRunBookkeeping(targetAgent, now);
          advanceAgentSchedule(targetAgent, now, reason);
        }
        return { status: "failed", reason: errMsg };
      }
    }

    if (authoritativeScheduledTick) {
      for (const agent of state.agents.values()) {
        applyScheduledCadence(agent, scheduledEveryMs, scheduledAnchorMs);
      }
    }
    const agentOutcomes = await Promise.all(
      Array.from(state.agents.values()).map((agent) =>
        runOneAgent(agent, authoritativeScheduledTick),
      ),
    );
    const firstRetryableSkip = agentOutcomes.find(
      (outcome) => outcome.retryableSkip,
    )?.retryableSkip;
    if (firstRetryableSkip) {
      // At least one agent's runtime was busy. The wake layer schedules a
      // retry; on retry, agents that already advanced their schedule will
      // defer via cooldown, so only the still-busy agent actually re-runs.
      return firstRetryableSkip;
    }

    const firstFailure = agentOutcomes.find(
      (outcome) => outcome.result?.status === "failed",
    )?.result;
    if (firstFailure) {
      return firstFailure;
    }
    if (agentOutcomes.some((outcome) => outcome.ran)) {
      return { status: "ran", durationMs: Date.now() - startedAt };
    }
    return { status: "skipped", reason: isInterval ? "not-due" : "disabled" };
  };

  const wakeHandler: HeartbeatWakeHandler = async (params: HeartbeatWakeRequest) =>
    run({
      reason: params.reason,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      heartbeat: params.heartbeat,
      scheduledEveryMs: params.scheduledEveryMs,
      scheduledAnchorMs: params.scheduledAnchorMs,
      tasks: params.tasks,
      retainedWork: params.retainedWork,
      source: params.source,
      intent: params.intent,
    });
  const disposeWakeHandler = setHeartbeatWakeHandler(wakeHandler);
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
