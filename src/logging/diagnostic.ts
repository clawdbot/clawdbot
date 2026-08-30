// Diagnostic logger records structured runtime events, timings, and health snapshots.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { resolveCompactionTimeoutMs } from "../agents/embedded-agent-runner/compaction-safety-timeout.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  isDiagnosticsEnabled,
  type DiagnosticContinuationQueueMetrics,
  type DiagnosticPhaseSnapshot,
  type DiagnosticLivenessWarningReason,
} from "../infra/diagnostic-events.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { getDiagnosticContinuationQueueMetrics } from "./diagnostic-continuation-queues.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import {
  getCurrentDiagnosticPhase,
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
} from "./diagnostic-phase.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
  type DiagnosticSessionActivitySnapshot,
} from "./diagnostic-run-activity.js";
import {
  diagnosticLogger as diag,
  getLastDiagnosticActivityAt,
  logMessageQueuedWithBacklogPolicy,
  markDiagnosticActivity as markActivity,
  resetDiagnosticActivityForTest,
} from "./diagnostic-runtime.js";
import {
  classifySessionAttention,
  isTerminalDiagnosticProgressReason,
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
import type {
  StuckSessionRecoveryOutcome,
  StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
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

export { diagnosticLogger } from "./diagnostic-runtime.js";

const webhookStats = {
  received: 0,
  processed: 0,
  errors: 0,
  lastReceived: 0,
};

const DEFAULT_STUCK_SESSION_WARN_MS = 120_000;
const MIN_STALLED_EMBEDDED_RUN_ABORT_MS = 5 * 60_000;
const STALLED_EMBEDDED_RUN_ABORT_WARN_MULTIPLIER = 3;
const RECENT_DIAGNOSTIC_ACTIVITY_MS = 120_000;
const DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS = 1_000;
const DEFAULT_LIVENESS_EVENT_LOOP_UTILIZATION_WARN = 0.95;
const DEFAULT_LIVENESS_CPU_CORE_RATIO_WARN = 0.9;
const DEFAULT_LIVENESS_WARN_COOLDOWN_MS = 120_000;
const DIAGNOSTIC_HEARTBEAT_INTERVAL_MS = 30_000;
const loadStuckSessionRecoveryRuntime = createLazyRuntimeModule(
  () => import("./diagnostic-stuck-session-recovery.runtime.js"),
);

// The logging-core SDK shipped this callback input before automatic bundles retired.
// Preserve its optional fields; the heartbeat only supplies emitSample.
type DiagnosticMemorySampleCallbackOptions = NonNullable<
  Parameters<typeof emitDiagnosticMemorySample>[0]
> & {
  writeCriticalBundle?: boolean;
  stateDir?: string;
  sessionStorePaths?: string[];
  resolveSessionStorePaths?: () => string[] | undefined;
};
type EmitDiagnosticMemorySample = (
  options?: DiagnosticMemorySampleCallbackOptions,
) => ReturnType<typeof emitDiagnosticMemorySample>;
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
  degradedSinceMs?: number;
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
  /** Keeps fake-timer recovery tests fast without reopening runtime config tuning. */
  testTimings?: {
    stuckSessionWarnMs: number;
    stuckSessionAbortMs: number;
  };
};

let diagnosticLivenessMonitor: EventLoopDelayMonitor | null = null;
let lastDiagnosticLivenessWallAt = 0;
let lastDiagnosticLivenessCpuUsage: CpuUsage | null = null;
let lastDiagnosticLivenessEventLoopUtilization: EventLoopUtilization | null = null;
let lastDiagnosticLivenessEventAt = 0;
let lastDiagnosticLivenessWarnAt = 0;

const loadCommandPollBackoffRuntime = createLazyRuntimeModule(
  () => import("../agents/command-poll-backoff.runtime.js"),
);

async function recoverStuckSession(
  params: StuckSessionRecoveryRequest,
): Promise<StuckSessionRecoveryOutcome> {
  return loadStuckSessionRecoveryRuntime()
    .then(({ recoverStuckDiagnosticSession }) => recoverStuckDiagnosticSession(params))
    .catch((err: unknown) => {
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
    activeQueuedTurn?: boolean;
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

function resolveDiagnosticQueuedBacklog(state: {
  activeQueuedTurn?: boolean;
  queueDepth: number;
  state: SessionStateValue;
}): number {
  return Math.max(
    0,
    state.queueDepth - (state.state === "processing" && state.activeQueuedTurn ? 1 : 0),
  );
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
    const queuedBacklog = resolveDiagnosticQueuedBacklog(state);
    if (queuedBacklog > 0) {
      pushLimitedDiagnosticLabel(queuedLabels, formatDiagnosticWorkLabel(state, now));
    }
    queuedCount += queuedBacklog;
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

function shouldEmitDiagnosticLivenessWarning(
  now: number,
  work: DiagnosticWorkSnapshot,
  continuationQueue: DiagnosticContinuationQueueMetrics | undefined,
): boolean {
  if (!hasOpenDiagnosticWork(work) && !hasContinuationQueueActivity(continuationQueue)) {
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

function formatContinuationQueueNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function hasContinuationQueueActivity(
  continuationQueue: DiagnosticContinuationQueueMetrics | undefined,
): continuationQueue is DiagnosticContinuationQueueMetrics {
  return (
    continuationQueue !== undefined &&
    (continuationQueue.totalQueued > 0 ||
      continuationQueue.enqueuedSinceLastSample > 0 ||
      continuationQueue.drainedSinceLastSample > 0 ||
      continuationQueue.failedSinceLastSample > 0)
  );
}

// Liveness-warn predicate: only fires on motion (enqueue/drain/fail since
// last sample), NOT on persistent queue depth alone. This keeps healthy
// sessions with steady-state queue depth from re-introducing the same
// per-heartbeat noise that v2026.5.3's session-attention throttle removed
// for `recovery=none` long-running warnings (see
// `lastLongRunningWarnAgeMs` in `logSessionAttention`). Depth is still
// surfaced via the message suffix and event payload so observers can see
// it; we just don't escalate to warn on presence alone.
function hasContinuationQueueMotion(
  continuationQueue: DiagnosticContinuationQueueMetrics | undefined,
): continuationQueue is DiagnosticContinuationQueueMetrics {
  return (
    continuationQueue !== undefined &&
    (continuationQueue.enqueuedSinceLastSample > 0 ||
      continuationQueue.drainedSinceLastSample > 0 ||
      continuationQueue.failedSinceLastSample > 0)
  );
}

function safeGetDiagnosticContinuationQueueMetrics(
  now: number,
): DiagnosticContinuationQueueMetrics | undefined {
  try {
    return getDiagnosticContinuationQueueMetrics(now);
  } catch (err) {
    diag.debug(`continuation queue diagnostics failed: ${String(err)}`);
    return undefined;
  }
}

function formatContinuationQueueTopQueues(
  continuationQueue: DiagnosticContinuationQueueMetrics,
): string {
  return continuationQueue.topQueues
    .map(
      (queue) =>
        `${queue.sessionKey}(total=${queue.totalQueued},runnable=${queue.pendingRunnable},scheduled=${queue.pendingScheduled},staged=${queue.stagedPostCompaction},invalid=${queue.invalidQueued})`,
    )
    .join(",");
}

function formatContinuationQueueHistory(
  continuationQueue: DiagnosticContinuationQueueMetrics,
): string {
  return JSON.stringify(
    continuationQueue.queueDepthHistory.map((point) => ({
      sampled_at: point.sampledAt,
      total_queued: point.totalQueued,
      runnable: point.pendingRunnable,
      scheduled: point.pendingScheduled,
      staged_post_compaction: point.stagedPostCompaction,
      invalid_queued: point.invalidQueued,
      enqueued: point.enqueued,
      drained: point.drained,
      failed: point.failed,
    })),
  );
}

function formatContinuationQueueLogSuffix(
  continuationQueue: DiagnosticContinuationQueueMetrics | undefined,
): string {
  if (!hasContinuationQueueActivity(continuationQueue)) {
    return "";
  }
  return ` continuationQueueTotal=${continuationQueue.totalQueued} continuationQueueRunnable=${continuationQueue.pendingRunnable} continuationQueueScheduled=${continuationQueue.pendingScheduled} continuationQueueStagedPostCompaction=${continuationQueue.stagedPostCompaction} continuationQueueInvalid=${continuationQueue.invalidQueued} continuationQueueEnqueued=${continuationQueue.enqueuedSinceLastSample} continuationQueueDrained=${continuationQueue.drainedSinceLastSample} continuationQueueFailed=${continuationQueue.failedSinceLastSample} continuationQueueEnqueueRatePerMinute=${formatContinuationQueueNumber(continuationQueue.enqueueRatePerMinute)} continuationQueueDrainRatePerMinute=${formatContinuationQueueNumber(continuationQueue.drainRatePerMinute)} continuationQueueFailedRatePerMinute=${formatContinuationQueueNumber(continuationQueue.failedRatePerMinute)} continuationQueueTop=[${formatContinuationQueueTopQueues(continuationQueue)}] queue_depth_history=${formatContinuationQueueHistory(continuationQueue)}`;
}

function emitDiagnosticContinuationQueueSample(
  continuationQueue: DiagnosticContinuationQueueMetrics,
): void {
  emitDiagnosticEvent({
    type: "diagnostic.continuation_queue.sample",
    continuationQueue,
  });
  markActivity();
}

function emitDiagnosticLivenessWarning(
  sample: DiagnosticLivenessSample,
  work: DiagnosticWorkSnapshot,
  continuationQueue: DiagnosticContinuationQueueMetrics | undefined,
  now: number,
): void {
  const phase = getCurrentDiagnosticPhase();
  // Attribute only phases completed during this measured liveness interval.
  // The retained ring is capacity-bounded history, not a temporal recency signal.
  const recentPhases = getRecentDiagnosticPhases(6, {
    completedAfter: now - Math.max(0, sample.intervalMs),
  });
  const recentPhaseSummary = formatRecentDiagnosticPhases(recentPhases);
  const workLabelSummary = formatDiagnosticWorkLabels(work);
  const message = `liveness warning: reasons=${sample.reasons.join(",")} interval=${Math.round(
    sample.intervalMs / 1000,
  )}s${
    sample.degradedSinceMs === undefined
      ? ""
      : ` degradedFor=${Math.round(sample.degradedSinceMs / 1000)}s`
  } eventLoopDelayP99Ms=${formatOptionalDiagnosticMetric(
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
  }${formatContinuationQueueLogSuffix(continuationQueue)}`;
  const hasBlockingWork = work.waitingCount > 0 || work.queuedCount > 0;
  const hasPersistentDegradation = sample.degradedSinceMs !== undefined;
  const hasSustainedEventLoopDelay =
    (sample.eventLoopDelayP99Ms ?? 0) >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS;
  const hasContinuationQueueWarn = hasContinuationQueueMotion(continuationQueue);
  if (
    hasPersistentDegradation ||
    hasBlockingWork ||
    (hasOpenDiagnosticWork(work) && hasSustainedEventLoopDelay) ||
    hasContinuationQueueWarn
  ) {
    diag.warn(message);
  } else {
    diag.debug(message);
  }
  emitDiagnosticEvent({
    type: "diagnostic.liveness.warning",
    reasons: sample.reasons,
    intervalMs: sample.intervalMs,
    degradedSinceMs: sample.degradedSinceMs,
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
    ...(hasContinuationQueueActivity(continuationQueue) ? { continuationQueue } : {}),
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

function resolveStuckSessionWarnMs(): number {
  return DEFAULT_STUCK_SESSION_WARN_MS;
}

function resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number {
  return resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs);
}

function resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs: number): number {
  return Math.max(
    MIN_STALLED_EMBEDDED_RUN_ABORT_MS,
    stuckSessionWarnMs * STALLED_EMBEDDED_RUN_ABORT_WARN_MULTIPLIER,
  );
}

function isStalledEmbeddedRunRecoveryEligible(params: {
  classification: SessionAttentionClassification | undefined;
  activity?: DiagnosticSessionActivitySnapshot;
  stuckSessionAbortMs: number;
}): boolean {
  const lastProgressAgeMs = params.activity?.lastProgressAgeMs;
  return (
    params.classification?.eventType === "session.stalled" &&
    params.classification.classification === "stalled_agent_run" &&
    params.classification.activeWorkKind === "embedded_run" &&
    typeof lastProgressAgeMs === "number" &&
    lastProgressAgeMs >= params.stuckSessionAbortMs
  );
}

function isBlockedToolCallRecoveryEligible(params: {
  classification: SessionAttentionClassification | undefined;
  activity?: DiagnosticSessionActivitySnapshot;
  stuckSessionAbortMs: number;
}): boolean {
  const toolAgeMs = params.activity?.activeToolAgeMs;
  const lastProgressAgeMs = params.activity?.lastProgressAgeMs;
  const abortMs = Math.max(params.stuckSessionAbortMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
  return (
    params.classification?.eventType === "session.stalled" &&
    params.classification.classification === "blocked_tool_call" &&
    params.classification.activeWorkKind === "tool_call" &&
    typeof toolAgeMs === "number" &&
    typeof lastProgressAgeMs === "number" &&
    (params.activity?.activeToolDeadlineAtMs !== undefined
      ? Date.now() >= params.activity.activeToolDeadlineAtMs
      : toolAgeMs >= abortMs && lastProgressAgeMs >= abortMs)
  );
}

function isStalledModelCallRecoveryEligible(params: {
  classification: SessionAttentionClassification | undefined;
  activity?: DiagnosticSessionActivitySnapshot;
  stuckSessionAbortMs: number;
}): boolean {
  const lastProgressAgeMs = params.activity?.lastProgressAgeMs;
  const effectiveAbortMs = Math.max(
    params.stuckSessionAbortMs,
    params.activity?.activeModelCallRequestTimeoutMs ?? 0,
  );
  // Local providers are not blanket-exempt from recovery. Streaming model
  // chunks refresh run activity while emitted progress events are throttled, so
  // active streams stay fresh and silent/non-streaming calls can be recovered.
  return (
    params.classification?.eventType === "session.stalled" &&
    params.classification.classification === "stalled_agent_run" &&
    params.classification.activeWorkKind === "model_call" &&
    typeof lastProgressAgeMs === "number" &&
    lastProgressAgeMs >= effectiveAbortMs
  );
}

function isActiveAbortRecoveryEligible(params: {
  classification: SessionAttentionClassification | undefined;
  activity?: DiagnosticSessionActivitySnapshot;
  stuckSessionAbortMs: number;
}): boolean {
  const effectiveModelAbortMs = Math.max(
    params.stuckSessionAbortMs,
    params.activity?.activeModelCallRequestTimeoutMs ?? 0,
  );
  const activeModelCallRequestTimeoutMs = params.activity?.activeModelCallRequestTimeoutMs;
  const activeModelCallAllowanceExpired =
    activeModelCallRequestTimeoutMs === undefined ||
    (params.activity?.lastProgressAgeMs ?? 0) >= activeModelCallRequestTimeoutMs;
  return (
    (params.classification?.eventType === "session.stalled" &&
      params.classification.classification === "stalled_agent_run" &&
      params.activity?.hasActiveEmbeddedRun === true &&
      (params.activity.repeatedRequestNoProgressAgeMs ?? 0) >= effectiveModelAbortMs &&
      activeModelCallAllowanceExpired) ||
    isStalledEmbeddedRunRecoveryEligible(params) ||
    isBlockedToolCallRecoveryEligible(params) ||
    isStalledModelCallRecoveryEligible(params)
  );
}

function isIdleQueuedRecoverableSessionStall(params: {
  state: {
    state: SessionStateValue;
    queueDepth: number;
  };
  activity: DiagnosticSessionActivitySnapshot;
  staleMs: number;
}): boolean {
  const hasEmbeddedOwner =
    params.activity.activeWorkKind === "embedded_run" ||
    params.activity.hasActiveEmbeddedRun === true;
  // Also detect orphaned activity (model_call or tool_call left behind
  // without an active embedded owner) so recovery can pump the stale queue.
  const hasOrphanedActivity =
    params.activity.activeWorkKind !== undefined && params.activity.hasActiveEmbeddedRun !== true;
  return (
    params.state.state === "idle" &&
    params.state.queueDepth > 0 &&
    (hasEmbeddedOwner || hasOrphanedActivity) &&
    (params.activity.lastProgressAgeMs ?? 0) > params.staleMs
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
  logMessageQueuedWithBacklogPolicy(params, true);
}

export function logMessageReceived(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  messageId?: number | string;
  chatId?: number | string;
  source: string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  if (diag.isEnabled("debug")) {
    diag.debug(
      `message received: channel=${params.channel ?? "unknown"} chatId=${
        params.chatId ?? "unknown"
      } messageId=${params.messageId ?? "unknown"} sessionId=${
        params.sessionId ?? "unknown"
      } sessionKey=${params.sessionKey ?? "unknown"} source=${params.source}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.received",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channel: params.channel,
    messageId: params.messageId,
    chatId: params.chatId,
    source: params.source,
  });
  markActivity();
}

export function logMessageDispatchStarted(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  if (diag.isEnabled("debug")) {
    diag.debug(
      `message dispatch started: channel=${params.channel ?? "unknown"} sessionId=${
        params.sessionId ?? "unknown"
      } sessionKey=${params.sessionKey ?? "unknown"} source=${params.source}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.dispatch.started",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channel: params.channel,
    source: params.source,
  });
  markActivity();
}

export function logMessageDispatchCompleted(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
  durationMs: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  if (diag.isEnabled(params.outcome === "error" ? "error" : "debug")) {
    const payload = `message dispatch completed: channel=${params.channel ?? "unknown"} sessionId=${
      params.sessionId ?? "unknown"
    } sessionKey=${params.sessionKey ?? "unknown"} source=${params.source} outcome=${
      params.outcome
    } duration=${params.durationMs}ms${params.reason ? ` reason=${params.reason}` : ""}${
      params.error ? ` error="${params.error}"` : ""
    }`;
    if (params.outcome === "error") {
      diag.error(payload);
    } else {
      diag.debug(payload);
    }
  }
  emitDiagnosticEvent({
    type: "message.dispatch.completed",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channel: params.channel,
    source: params.source,
    durationMs: params.durationMs,
    outcome: params.outcome,
    reason: params.reason,
    error: params.error,
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

export function logSessionTurnCreated(params: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  trigger: "user" | "heartbeat";
}) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  if (diag.isEnabled("debug")) {
    diag.debug(
      `session turn created: runId=${params.runId} sessionId=${
        params.sessionId ?? "unknown"
      } sessionKey=${params.sessionKey ?? "unknown"} agentId=${
        params.agentId ?? "unknown"
      } channel=${params.channel ?? "unknown"} trigger=${params.trigger}`,
    );
  }
  emitDiagnosticEvent({
    type: "session.turn.created",
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    channel: params.channel,
    trigger: params.trigger,
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
  if (params.state === "processing" && prevState !== "processing") {
    state.activeQueuedTurn = state.queueDepth > 0;
  }
  if (params.state === "idle") {
    state.queueDepth = Math.max(0, state.queueDepth - 1);
    state.activeQueuedTurn = false;
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
    ...(params.activity.repeatedRequestNoProgressAgeMs !== undefined
      ? { repeatedRequestNoProgressAgeMs: params.activity.repeatedRequestNoProgressAgeMs }
      : {}),
    ...(terminalProgressStale ? { terminalProgressStale: true } : {}),
  };
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
  if (activity.repeatedRequestNoProgressAgeMs !== undefined) {
    fields.push(
      `repeatedRequestNoProgressAge=${Math.round(activity.repeatedRequestNoProgressAgeMs / 1000)}s`,
    );
  }
  if (isTerminalDiagnosticProgressReason(activity.lastProgressReason)) {
    fields.push("terminalProgressStale=true");
  }
  return fields.join(" ");
}

function logSessionAttention(
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
  const stuckSessionAbortMs =
    params.abortThresholdMs ?? resolveStalledEmbeddedRunAbortMs(params.thresholdMs);
  const queueDepth = resolveDiagnosticQueuedBacklog(state);
  const classification = classifySessionAttention({
    state: state.state as "idle" | "processing" | "waiting" | undefined,
    queueDepth,
    activity,
    staleMs: params.thresholdMs,
    stuckSessionAbortMs,
  });
  const recoveryEligible =
    classification.recoveryEligible ||
    isActiveAbortRecoveryEligible({
      classification,
      activity,
      stuckSessionAbortMs,
    });
  // The warning backoff throttles repeated log lines/events only. It must never
  // gate recovery: a recovery-eligible session has to return its classification
  // so the heartbeat can still schedule recovery on every tick.
  let suppressWarning = false;
  if (classification.eventType === "session.stuck") {
    const nextWarnAgeMs =
      state.lastStuckWarnAgeMs === undefined
        ? params.thresholdMs
        : Math.max(state.lastStuckWarnAgeMs + params.thresholdMs, state.lastStuckWarnAgeMs * 2);
    if (params.ageMs < nextWarnAgeMs) {
      if (!recoveryEligible) {
        return undefined;
      }
      suppressWarning = true;
    } else {
      state.lastStuckWarnAgeMs = params.ageMs;
    }
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
      if (!recoveryEligible) {
        return undefined;
      }
      suppressWarning = true;
    } else {
      state.lastLongRunningWarnAgeMs = params.ageMs;
    }
  }
  if (suppressWarning) {
    // Throttled warning, but recovery-eligible: skip the log/event and return
    // the classification so the heartbeat can drive recovery.
    return classification;
  }
  const label =
    classification.eventType === "session.stuck"
      ? "stuck session"
      : classification.eventType === "session.stalled"
        ? "stalled session"
        : "long-running session";
  const activityFields = formatSessionActivityLogFields(activity);
  const sessionFields = formatCronSessionDiagnosticFields(
    resolveCronSessionDiagnosticContext({
      sessionKey: state.sessionKey,
      activeSessionId: state.sessionId,
    }),
  );
  const detailFields = [activityFields, sessionFields].filter(Boolean).join(" ");
  const message = `${label}: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
    state.sessionKey ?? "unknown"
  } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${
    queueDepth
  } reason=${classification.reason} classification=${classification.classification}${
    classification.activeWorkKind ? ` activeWorkKind=${classification.activeWorkKind}` : ""
  }${detailFields ? ` ${detailFields}` : ""} recovery=${recoveryEligible ? "checking" : "none"}`;
  if (classification.eventType === "session.long_running" && queueDepth <= 0) {
    diag.debug(message);
  } else {
    diag.warn(message);
  }
  const baseEvent = {
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth,
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

export function logToolLoopAction(
  params: SessionRef & {
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector:
      | "generic_repeat"
      | "argument_churn"
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

let heartbeatInterval: NodeJS.Timeout | null = null;
let lastDiagnosticHeartbeatTickAt: number | undefined;

export function startDiagnosticHeartbeat(
  config?: OpenClawConfig,
  opts?: StartDiagnosticHeartbeatOptions,
) {
  if (!areDiagnosticsEnabledForProcess() || !isDiagnosticsEnabled(config)) {
    return;
  }
  // The heartbeat owns run-activity event tracking for its full lifecycle.
  // Importing diagnostic helpers must not seed process-global listeners.
  startDiagnosticRunActivityTracking();
  startDiagnosticStabilityRecorder();
  installDiagnosticStabilityFatalHook();
  if (heartbeatInterval) {
    return;
  }
  // Gateway supplies its lifecycle-owned monitor; other runtimes retain the
  // built-in sampler. Never allocate two perf monitors for one heartbeat.
  if (!opts?.sampleLiveness) {
    startDiagnosticLivenessSampler();
  }
  const livenessGraceUntil =
    opts?.startupGraceMs != null && opts.startupGraceMs > 0 ? Date.now() + opts.startupGraceMs : 0;
  lastDiagnosticHeartbeatTickAt = Date.now();
  heartbeatInterval = setInterval(() => {
    let heartbeatConfig = config;
    if (!heartbeatConfig) {
      try {
        heartbeatConfig = (opts?.getConfig ?? getRuntimeConfig)();
      } catch {
        heartbeatConfig = undefined;
      }
    }
    const stuckSessionWarnMs = opts?.testTimings?.stuckSessionWarnMs ?? resolveStuckSessionWarnMs();
    const stuckSessionAbortMs =
      opts?.testTimings?.stuckSessionAbortMs ?? resolveStuckSessionAbortMs(stuckSessionWarnMs);
    const compactionSafetyTimeoutMs = resolveCompactionTimeoutMs(heartbeatConfig);
    const now = Date.now();
    const heartbeatElapsedMs =
      lastDiagnosticHeartbeatTickAt === undefined ? 0 : now - lastDiagnosticHeartbeatTickAt;
    lastDiagnosticHeartbeatTickAt = now;
    const heartbeatOverdueMs = Math.max(0, heartbeatElapsedMs - DIAGNOSTIC_HEARTBEAT_INTERVAL_MS);
    const inStartupGrace = livenessGraceUntil > 0 && now < livenessGraceUntil;
    // Observe ordinary timer jitter at the scheduled tick so it cannot consume
    // a run's remaining recovery budget. Material lateness can also hide queued
    // progress events, so the next healthy heartbeat owns recovery instead.
    const recoveryObservationNow = now - heartbeatOverdueMs;
    const shouldDeferRecovery = heartbeatOverdueMs >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS;
    if (shouldDeferRecovery && !inStartupGrace) {
      diag.warn(
        `liveness heartbeat delayed: overdue=${Math.round(heartbeatOverdueMs)}ms elapsed=${Math.round(heartbeatElapsedMs)}ms; deferring recovery decisions`,
      );
    }
    pruneDiagnosticSessionStates(now, true);
    const work = getDiagnosticWorkSnapshot(now);
    const continuationQueue = safeGetDiagnosticContinuationQueueMetrics(now);
    const rawLivenessSample = (opts?.sampleLiveness ?? sampleDiagnosticLiveness)(now, work);
    // Keep sampling during grace so event-loop delay baselines reset, but suppress startup-only reports.
    const livenessSample = inStartupGrace ? null : rawLivenessSample;
    const shouldEmitLivenessEvent =
      livenessSample !== null && shouldEmitDiagnosticLivenessEvent(now);
    const shouldEmitLivenessWarning =
      livenessSample !== null && shouldEmitDiagnosticLivenessWarning(now, work, continuationQueue);
    const hasContinuationActivity = hasContinuationQueueActivity(continuationQueue);
    const shouldEmitLivenessReport = shouldEmitLivenessEvent || shouldEmitLivenessWarning;
    const shouldRecordMemorySample =
      shouldEmitLivenessReport ||
      hasRecentDiagnosticActivity(now) ||
      hasOpenDiagnosticWork(work) ||
      hasContinuationActivity;
    if (opts?.emitMemorySample) {
      opts.emitMemorySample({ emitSample: shouldRecordMemorySample });
    } else {
      emitDiagnosticMemorySample({
        emitSample: shouldRecordMemorySample,
      });
    }

    if (!shouldRecordMemorySample) {
      return;
    }

    if (shouldEmitLivenessReport && livenessSample) {
      emitDiagnosticLivenessWarning(livenessSample, work, continuationQueue, now);
    }

    if (hasContinuationActivity) {
      emitDiagnosticContinuationQueueSample(continuationQueue);
    }

    diag.debug(
      `heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${work.activeCount} waiting=${work.waitingCount} queued=${work.queuedCount}${formatContinuationQueueLogSuffix(continuationQueue)}`,
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
      .catch((err: unknown) => {
        diag.debug(`command-poll-backoff prune failed: ${String(err)}`);
      });

    for (const [, state] of diagnosticSessionStates) {
      const ageMs = recoveryObservationNow - state.lastActivity;
      const activity = getDiagnosticSessionActivitySnapshot(
        { sessionId: state.sessionId, sessionKey: state.sessionKey },
        recoveryObservationNow,
      );
      const idleQueuedRecoverableStall = isIdleQueuedRecoverableSessionStall({
        state,
        activity,
        staleMs: stuckSessionWarnMs,
      });
      // Inbound traffic refreshes session age; owned work stalls on its progress clock.
      const ownedWorkAgeMs = activity.activeWorkKind ? (activity.lastProgressAgeMs ?? 0) : 0;
      const attentionAgeMs = idleQueuedRecoverableStall
        ? (activity.lastProgressAgeMs ?? ageMs)
        : Math.max(ageMs, activity.repeatedRequestNoProgressAgeMs ?? 0, ownedWorkAgeMs);
      if (
        (state.state === "processing" && attentionAgeMs > stuckSessionWarnMs) ||
        idleQueuedRecoverableStall
      ) {
        const classification = logSessionAttention({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          state: state.state,
          ageMs: attentionAgeMs,
          thresholdMs: stuckSessionWarnMs,
          abortThresholdMs: stuckSessionAbortMs,
        });
        if (!classification || shouldDeferRecovery) {
          continue;
        }
        const activeAbortEligible =
          !classification.recoveryEligible &&
          isActiveAbortRecoveryEligible({
            classification,
            activity,
            stuckSessionAbortMs,
          });
        if (!classification.recoveryEligible && !activeAbortEligible) {
          continue;
        }
        requestStuckSessionRecovery({
          recover: opts?.recoverStuckSession ?? recoverStuckSession,
          classification,
          request: {
            sessionId: state.sessionId,
            sessionKey: state.sessionKey,
            sessionFile: state.sessionFile,
            ageMs: attentionAgeMs,
            queueDepth: resolveDiagnosticQueuedBacklog(state),
            expectedState: state.state,
            stateGeneration: state.generation,
            ...(activeAbortEligible
              ? { allowActiveAbort: true }
              : { staleActiveProgressAbortMs: stuckSessionAbortMs }),
            compactionSafetyTimeoutMs,
          },
        });
      }
    }
  }, DIAGNOSTIC_HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref?.();
}

export function stopDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  lastDiagnosticHeartbeatTickAt = undefined;
  stopDiagnosticRunActivityTracking();
  stopDiagnosticLivenessSampler();
  stopDiagnosticStabilityRecorder();
  uninstallDiagnosticStabilityFatalHook();
}

function resetDiagnosticStateForTest(): void {
  stopDiagnosticHeartbeat();
  resetDiagnosticSessionRecoveryCoordinatorForTest();
  resetDiagnosticSessionStateForTest();
  resetDiagnosticActivityForTest();
  resetDiagnosticRunActivityForTest();
  webhookStats.received = 0;
  webhookStats.processed = 0;
  webhookStats.errors = 0;
  webhookStats.lastReceived = 0;
  resetDiagnosticMemoryForTest();
  resetDiagnosticPhasesForTest();
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticStabilityBundleForTest();
}

const testing = {
  resetDiagnosticStateForTest,
  resolveStuckSessionAbortMs,
  resolveStuckSessionWarnMs,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.diagnosticTestApi")] = testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
