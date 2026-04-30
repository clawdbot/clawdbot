import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
  type DiagnosticLivenessWarningReason,
} from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import {
  diagnosticLogger as diag,
  getLastDiagnosticActivityAt,
  markDiagnosticActivity as markActivity,
  resetDiagnosticActivityForTest,
} from "./diagnostic-runtime.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
  getDiagnosticSessionStateCountForTest as getDiagnosticSessionStateCountForTestImpl,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
  type SessionRef,
  type SessionStateValue,
} from "./diagnostic-session-state.js";
import {
  installDiagnosticStabilityFatalHook,
  resetDiagnosticStabilityBundleForTest,
  uninstallDiagnosticStabilityFatalHook,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
export { diagnosticLogger, logLaneDequeue, logLaneEnqueue } from "./diagnostic-runtime.js";

const webhookStats = {
  received: 0,
  processed: 0,
  errors: 0,
  lastReceived: 0,
};

const DEFAULT_STUCK_SESSION_WARN_MS = 120_000;
const MIN_STUCK_SESSION_WARN_MS = 1_000;
const MAX_STUCK_SESSION_WARN_MS = 24 * 60 * 60 * 1000;
const RECENT_DIAGNOSTIC_ACTIVITY_MS = 120_000;
const DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS = 1_000;
const DEFAULT_LIVENESS_EVENT_LOOP_UTILIZATION_WARN = 0.95;
const DEFAULT_LIVENESS_CPU_CORE_RATIO_WARN = 0.9;
const DEFAULT_LIVENESS_WARN_COOLDOWN_MS = 120_000;
let commandPollBackoffRuntimePromise: Promise<
  typeof import("../agents/command-poll-backoff.runtime.js")
> | null = null;
let stuckSessionRecoveryRuntimePromise: Promise<
  typeof import("./diagnostic-stuck-session-recovery.runtime.js")
> | null = null;

type EmitDiagnosticMemorySample = typeof emitDiagnosticMemorySample;
type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>;
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
type CpuUsage = ReturnType<typeof process.cpuUsage>;

type DiagnosticWorkSnapshot = {
  activeCount: number;
  waitingCount: number;
  queuedCount: number;
};

type RecoverStuckSession = (params: {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
}) => void | Promise<void>;

type DiagnosticLivenessSample = {
  reasons: DiagnosticLivenessWarningReason[];
  intervalMs: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
};

type SampleDiagnosticLiveness = (
  now: number,
  work: DiagnosticWorkSnapshot,
) => DiagnosticLivenessSample | null;

type StartDiagnosticHeartbeatOptions = {
  getConfig?: () => OpenClawConfig;
  emitMemorySample?: EmitDiagnosticMemorySample;
  sampleLiveness?: SampleDiagnosticLiveness;
  recoverStuckSession?: RecoverStuckSession;
};

let diagnosticLivenessMonitor: EventLoopDelayMonitor | null = null;
let lastDiagnosticLivenessWallAt = 0;
let lastDiagnosticLivenessCpuUsage: CpuUsage | null = null;
let lastDiagnosticLivenessEventLoopUtilization: EventLoopUtilization | null = null;
let lastDiagnosticLivenessWarnAt = 0;

function loadCommandPollBackoffRuntime() {
  commandPollBackoffRuntimePromise ??= import("../agents/command-poll-backoff.runtime.js");
  return commandPollBackoffRuntimePromise;
}

function recoverStuckSession(params: {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
}) {
  stuckSessionRecoveryRuntimePromise ??= import("./diagnostic-stuck-session-recovery.runtime.js");
  void stuckSessionRecoveryRuntimePromise
    .then(({ recoverStuckDiagnosticSession }) => recoverStuckDiagnosticSession(params))
    .catch((err) => {
      diag.warn(`stuck session recovery unavailable: ${String(err)}`);
    });
}

function getDiagnosticWorkSnapshot(): DiagnosticWorkSnapshot {
  let activeCount = 0;
  let waitingCount = 0;
  let queuedCount = 0;

  for (const state of diagnosticSessionStates.values()) {
    if (state.state === "processing") {
      activeCount += 1;
    } else if (state.state === "waiting") {
      waitingCount += 1;
    }
    queuedCount += state.queueDepth;
  }

  return { activeCount, waitingCount, queuedCount };
}

function hasOpenDiagnosticWork(snapshot: DiagnosticWorkSnapshot): boolean {
  return snapshot.activeCount > 0 || snapshot.waitingCount > 0 || snapshot.queuedCount > 0;
}

function hasRecentDiagnosticActivity(now: number): boolean {
  const lastActivityAt = getLastDiagnosticActivityAt();
  return lastActivityAt > 0 && now - lastActivityAt <= RECENT_DIAGNOSTIC_ACTIVITY_MS;
}

function resolveStuckSessionReason(state: {
  state: SessionStateValue;
  queueDepth: number;
}): string {
  if (state.queueDepth > 0) {
    return "processing_with_queued_work";
  }
  if (state.state === "processing") {
    return "processing_without_queue";
  }
  return "stale_session_state";
}

function roundDiagnosticMetric(value: number, digits = 3): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nanosecondsToMilliseconds(value: number): number {
  return roundDiagnosticMetric(value / 1_000_000, 1);
}

function formatOptionalDiagnosticMetric(value: number | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

function startDiagnosticLivenessSampler(): void {
  lastDiagnosticLivenessWallAt = Date.now();
  lastDiagnosticLivenessCpuUsage = process.cpuUsage();
  lastDiagnosticLivenessEventLoopUtilization = performance.eventLoopUtilization();
  lastDiagnosticLivenessWarnAt = 0;

  if (diagnosticLivenessMonitor) {
    diagnosticLivenessMonitor.reset();
    return;
  }

  try {
    diagnosticLivenessMonitor = monitorEventLoopDelay({ resolution: 20 });
    diagnosticLivenessMonitor.enable();
    diagnosticLivenessMonitor.reset();
  } catch (err) {
    diagnosticLivenessMonitor = null;
    diag.debug(`diagnostic liveness monitor unavailable: ${String(err)}`);
  }
}

function stopDiagnosticLivenessSampler(): void {
  diagnosticLivenessMonitor?.disable();
  diagnosticLivenessMonitor = null;
  lastDiagnosticLivenessWallAt = 0;
  lastDiagnosticLivenessCpuUsage = null;
  lastDiagnosticLivenessEventLoopUtilization = null;
  lastDiagnosticLivenessWarnAt = 0;
}

function sampleDiagnosticLiveness(now: number): DiagnosticLivenessSample | null {
  if (
    !diagnosticLivenessMonitor ||
    !lastDiagnosticLivenessCpuUsage ||
    !lastDiagnosticLivenessEventLoopUtilization ||
    lastDiagnosticLivenessWallAt <= 0
  ) {
    startDiagnosticLivenessSampler();
    return null;
  }

  const intervalMs = Math.max(1, now - lastDiagnosticLivenessWallAt);
  const cpuUsage = process.cpuUsage(lastDiagnosticLivenessCpuUsage);
  const currentEventLoopUtilization = performance.eventLoopUtilization();
  const eventLoopUtilization = performance.eventLoopUtilization(
    currentEventLoopUtilization,
    lastDiagnosticLivenessEventLoopUtilization,
  ).utilization;
  const eventLoopDelayP99Ms = nanosecondsToMilliseconds(diagnosticLivenessMonitor.percentile(99));
  const eventLoopDelayMaxMs = nanosecondsToMilliseconds(diagnosticLivenessMonitor.max);
  diagnosticLivenessMonitor.reset();
  lastDiagnosticLivenessWallAt = now;
  lastDiagnosticLivenessCpuUsage = process.cpuUsage();
  lastDiagnosticLivenessEventLoopUtilization = currentEventLoopUtilization;

  const cpuUserMs = roundDiagnosticMetric(cpuUsage.user / 1_000, 1);
  const cpuSystemMs = roundDiagnosticMetric(cpuUsage.system / 1_000, 1);
  const cpuTotalMs = roundDiagnosticMetric(cpuUserMs + cpuSystemMs, 1);
  const cpuCoreRatio = roundDiagnosticMetric(cpuTotalMs / intervalMs, 3);
  const eventLoopUtilizationRatio = roundDiagnosticMetric(eventLoopUtilization, 3);
  const reasons: DiagnosticLivenessWarningReason[] = [];

  if (
    eventLoopDelayP99Ms >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS ||
    eventLoopDelayMaxMs >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS
  ) {
    reasons.push("event_loop_delay");
  }
  if (eventLoopUtilizationRatio >= DEFAULT_LIVENESS_EVENT_LOOP_UTILIZATION_WARN) {
    reasons.push("event_loop_utilization");
  }
  if (cpuCoreRatio >= DEFAULT_LIVENESS_CPU_CORE_RATIO_WARN) {
    reasons.push("cpu");
  }
  if (reasons.length === 0) {
    return null;
  }

  return {
    reasons,
    intervalMs,
    eventLoopDelayP99Ms,
    eventLoopDelayMaxMs,
    eventLoopUtilization: eventLoopUtilizationRatio,
    cpuUserMs,
    cpuSystemMs,
    cpuTotalMs,
    cpuCoreRatio,
  };
}

function shouldEmitDiagnosticLivenessWarning(now: number): boolean {
  if (
    lastDiagnosticLivenessWarnAt > 0 &&
    now - lastDiagnosticLivenessWarnAt < DEFAULT_LIVENESS_WARN_COOLDOWN_MS
  ) {
    return false;
  }
  lastDiagnosticLivenessWarnAt = now;
  return true;
}

function emitDiagnosticLivenessWarning(
  sample: DiagnosticLivenessSample,
  work: DiagnosticWorkSnapshot,
): void {
  diag.warn(
    `liveness warning: reasons=${sample.reasons.join(",")} interval=${Math.round(
      sample.intervalMs / 1000,
    )}s eventLoopDelayP99Ms=${formatOptionalDiagnosticMetric(
      sample.eventLoopDelayP99Ms,
    )} eventLoopDelayMaxMs=${formatOptionalDiagnosticMetric(
      sample.eventLoopDelayMaxMs,
    )} eventLoopUtilization=${formatOptionalDiagnosticMetric(
      sample.eventLoopUtilization,
    )} cpuCoreRatio=${formatOptionalDiagnosticMetric(sample.cpuCoreRatio)} active=${
      work.activeCount
    } waiting=${work.waitingCount} queued=${work.queuedCount}`,
  );
  emitDiagnosticEvent({
    type: "diagnostic.liveness.warning",
    reasons: sample.reasons,
    intervalMs: sample.intervalMs,
    eventLoopDelayP99Ms: sample.eventLoopDelayP99Ms,
    eventLoopDelayMaxMs: sample.eventLoopDelayMaxMs,
    eventLoopUtilization: sample.eventLoopUtilization,
    cpuUserMs: sample.cpuUserMs,
    cpuSystemMs: sample.cpuSystemMs,
    cpuTotalMs: sample.cpuTotalMs,
    cpuCoreRatio: sample.cpuCoreRatio,
    active: work.activeCount,
    waiting: work.waitingCount,
    queued: work.queuedCount,
  });
  markActivity();
}

export function resolveStuckSessionWarnMs(config?: OpenClawConfig): number {
  const raw = config?.diagnostics?.stuckSessionWarnMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_STUCK_SESSION_WARN_MS;
  }
  const rounded = Math.floor(raw);
  if (rounded < MIN_STUCK_SESSION_WARN_MS || rounded > MAX_STUCK_SESSION_WARN_MS) {
    return DEFAULT_STUCK_SESSION_WARN_MS;
  }
  return rounded;
}

export function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  webhookStats.received += 1;
  webhookStats.lastReceived = Date.now();
  if (diag.isEnabled("debug")) {
    diag.debug(
      `webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
        params.chatId ?? "unknown"
      } total=${webhookStats.received}`,
    );
  }
  emitDiagnosticEvent({
    type: "webhook.received",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
  });
  markActivity();
}

