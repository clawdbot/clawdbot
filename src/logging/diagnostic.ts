import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
  type DiagnosticPhaseSnapshot,
  type DiagnosticLivenessWarningReason,
} from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import {
  getCurrentDiagnosticPhase,
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
} from "./diagnostic-phase.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  type DiagnosticSessionActivitySnapshot,
} from "./diagnostic-run-activity.js";
import {
  diagnosticLogger as diag,
  getLastDiagnosticActivityAt,
  markDiagnosticActivity as markActivity,
  resetDiagnosticActivityForTest,
} from "./diagnostic-runtime.js";
import {
  classifySessionAttention,
  type SessionAttentionClassification,
} from "./diagnostic-session-attention.js";
import {
  formatCronSessionDiagnosticFields,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";
import {
  requestStuckSessionRecovery,
  resetDiagnosticSessionRecoveryCoordinatorForTest,
  type RecoverStuckSession,
} from "./diagnostic-session-recovery-coordinator.js";
import {
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
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
const MIN_STALLED_EMBEDDED_RUN_ABORT_MS = 10 * 60_000;
const STALLED_EMBEDDED_RUN_ABORT_WARN_MULTIPLIER = 5;
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
  activeLabels: string[];
  waitingLabels: string[];
  queuedLabels: string[];
};

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
  startupGraceMs?: number;
};

let diagnosticLivenessMonitor: EventLoopDelayMonitor | null = null;
let lastDiagnosticLivenessWallAt = 0;
let lastDiagnosticLivenessCpuUsage: CpuUsage | null = null;
let lastDiagnosticLivenessEventLoopUtilization: EventLoopUtilization | null = null;
let lastDiagnosticLivenessEventAt = 0;
let lastDiagnosticLivenessWarnAt = 0;

function loadCommandPollBackoffRuntime() {
  commandPollBackoffRuntimePromise ??= import("../agents/command-poll-backoff.runtime.js");
  return commandPollBackoffRuntimePromise;
}

async function recoverStuckSession(
  params: StuckSessionRecoveryRequest,
): Promise<StuckSessionRecoveryOutcome> {
  stuckSessionRecoveryRuntimePromise ??= import("./diagnostic-stuck-session-recovery.runtime.js");
  return stuckSessionRecoveryRuntimePromise
    .then(({ recoverStuckDiagnosticSession }) => recoverStuckDiagnosticSession(params))
    .catch((err) => {
      diag.warn(`stuck session recovery unavailable: ${String(err)}`);
      return {
        status: "failed",
        action: "none",
        reason: "exception",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        error: String(err),
      };
    });
}

function formatDiagnosticWorkLabel(
  state: {
    sessionId?: string;
    sessionKey?: string;
    state: SessionStateValue;
    queueDepth: number;
    lastActivity: number;
  },
  now: number,
): string {
  const label = state.sessionKey ?? state.sessionId ?? "unknown";
  const ageSeconds = Math.round(Math.max(0, now - state.lastActivity) / 1000);
  const activity = getDiagnosticSessionActivitySnapshot(
    { sessionId: state.sessionId, sessionKey: state.sessionKey },
    now,
  );
  const workKind = activity.activeWorkKind ? `/${activity.activeWorkKind}` : "";
  const lastProgress = activity.lastProgressReason ? ` last=${activity.lastProgressReason}` : "";
  return `${label}(${state.state}${workKind},q=${state.queueDepth},age=${ageSeconds}s${lastProgress})`;
}

function pushLimitedDiagnosticLabel(labels: string[], label: string, limit = 5): void {
  if (labels.length < limit) {
    labels.push(label);
  }
}

function getDiagnosticWorkSnapshot(now = Date.now()): DiagnosticWorkSnapshot {
  let activeCount = 0;
  let waitingCount = 0;
  let queuedCount = 0;
  const activeLabels: string[] = [];
  const waitingLabels: string[] = [];
  const queuedLabels: string[] = [];

  for (const state of diagnosticSessionStates.values()) {
    if (state.state === "processing") {
      activeCount += 1;
      pushLimitedDiagnosticLabel(activeLabels, formatDiagnosticWorkLabel(state, now));
    } else if (state.state === "waiting") {
      waitingCount += 1;
      pushLimitedDiagnosticLabel(waitingLabels, formatDiagnosticWorkLabel(state, now));
    }
    if (state.queueDepth > 0) {
      pushLimitedDiagnosticLabel(queuedLabels, formatDiagnosticWorkLabel(state, now));
    }
    queuedCount += state.queueDepth;
  }

  return { activeCount, waitingCount, queuedCount, activeLabels, waitingLabels, queuedLabels };
}

