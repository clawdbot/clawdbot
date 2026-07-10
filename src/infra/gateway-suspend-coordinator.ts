// Coordinates an atomic, refuse-only host suspension preparation lease.
import { randomUUID } from "node:crypto";
import type {
  GatewaySuspendPrepareResult as GatewaySuspendPrepareWireResult,
  GatewaySuspendResumeResult as GatewaySuspendResumeWireResult,
  GatewaySuspendStatusResult as GatewaySuspendStatusWireResult,
} from "../../packages/gateway-protocol/src/index.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
  type GatewayActiveWorkSnapshot,
} from "./gateway-active-work.js";

export const GATEWAY_SUSPEND_TTL_MS = 2 * 60_000;
export const GATEWAY_SUSPEND_RETRY_AFTER_MS = 20_000;
const GATEWAY_SCHEDULER_RECOVERY_RETRY_MS = 1_000;

type GatewaySchedulerRecoveryResult = {
  status: "recovering";
  reason: "scheduler-resume-failed";
  retryAfterMs: number;
};

export type GatewaySuspendPrepareResult =
  | GatewaySuspendPrepareWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

export type GatewaySuspendStatusResult =
  | GatewaySuspendStatusWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

export type GatewaySuspendResumeResult =
  | GatewaySuspendResumeWireResult
  | { ok: false; reason: "suspension-mismatch" }
  | { ok: false; reason: "scheduler-resume-failed"; retryAfterMs: number };

type GatewaySuspendCoordinatorEntryBase = {
  owner: object;
  resumeScheduling: () => void;
  reopenAdmission: () => boolean;
  warn?: (message: string) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type HeldGatewaySuspension = GatewaySuspendCoordinatorEntryBase & {
  kind: "held";
  requestId: string;
  suspensionId: string;
  expiresAtMs: number;
  snapshot: GatewayActiveWorkSnapshot;
  nowMs: () => number;
};

type GatewaySchedulerRecovery = GatewaySuspendCoordinatorEntryBase & {
  kind: "recovering";
};

type GatewaySuspendCoordinatorEntry = HeldGatewaySuspension | GatewaySchedulerRecovery;

type GatewaySuspendCoordinatorState = {
  current: GatewaySuspendCoordinatorEntry | null;
};

const COORDINATOR_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspendCoordinatorState"),
  (): GatewaySuspendCoordinatorState => ({
    current: null,
  }),
);

function schedulerRecoveryResult(): GatewaySchedulerRecoveryResult {
  return {
    status: "recovering",
    reason: "scheduler-resume-failed",
    retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
  };
}

function clearEntryTimer(entry: GatewaySuspendCoordinatorEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}

function scheduleEntry(
  entry: GatewaySuspendCoordinatorEntry,
  delayMs: number,
  callback: () => void,
): void {
  clearEntryTimer(entry);
  entry.timer = setTimeout(callback, delayMs);
  entry.timer.unref?.();
}

function resumeAndReopen(entry: GatewaySuspendCoordinatorEntry): boolean {
  try {
    entry.resumeScheduling();
  } catch (err) {
    entry.warn?.(`gateway scheduler recovery failed: ${String(err)}`);
    enterSchedulerRecovery(entry);
    return false;
  }
  if (COORDINATOR_STATE.current !== entry) {
    return true;
  }
  if (!entry.reopenAdmission()) {
    entry.warn?.("gateway scheduler recovery could not reopen admission");
    enterSchedulerRecovery(entry);
    return false;
  }
  clearEntryTimer(entry);
  COORDINATOR_STATE.current = null;
  return true;
}

function enterSchedulerRecovery(entry: GatewaySuspendCoordinatorEntry): void {
  if (COORDINATOR_STATE.current !== entry) {
    return;
  }
  if (entry.kind === "recovering") {
    scheduleRecoveryRetry(entry);
    return;
  }
  clearEntryTimer(entry);
  const recovery: GatewaySchedulerRecovery = {
    kind: "recovering",
    owner: entry.owner,
    resumeScheduling: entry.resumeScheduling,
    reopenAdmission: entry.reopenAdmission,
    warn: entry.warn,
  };
  COORDINATOR_STATE.current = recovery;
  scheduleRecoveryRetry(recovery);
}

