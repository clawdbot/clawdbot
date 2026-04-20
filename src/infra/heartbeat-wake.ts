import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  isHeartbeatActionWakeReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeRequest = {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
};

export type HeartbeatWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;

let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

export function areHeartbeatsEnabled(): boolean {
  return heartbeatsEnabled;
}

type WakeTimerKind = "normal" | "retry";
type PendingWakeReason = {
  reason: string;
  priority: number;
  requestedAt: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
};

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
const pendingWakes = new Map<string, PendingWakeReason>();
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let timerKind: WakeTimerKind | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

function resolveReasonPriority(reason: string): number {
  const kind = resolveHeartbeatReasonKind(reason);
  if (kind === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (kind === "interval") {
    return REASON_PRIORITY.INTERVAL;
  }
  if (isHeartbeatActionWakeReason(reason)) {
    return REASON_PRIORITY.ACTION;
  }
  return REASON_PRIORITY.DEFAULT;
}

function normalizeWakeReason(reason?: string): string {
  return normalizeHeartbeatWakeReason(reason);
}

function normalizeWakeTarget(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed || undefined;
}

function getWakeTargetKey(params: { agentId?: string; sessionKey?: string }) {
  const agentId = normalizeWakeTarget(params.agentId);
  const sessionKey = normalizeWakeTarget(params.sessionKey);
  return `${agentId ?? ""}::${sessionKey ?? ""}`;
}

function queuePendingWakeReason(params?: {
  reason?: string;
  requestedAt?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
}) {
  const requestedAt = params?.requestedAt ?? Date.now();
  const normalizedReason = normalizeWakeReason(params?.reason);
  const normalizedAgentId = normalizeWakeTarget(params?.agentId);
  const normalizedSessionKey = normalizeWakeTarget(params?.sessionKey);
  const wakeTargetKey = getWakeTargetKey({
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  });
  const next: PendingWakeReason = {
    reason: normalizedReason,
    priority: resolveReasonPriority(normalizedReason),
    requestedAt,
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
    heartbeat: params?.heartbeat,
  };
  const previous = pendingWakes.get(wakeTargetKey);
  if (!previous) {
    pendingWakes.set(wakeTargetKey, next);
    return;
  }
  const merged =
    (next.heartbeat ?? previous.heartbeat)
      ? { ...next, heartbeat: next.heartbeat ?? previous.heartbeat }
      : next;
  if (next.priority > previous.priority) {
    pendingWakes.set(wakeTargetKey, merged);
    return;
  }
  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    pendingWakes.set(wakeTargetKey, merged);
  }
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;
  if (timer) {
    // Keep retry cooldown as a hard minimum delay. This prevents the
    // finally-path reschedule (often delay=0) from collapsing backoff.
    if (timerKind === "retry") {
      return;
    }
    // If existing timer fires sooner or at the same time, keep it.
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }
    // New request needs to fire sooner — preempt the existing timer.
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
    timerKind = null;
  }
  timerDueAt = dueAt;
  timerKind = kind;
  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;
    const active = handler;
    if (!active) {
      return;
    }
    if (running) {
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const pendingBatch = Array.from(pendingWakes.values());
    pendingWakes.clear();
    running = true;
    try {
      for (const pendingWake of pendingBatch) {
        const wakeOpts = {
          reason: pendingWake.reason ?? undefined,
          ...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
          ...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
          ...(pendingWake.heartbeat ? { heartbeat: pendingWake.heartbeat } : {}),
        };
        const res = await active(wakeOpts);
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          // The main lane is busy; retry this wake target soon.
          queuePendingWakeReason({
            reason: pendingWake.reason ?? "retry",
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
            heartbeat: pendingWake.heartbeat,
          });
          schedule(DEFAULT_RETRY_MS, "retry");
        }
      }
    } catch {
      // Error is already logged by the heartbeat runner; schedule a retry.
      for (const pendingWake of pendingBatch) {
        queuePendingWakeReason({
          reason: pendingWake.reason ?? "retry",
          agentId: pendingWake.agentId,
          sessionKey: pendingWake.sessionKey,
          heartbeat: pendingWake.heartbeat,
        });
      }
      schedule(DEFAULT_RETRY_MS, "retry");
    } finally {
      running = false;
      if (pendingWakes.size > 0 || scheduled) {
        schedule(delay, "normal");
      }
    }
  }, delay);
  timer.unref?.();
}

/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next;
  if (next) {
    // New lifecycle starting (e.g. after SIGUSR1 in-process restart).
    // Clear any timer metadata from the previous lifecycle so stale retry
    // cooldowns do not delay a fresh handler.
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    timerKind = null;
    // Reset module-level execution state that may be stale from interrupted
    // runs in the previous lifecycle. Without this, `running === true` from
    // an interrupted heartbeat blocks all future schedule() attempts, and
    // `scheduled === true` can cause spurious immediate re-runs.
    running = false;
    scheduled = false;
  }
  if (handler && pendingWakes.size > 0) {
    schedule(DEFAULT_COALESCE_MS, "normal");
  }
  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== next) {
      return;
    }
    handlerGeneration += 1;
    handler = null;
  };
}

export function requestHeartbeatNow(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
}) {
  queuePendingWakeReason({
    reason: opts?.reason,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
    heartbeat: opts?.heartbeat,
  });
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

export function hasHeartbeatWakeHandler() {
  return handler !== null;
}

export function hasPendingHeartbeatWake() {
  return pendingWakes.size > 0 || Boolean(timer) || scheduled;
}

export function resetHeartbeatWakeStateForTests() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  timerKind = null;
  pendingWakes.clear();
  scheduled = false;
  running = false;
  handlerGeneration += 1;
  handler = null;
}