function hasOpenDiagnosticWork(snapshot: DiagnosticWorkSnapshot): boolean {
  return snapshot.activeCount > 0 || snapshot.waitingCount > 0 || snapshot.queuedCount > 0;
}

function hasRecentDiagnosticActivity(now: number): boolean {
  const lastActivityAt = getLastDiagnosticActivityAt();
  return lastActivityAt > 0 && now - lastActivityAt <= RECENT_DIAGNOSTIC_ACTIVITY_MS;
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
  lastDiagnosticLivenessEventAt = 0;
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
  lastDiagnosticLivenessEventAt = 0;
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

function shouldEmitDiagnosticLivenessEvent(now: number): boolean {
  if (
    lastDiagnosticLivenessEventAt > 0 &&
    now - lastDiagnosticLivenessEventAt < DEFAULT_LIVENESS_WARN_COOLDOWN_MS
  ) {
    return false;
  }
  lastDiagnosticLivenessEventAt = now;
  return true;
}

function shouldEmitDiagnosticLivenessWarning(now: number, work: DiagnosticWorkSnapshot): boolean {
  if (!hasOpenDiagnosticWork(work)) {
    return false;
  }
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
  const phase = getCurrentDiagnosticPhase();
  const recentPhases = getRecentDiagnosticPhases(6);
  const recentPhaseSummary = formatRecentDiagnosticPhases(recentPhases);
  const workLabelSummary = formatDiagnosticWorkLabels(work);
  const message = `liveness warning: reasons=${sample.reasons.join(",")} interval=${Math.round(
    sample.intervalMs / 1000,
  )}s eventLoopDelayP99Ms=${formatOptionalDiagnosticMetric(
    sample.eventLoopDelayP99Ms,
  )} eventLoopDelayMaxMs=${formatOptionalDiagnosticMetric(
    sample.eventLoopDelayMaxMs,
  )} eventLoopUtilization=${formatOptionalDiagnosticMetric(
    sample.eventLoopUtilization,
  )} cpuCoreRatio=${formatOptionalDiagnosticMetric(sample.cpuCoreRatio)} active=${
    work.activeCount
  } waiting=${work.waitingCount} queued=${work.queuedCount}${
    phase ? ` phase=${phase}` : ""
  }${recentPhaseSummary ? ` recentPhases=${recentPhaseSummary}` : ""}${
    workLabelSummary ? ` work=[${workLabelSummary}]` : ""
  }`;
  const hasBlockingWork = work.waitingCount > 0 || work.queuedCount > 0;
  const hasSustainedEventLoopDelay =
    (sample.eventLoopDelayP99Ms ?? 0) >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS;
  if (hasBlockingWork || (hasOpenDiagnosticWork(work) && hasSustainedEventLoopDelay)) {
    diag.warn(message);
  } else {
    diag.debug(message);
  }
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
    phase,
    recentPhases,
    activeWorkLabels: work.activeLabels,
    waitingWorkLabels: work.waitingLabels,
    queuedWorkLabels: work.queuedLabels,
  });
  markActivity();
}

function formatRecentDiagnosticPhases(phases: DiagnosticPhaseSnapshot[]): string {
  return phases.map((phase) => `${phase.name}:${Math.round(phase.durationMs ?? 0)}ms`).join(",");
}

function formatDiagnosticWorkLabels(work: DiagnosticWorkSnapshot): string {
  const parts = [
    work.activeLabels.length > 0 ? `active=${work.activeLabels.join("|")}` : "",
    work.waitingLabels.length > 0 ? `waiting=${work.waitingLabels.join("|")}` : "",
    work.queuedLabels.length > 0 ? `queued=${work.queuedLabels.join("|")}` : "",
  ].filter(Boolean);
  return parts.join(" ");
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

export function resolveStuckSessionAbortMs(
  config: OpenClawConfig | undefined,
  stuckSessionWarnMs: number,
): number {
  const raw = config?.diagnostics?.stuckSessionAbortMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs);
  }
  const rounded = Math.floor(raw);
  if (rounded <= 0) {
    return resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs);
  }
  return Math.max(stuckSessionWarnMs, rounded);
}

function resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs: number): number {
  return Math.max(
    MIN_STALLED_EMBEDDED_RUN_ABORT_MS,
    stuckSessionWarnMs * STALLED_EMBEDDED_RUN_ABORT_WARN_MULTIPLIER,
  );
}

function isStalledEmbeddedRunRecoveryEligible(params: {
  classification: SessionAttentionClassification | undefined;
  ageMs: number;
  stuckSessionAbortMs: number;
}): boolean {
  return (
    params.classification?.eventType === "session.stalled" &&
    params.classification.classification === "stalled_agent_run" &&
    params.classification.activeWorkKind === "embedded_run" &&
    params.ageMs >= params.stuckSessionAbortMs
  );
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
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
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
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
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

export function markDiagnosticSessionProgress(params: SessionRef) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  state.lastActivity = Date.now();
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
  markActivity();
}