function scheduleRecoveryRetry(entry: GatewaySuspendCoordinatorEntry): void {
  scheduleEntry(entry, GATEWAY_SCHEDULER_RECOVERY_RETRY_MS, () => {
    if (COORDINATOR_STATE.current === entry) {
      resumeAndReopen(entry);
    }
  });
}

function normalizeExpiredHeldSuspension(
  held: HeldGatewaySuspension,
): GatewaySuspendCoordinatorEntry | null {
  if (held.nowMs() < held.expiresAtMs) {
    return held;
  }
  resumeAndReopen(held);
  return COORDINATOR_STATE.current;
}

function armSchedulerRecovery(
  recovery: Omit<GatewaySchedulerRecovery, "kind">,
): GatewaySchedulerRecovery {
  const entry: GatewaySchedulerRecovery = { kind: "recovering", ...recovery };
  scheduleRecoveryRetry(entry);
  return entry;
}

// Rollback stays fail-closed: scheduler recovery must finish before admission
// reopens, otherwise an old retry can resume scheduling under a newer lease.
function resumeSchedulingBeforeReopen(params: {
  owner: object;
  resumeScheduling: () => void;
  reopenAdmission: () => boolean;
  isInvalidated: () => boolean;
  warn?: (message: string) => void;
}): boolean {
  if (params.isInvalidated()) {
    return true;
  }
  try {
    params.resumeScheduling();
  } catch (err) {
    params.warn?.(`gateway scheduler resume failed during suspension rollback: ${String(err)}`);
    COORDINATOR_STATE.current = armSchedulerRecovery({
      owner: params.owner,
      resumeScheduling: params.resumeScheduling,
      reopenAdmission: params.reopenAdmission,
      warn: params.warn,
    });
    return false;
  }
  if (!params.isInvalidated()) {
    params.reopenAdmission();
  }
  return true;
}

function armExpiry(held: Omit<HeldGatewaySuspension, "kind">): HeldGatewaySuspension {
  const entry: HeldGatewaySuspension = { kind: "held", ...held };
  scheduleEntry(entry, GATEWAY_SUSPEND_TTL_MS, () => {
    if (COORDINATOR_STATE.current === entry) {
      resumeAndReopen(entry);
    }
  });
  return entry;
}

function renewHeldSuspension(held: HeldGatewaySuspension, nowMs: number): void {
  held.expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
  scheduleEntry(held, GATEWAY_SUSPEND_TTL_MS, () => {
    if (COORDINATOR_STATE.current === held) {
      resumeAndReopen(held);
    }
  });
}

