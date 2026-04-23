import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
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
let commandPollBackoffRuntimePromise: Promise<
  typeof import("../agents/command-poll-backoff.runtime.js")
> | null = null;

type EmitDiagnosticMemorySample = typeof emitDiagnosticMemorySample;

type DiagnosticWorkSnapshot = {
  activeCount: number;
  waitingCount: number;
  queuedCount: number;
};

function loadCommandPollBackoffRuntime() {
  commandPollBackoffRuntimePromise ??= import("../agents/command-poll-backoff.runtime.js");
  return commandPollBackoffRuntimePromise;
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
  diag.warn(
    `stuck session: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${state.queueDepth}`,
  );
  emitDiagnosticEvent({
    type: "session.stuck",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth: state.queueDepth,
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
  opts?: { getConfig?: () => OpenClawConfig; emitMemorySample?: EmitDiagnosticMemorySample },
) {
  if (!areDiagnosticsEnabledForProcess() || !isDiagnosticsEnabled(config)) {
    return;
  }
  startDiagnosticStabilityRecorder();
  installDiagnosticStabilityFatalHook();
  if (heartbeatInterval) {
    return;
  }
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
    const shouldRecordMemorySample =
      hasRecentDiagnosticActivity(now) || hasOpenDiagnosticWork(work);
    (opts?.emitMemorySample ?? emitDiagnosticMemorySample)({
      emitSample: shouldRecordMemorySample,
    });

    if (!shouldRecordMemorySample) {
      return;
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