function sessionAttentionFields(params: {
  classification: SessionAttentionClassification;
  activity: DiagnosticSessionActivitySnapshot;
}) {
  const terminalProgressStale = isTerminalDiagnosticProgressReason(
    params.activity.lastProgressReason,
  );
  return {
    ...(params.classification.activeWorkKind
      ? { activeWorkKind: params.classification.activeWorkKind }
      : {}),
    ...(params.activity.lastProgressAgeMs !== undefined
      ? { lastProgressAgeMs: params.activity.lastProgressAgeMs }
      : {}),
    ...(params.activity.lastProgressReason
      ? { lastProgressReason: params.activity.lastProgressReason }
      : {}),
    ...(params.activity.activeToolName ? { activeToolName: params.activity.activeToolName } : {}),
    ...(params.activity.activeToolCallId
      ? { activeToolCallId: params.activity.activeToolCallId }
      : {}),
    ...(params.activity.activeToolAgeMs !== undefined
      ? { activeToolAgeMs: params.activity.activeToolAgeMs }
      : {}),
    ...(terminalProgressStale ? { terminalProgressStale: true } : {}),
  };
}

function isTerminalDiagnosticProgressReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  return (
    reason === "run:completed" ||
    reason === "embedded_run:ended" ||
    reason.includes("response.completed") ||
    reason.includes("rawResponseItem/completed") ||
    reason.includes("raw_response_item.completed") ||
    reason.includes("output_item.done")
  );
}

function formatSessionActivityLogFields(activity: DiagnosticSessionActivitySnapshot): string {
  const fields: string[] = [];
  if (activity.lastProgressReason) {
    fields.push(`lastProgress=${activity.lastProgressReason}`);
  }
  if (activity.lastProgressAgeMs !== undefined) {
    fields.push(`lastProgressAge=${Math.round(activity.lastProgressAgeMs / 1000)}s`);
  }
  if (activity.activeToolName) {
    fields.push(`activeTool=${activity.activeToolName}`);
  }
  if (activity.activeToolCallId) {
    fields.push(`activeToolCallId=${activity.activeToolCallId}`);
  }
  if (activity.activeToolAgeMs !== undefined) {
    fields.push(`activeToolAge=${Math.round(activity.activeToolAgeMs / 1000)}s`);
  }
  if (isTerminalDiagnosticProgressReason(activity.lastProgressReason)) {
    fields.push("terminalProgressStale=true");
  }
  return fields.join(" ");
}