/** Acquire, inspect, and either roll back immediately or hold an idle fence. */
export function prepareGatewaySuspend(params: {
  requestId: string;
  pauseScheduling: () => void;
  resumeScheduling: () => void;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  nowMs?: () => number;
  createSuspensionId?: () => string;
  warn?: (message: string) => void;
}): GatewaySuspendPrepareResult {
  const nowMs = (params.nowMs ?? Date.now)();
  const current = COORDINATOR_STATE.current;
  if (current?.kind === "recovering") {
    return schedulerRecoveryResult();
  }
  const existing = current ? normalizeExpiredHeldSuspension(current) : null;
  if (existing?.kind === "recovering") {
    return schedulerRecoveryResult();
  }
  if (existing) {
    if (existing.requestId !== params.requestId) {
      return { status: "conflict", expiresAtMs: existing.expiresAtMs };
    }
    existing.nowMs = params.nowMs ?? Date.now;
    renewHeldSuspension(existing, nowMs);
    return {
      status: "ready",
      suspensionId: existing.suspensionId,
      expiresAtMs: existing.expiresAtMs,
      activeCount: existing.snapshot.counts.totalActive,
      blockers: existing.snapshot.blockers,
    };
  }

  const owner = {};
  let suspensionInvalidated = false;
  const admission = tryBeginGatewaySuspendAdmission(() => {
    suspensionInvalidated = true;
    const activeEntry = COORDINATOR_STATE.current;
    if (activeEntry?.owner !== owner) {
      return;
    }
    clearEntryTimer(activeEntry);
    COORDINATOR_STATE.current = null;
  });
  if (!admission) {
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect);
    return {
      status: "busy",
      reason: "gateway-draining",
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
    };
  }

  let schedulingPaused = false;
  let admissionCommitted = false;
  try {
    params.pauseScheduling();
    schedulingPaused = true;
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect);
    if (!snapshot.idle) {
      const resumed = resumeSchedulingBeforeReopen({
        owner,
        resumeScheduling: params.resumeScheduling,
        reopenAdmission: admission.rollback,
        isInvalidated: () => suspensionInvalidated,
        warn: params.warn,
      });
      schedulingPaused = false;
      if (!resumed) {
        return schedulerRecoveryResult();
      }
      return {
        status: "busy",
        reason: "active-work",
        retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
        activeCount: snapshot.counts.totalActive,
        blockers: snapshot.blockers,
      };
    }
    if (!admission.commit()) {
      throw new Error("gateway suspension admission changed during preparation");
    }
    admissionCommitted = true;
    const suspensionId = (params.createSuspensionId ?? randomUUID)();
    const expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
    const held = armExpiry({
      owner,
      requestId: params.requestId,
      suspensionId,
      expiresAtMs,
      snapshot,
      reopenAdmission: admission.release,
      resumeScheduling: params.resumeScheduling,
      nowMs: params.nowMs ?? Date.now,
      warn: params.warn,
    });
    COORDINATOR_STATE.current = held;
    return {
      status: "ready",
      suspensionId,
      expiresAtMs,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
    };
  } catch (err) {
    if (schedulingPaused) {
      const resumed = resumeSchedulingBeforeReopen({
        owner,
        resumeScheduling: params.resumeScheduling,
        reopenAdmission: admissionCommitted ? admission.release : admission.rollback,
        isInvalidated: () => suspensionInvalidated,
        warn: params.warn,
      });
      if (!resumed) {
        return schedulerRecoveryResult();
      }
    } else if (admissionCommitted) {
      admission.release();
    } else {
      admission.rollback();
    }
    throw err;
  }
}

export function getGatewaySuspendStatus(suspensionId: string): GatewaySuspendStatusResult {
  const current = COORDINATOR_STATE.current;
  if (current?.kind === "recovering") {
    return schedulerRecoveryResult();
  }
  const held = current ? normalizeExpiredHeldSuspension(current) : null;
  if (held?.kind === "recovering") {
    return schedulerRecoveryResult();
  }
  if (!held) {
    return { status: "running" };
  }
  if (held.suspensionId !== suspensionId) {
    return { status: "conflict", expiresAtMs: held.expiresAtMs };
  }
  return { status: "ready", expiresAtMs: held.expiresAtMs };
}

export function resumeGatewaySuspend(suspensionId: string): GatewaySuspendResumeResult {
  const current = COORDINATOR_STATE.current;
  if (current?.kind === "recovering") {
    return {
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
    };
  }
  const held = current ? normalizeExpiredHeldSuspension(current) : null;
  if (held?.kind === "recovering") {
    return {
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
    };
  }
  if (!held) {
    return {
      ok: true,
      status: "running",
      resumed: false,
    };
  }
  if (held.suspensionId !== suspensionId) {
    return { ok: false, reason: "suspension-mismatch" };
  }
  if (!resumeAndReopen(held)) {
    return {
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
    };
  }
  return {
    ok: true,
    status: "running",
    resumed: true,
  };
}

export function resetGatewaySuspendCoordinatorForTest(): void {
  const current = COORDINATOR_STATE.current;
  if (current) {
    clearEntryTimer(current);
    try {
      current.resumeScheduling();
    } catch (err) {
      current.warn?.(`gateway scheduler resume failed during test reset: ${String(err)}`);
    }
    current.reopenAdmission();
    COORDINATOR_STATE.current = null;
  }
}
