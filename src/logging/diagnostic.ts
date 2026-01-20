import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "./subsystem.js";

const diag = createSubsystemLogger("diagnostic");

type SessionStateValue = "idle" | "processing" | "waiting";

type SessionState = {
  sessionId?: string;
  sessionKey?: string;
  lastActivity: number;
  state: SessionStateValue;
  queueDepth: number;
};

type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
};

const sessionStates = new Map<string, SessionState>();

const webhookStats = {
  received: 0,
  processed: 0,
  errors: 0,
  lastReceived: 0,
};

let lastActivityAt = 0;

function markActivity() {
  lastActivityAt = Date.now();
}

function resolveSessionKey({ sessionKey, sessionId }: SessionRef) {
  return sessionKey ?? sessionId ?? "unknown";
}

function getSessionState(ref: SessionRef): SessionState {
  const key = resolveSessionKey(ref);
  const existing = sessionStates.get(key);
  if (existing) {
    if (ref.sessionId) existing.sessionId = ref.sessionId;
    if (ref.sessionKey) existing.sessionKey = ref.sessionKey;
    return existing;
  }
  const created: SessionState = {
    sessionId: ref.sessionId,
    sessionKey: ref.sessionKey,
    lastActivity: Date.now(),
    state: "idle",
    queueDepth: 0,
  };
  sessionStates.set(key, created);
  return created;
}

export function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}) {
  webhookStats.received += 1;
  webhookStats.lastReceived = Date.now();
  diag.info(
    `webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
      params.chatId ?? "unknown"
    } total=${webhookStats.received}`,
  );
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
  webhookStats.processed += 1;
  diag.info(
    `webhook processed: channel=${params.channel} type=${
      params.updateType ?? "unknown"
    } chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${
      webhookStats.processed
    }`,
  );
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
  const state = getSessionState(params);
  state.queueDepth += 1;
  state.lastActivity = Date.now();
  diag.info(
    `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
  );
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
  } else if (params.outcome === "skipped") {
    diag.debug(payload);
  } else {
    diag.info(payload);
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
  const state = getSessionState(params);
  const prevState = state.state;
  state.state = params.state;
  state.lastActivity = Date.now();
  if (params.state === "idle") state.queueDepth = Math.max(0, state.queueDepth - 1);
  diag.info(
    `session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${
      state.queueDepth
    }`,
  );
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
  const state = getSessionState(params);
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

export function logLaneEnqueue(lane: string, queueSize: number) {
  diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markActivity();
}

export function logLaneDequeue(lane: string, waitMs: number, queueSize: number) {
  diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markActivity();
}

export function logRunAttempt(params: SessionRef & { runId: string; attempt: number }) {
  diag.info(
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

export function logActiveRuns() {
  const activeSessions = Array.from(sessionStates.entries())
    .filter(([, s]) => s.state === "processing")
    .map(
      ([id, s]) =>
        `${id}(q=${s.queueDepth},age=${Math.round((Date.now() - s.lastActivity) / 1000)}s)`,
    );
  diag.info(`active runs: count=${activeSessions.length} sessions=[${activeSessions.join(", ")}]`);
  markActivity();
}

let heartbeatInterval: NodeJS.Timeout | null = null;

export function startDiagnosticHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const activeCount = Array.from(sessionStates.values()).filter(
      (s) => s.state === "processing",
    ).length;
    const waitingCount = Array.from(sessionStates.values()).filter(
      (s) => s.state === "waiting",
    ).length;
    const totalQueued = Array.from(sessionStates.values()).reduce(
      (sum, s) => sum + s.queueDepth,
      0,
    );
    const hasActivity =
      lastActivityAt > 0 ||
      webhookStats.received > 0 ||
      activeCount > 0 ||
      waitingCount > 0 ||
      totalQueued > 0;
    if (!hasActivity) return;
    if (now - lastActivityAt > 120_000 && activeCount === 0 && waitingCount === 0) return;

    diag.info(
      `heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${activeCount} waiting=${waitingCount} queued=${totalQueued}`,
    );
    emitDiagnosticEvent({
      type: "diagnostic.heartbeat",
      webhooks: {
        received: webhookStats.received,
        processed: webhookStats.processed,
        errors: webhookStats.errors,
      },
      active: activeCount,
      waiting: waitingCount,
      queued: totalQueued,
    });

    for (const [, state] of sessionStates) {
      const ageMs = now - state.lastActivity;
      if (state.state === "processing" && ageMs > 120_000) {
        logSessionStuck({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          state: state.state,
          ageMs,
        });
      }
    }
  }, 30_000);
}

export function stopDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export { diag as diagnosticLogger };