export function logSessionAttention(
  params: SessionRef & {
    state: SessionStateValue;
    ageMs: number;
    thresholdMs: number;
    abortThresholdMs?: number;
  },
): SessionAttentionClassification | undefined {
  if (!areDiagnosticsEnabledForProcess()) {
    return undefined;
  }
  const state = getDiagnosticSessionState(params);
  const activity = getDiagnosticSessionActivitySnapshot(
    { sessionId: state.sessionId, sessionKey: state.sessionKey },
    Date.now(),
  );
  const classification = classifySessionAttention({
    queueDepth: state.queueDepth,
    activity,
    staleMs: params.thresholdMs,
  });
  const recoveryEligible =
    classification.recoveryEligible ||
    isStalledEmbeddedRunRecoveryEligible({
      classification,
      ageMs: params.ageMs,
      stuckSessionAbortMs:
        params.abortThresholdMs ?? resolveStalledEmbeddedRunAbortMs(params.thresholdMs),
    });
  if (classification.eventType === "session.stuck") {
    const nextWarnAgeMs =
      state.lastStuckWarnAgeMs === undefined
        ? params.thresholdMs
        : Math.max(state.lastStuckWarnAgeMs + params.thresholdMs, state.lastStuckWarnAgeMs * 2);
    if (params.ageMs < nextWarnAgeMs) {
      return undefined;
    }
    state.lastStuckWarnAgeMs = params.ageMs;
  }
  if (classification.eventType === "session.long_running") {
    const nextWarnAgeMs =
      state.lastLongRunningWarnAgeMs === undefined
        ? params.thresholdMs
        : Math.max(
            state.lastLongRunningWarnAgeMs + params.thresholdMs,
            state.lastLongRunningWarnAgeMs * 2,
          );
    if (params.ageMs < nextWarnAgeMs) {
      return undefined;
    }
    state.lastLongRunningWarnAgeMs = params.ageMs;
  }
  const label =
    classification.eventType === "session.stuck"
      ? "stuck session"
      : classification.eventType === "session.stalled"
        ? "stalled session"
        : "long-running session";
  const activityFields = formatSessionActivityLogFields(activity);
  const cronFields = formatCronSessionDiagnosticFields(
    resolveCronSessionDiagnosticContext({ sessionKey: state.sessionKey }),
  );
  const detailFields = [activityFields, cronFields].filter(Boolean).join(" ");
  const message = `${label}: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
    state.sessionKey ?? "unknown"
  } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${
    state.queueDepth
  } reason=${classification.reason} classification=${classification.classification}${
    classification.activeWorkKind ? ` activeWorkKind=${classification.activeWorkKind}` : ""
  }${detailFields ? ` ${detailFields}` : ""} recovery=${recoveryEligible ? "checking" : "none"}`;
  if (classification.eventType === "session.long_running" && state.queueDepth <= 0) {
    diag.debug(message);
  } else {
    diag.warn(message);
  }
  const baseEvent = {
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth: state.queueDepth,
    reason: classification.reason,
    ...sessionAttentionFields({ classification, activity }),
  };
  if (classification.eventType === "session.long_running") {
    emitDiagnosticEvent({
      type: "session.long_running",
      ...baseEvent,
      classification: "long_running",
    });
  } else if (classification.eventType === "session.stalled") {
    emitDiagnosticEvent({
      type: "session.stalled",
      ...baseEvent,
      classification: classification.classification,
    });
  } else {
    emitDiagnosticEvent({
      type: "session.stuck",
      ...baseEvent,
      classification: "stale_session_state",
    });
  }
  markActivity();
  return classification;
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
  const livenessGraceUntil =
    opts?.startupGraceMs != null && opts.startupGraceMs > 0 ? Date.now() + opts.startupGraceMs : 0;
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
    const stuckSessionAbortMs = resolveStuckSessionAbortMs(heartbeatConfig, stuckSessionWarnMs);
    const now = Date.now();
    pruneDiagnosticSessionStates(now, true);
    const work = getDiagnosticWorkSnapshot(now);
    const inStartupGrace = livenessGraceUntil > 0 && now < livenessGraceUntil;
    const rawLivenessSample = (opts?.sampleLiveness ?? sampleDiagnosticLiveness)(now, work);
    // Keep sampling during grace so event-loop delay baselines reset, but suppress startup-only reports.
    const livenessSample = inStartupGrace ? null : rawLivenessSample;
    const shouldEmitLivenessEvent =
      livenessSample !== null && shouldEmitDiagnosticLivenessEvent(now);
    const shouldEmitLivenessWarning =
      livenessSample !== null && shouldEmitDiagnosticLivenessWarning(now, work);
    const shouldEmitLivenessReport = shouldEmitLivenessEvent || shouldEmitLivenessWarning;
    const shouldRecordMemorySample =
      shouldEmitLivenessReport || hasRecentDiagnosticActivity(now) || hasOpenDiagnosticWork(work);
    (opts?.emitMemorySample ?? emitDiagnosticMemorySample)({
      emitSample: shouldRecordMemorySample,
    });

    if (!shouldRecordMemorySample) {
      return;
    }

    if (shouldEmitLivenessReport && livenessSample) {
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
        const classification = logSessionAttention({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          state: state.state,
          ageMs,
          thresholdMs: stuckSessionWarnMs,
          abortThresholdMs: stuckSessionAbortMs,
        });
        if (classification?.recoveryEligible) {
          requestStuckSessionRecovery({
            recover: opts?.recoverStuckSession ?? recoverStuckSession,
            classification,
            request: {
              sessionId: state.sessionId,
              sessionKey: state.sessionKey,
              ageMs,
              queueDepth: state.queueDepth,
              stateGeneration: state.generation,
            },
          });
        } else if (
          classification &&
          isStalledEmbeddedRunRecoveryEligible({
            classification,
            ageMs,
            stuckSessionAbortMs,
          })
        ) {
          requestStuckSessionRecovery({
            recover: opts?.recoverStuckSession ?? recoverStuckSession,
            classification,
            request: {
              sessionId: state.sessionId,
              sessionKey: state.sessionKey,
              ageMs,
              queueDepth: state.queueDepth,
              allowActiveAbort: true,
              stateGeneration: state.generation,
            },
          });
        }
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
  resetDiagnosticSessionRecoveryCoordinatorForTest();
  resetDiagnosticSessionStateForTest();
  resetDiagnosticActivityForTest();
  resetDiagnosticRunActivityForTest();
  webhookStats.received = 0;
  webhookStats.processed = 0;
  webhookStats.errors = 0;
  webhookStats.lastReceived = 0;
  stopDiagnosticHeartbeat();
  resetDiagnosticMemoryForTest();
  resetDiagnosticPhasesForTest();
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticStabilityBundleForTest();
}