export function logWebhookProcessed(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  webhookStats.processed += 1;
  if (diag.isEnabled("debug")) {
    diag.debug(
      `webhook processed: channel=${params.channel} type=${
        params.updateType ?? "unknown"
      } chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${
        webhookStats.processed
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "webhook.processed",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    durationMs: params.durationMs,
  });
  markActivity();
}

export function logWebhookError(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  webhookStats.errors += 1;
  diag.error(
    `webhook error: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
      params.chatId ?? "unknown"
    } error="${params.error}" errors=${webhookStats.errors}`,
  );
  emitDiagnosticEvent({
    type: "webhook.error",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    error: params.error,
  });
  markActivity();
}

export function logMessageQueued(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  state.queueDepth += 1;
  state.lastActivity = Date.now();
  if (diag.isEnabled("debug")) {
    diag.debug(
      `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logMessageProcessed(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const wantsLog = params.outcome === "error" ? diag.isEnabled("error") : diag.isEnabled("debug");
  if (wantsLog) {
    const payload = `message processed: channel=${params.channel} chatId=${
      params.chatId ?? "unknown"
    } messageId=${params.messageId ?? "unknown"} sessionId=${
      params.sessionId ?? "unknown"
    } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} duration=${
      params.durationMs ?? 0
    }ms${params.reason ? ` reason=${params.reason}` : ""}${
      params.error ? ` error="${params.error}"` : ""
    }`;
    if (params.outcome === "error") {
      diag.error(payload);
    } else {
      diag.debug(payload);
    }
  }
  emitDiagnosticEvent({
    type: "message.processed",
    channel: params.channel,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    durationMs: params.durationMs,
    outcome: params.outcome,
    reason: params.reason,
    error: params.error,
  });
  markActivity();
}

export function logSessionStateChange(
  params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
  },
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  const isProbeSession = state.sessionId?.startsWith("probe-") ?? false;
  const prevState = state.state;
  state.state = params.state;
  state.lastActivity = Date.now();
  if (params.state === "idle") {
    state.queueDepth = Math.max(0, state.queueDepth - 1);
  }
  if (!isProbeSession && diag.isEnabled("debug")) {
    diag.debug(
      `session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${
        state.queueDepth
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: params.state,
    reason: params.reason,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logSessionStuck(params: SessionRef & { state: SessionStateValue; ageMs: number }) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  const reason = resolveStuckSessionReason(state);
  diag.warn(
    `stuck session: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${
      state.queueDepth
    } reason=${reason} recovery=checking`,
  );
  emitDiagnosticEvent({
    type: "session.stuck",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth: state.queueDepth,
    reason,
  });
  markActivity();
}

export function logRunAttempt(params: SessionRef & { runId: string; attempt: number }) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diag.debug(
    `run attempt: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
      params.sessionKey ?? "unknown"
    } runId=${params.runId} attempt=${params.attempt}`,
  );
  emitDiagnosticEvent({
    type: "run.attempt",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    attempt: params.attempt,
  });
  markActivity();
}

export function logToolLoopAction(
  params: SessionRef & {
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector:
      | "generic_repeat"
      | "unknown_tool_repeat"
      | "known_poll_no_progress"
      | "global_circuit_breaker"
      | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
  },
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const payload = `tool loop: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } tool=${params.toolName} level=${params.level} action=${params.action} detector=${
    params.detector
  } count=${params.count}${params.pairedToolName ? ` pairedTool=${params.pairedToolName}` : ""} message="${params.message}"`;
  if (params.level === "critical") {
    diag.error(payload);
  } else {
    diag.warn(payload);
  }
  emitDiagnosticEvent({
    type: "tool.loop",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.toolName,
    level: params.level,
    action: params.action,
    detector: params.detector,
    count: params.count,
    message: params.message,
    pairedToolName: params.pairedToolName,
  });
  markActivity();
}

export function logActiveRuns() {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const now = Date.now();
  const activeSessions = Array.from(diagnosticSessionStates.entries())
    .filter(([, s]) => s.state === "processing")
    .map(([id, s]) => `${id}(q=${s.queueDepth},age=${Math.round((now - s.lastActivity) / 1000)}s)`);
  diag.debug(`active runs: count=${activeSessions.length} sessions=[${activeSessions.join(", ")}]`);
  markActivity();
}

let heartbeatInterval: NodeJS.Timeout | null = null;

export function startDiagnosticHeartbeat(
  config?: OpenClawConfig,
  opts?: StartDiagnosticHeartbeatOptions,
) {
  if (!areDiagnosticsEnabledForProcess() || !isDiagnosticsEnabled(config)) {
    return;
  }
  startDiagnosticStabilityRecorder();
  installDiagnosticStabilityFatalHook();
  if (heartbeatInterval) {
    return;
  }
  startDiagnosticLivenessSampler();
  heartbeatInterval = setInterval(() => {
    let heartbeatConfig = config;
    if (!heartbeatConfig) {
      try {
        heartbeatConfig = (opts?.getConfig ?? getRuntimeConfig)();
      } catch {
        heartbeatConfig = undefined;
      }
    }
    const stuckSessionWarnMs = resolveStuckSessionWarnMs(heartbeatConfig);
    const now = Date.now();
    pruneDiagnosticSessionStates(now, true);
    const work = getDiagnosticWorkSnapshot();
    const livenessSample = (opts?.sampleLiveness ?? sampleDiagnosticLiveness)(now, work);
    const shouldEmitLivenessWarning =
      livenessSample !== null && shouldEmitDiagnosticLivenessWarning(now);
    const shouldRecordMemorySample =
      shouldEmitLivenessWarning || hasRecentDiagnosticActivity(now) || hasOpenDiagnosticWork(work);
    (opts?.emitMemorySample ?? emitDiagnosticMemorySample)({
      emitSample: shouldRecordMemorySample,
    });

    if (!shouldRecordMemorySample) {
      return;
    }

    if (shouldEmitLivenessWarning && livenessSample) {
      emitDiagnosticLivenessWarning(livenessSample, work);
    }

    diag.debug(
      `heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${work.activeCount} waiting=${work.waitingCount} queued=${work.queuedCount}`,
    );
    emitDiagnosticEvent({
      type: "diagnostic.heartbeat",
      webhooks: {
        received: webhookStats.received,
        processed: webhookStats.processed,
        errors: webhookStats.errors,
      },
      active: work.activeCount,
      waiting: work.waitingCount,
      queued: work.queuedCount,
    });

    void loadCommandPollBackoffRuntime()
      .then(({ pruneStaleCommandPolls }) => {
        for (const [, state] of diagnosticSessionStates) {
          pruneStaleCommandPolls(state);
        }
      })
      .catch((err) => {
        diag.debug(`command-poll-backoff prune failed: ${String(err)}`);
      });

    for (const [, state] of diagnosticSessionStates) {
      const ageMs = now - state.lastActivity;
      if (state.state === "processing" && ageMs > stuckSessionWarnMs) {
        logSessionStuck({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          state: state.state,
          ageMs,
        });
        void (opts?.recoverStuckSession ?? recoverStuckSession)({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          ageMs,
          queueDepth: state.queueDepth,
        });
      }
    }
  }, 30_000);
  heartbeatInterval.unref?.();
}

export function stopDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  stopDiagnosticLivenessSampler();
  stopDiagnosticStabilityRecorder();
  uninstallDiagnosticStabilityFatalHook();
}

export function getDiagnosticSessionStateCountForTest(): number {
  return getDiagnosticSessionStateCountForTestImpl();
}

export function resetDiagnosticStateForTest(): void {
  resetDiagnosticSessionStateForTest();
  resetDiagnosticActivityForTest();
  webhookStats.received = 0;
  webhookStats.processed = 0;
  webhookStats.errors = 0;
  webhookStats.lastReceived = 0;
  stopDiagnosticHeartbeat();
  resetDiagnosticMemoryForTest();
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticStabilityBundleForTest();
}
