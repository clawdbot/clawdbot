// Coordinates atomic host suspension preparation and terminal-policy-aware drain leases.
import { randomUUID } from "node:crypto";
import type {
  GatewaySuspendPrepareParams,
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

const GATEWAY_SUSPEND_TTL_MS = 2 * 60_000;
const GATEWAY_SUSPEND_RETRY_AFTER_MS = 20_000;
const GATEWAY_SCHEDULER_RECOVERY_RETRY_MS = 1_000;

type GatewaySuspendTerminalPolicy = NonNullable<GatewaySuspendPrepareParams["terminalPolicy"]>;

type GatewaySchedulerRecoveryResult = {
  status: "recovering";
  reason: "scheduler-resume-failed";
  retryAfterMs: number;
};

type GatewaySuspendPrepareResult =
  | GatewaySuspendPrepareWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

type GatewaySuspendStatusResult =
  | GatewaySuspendStatusWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

type GatewaySuspendResumeResult =
  | GatewaySuspendResumeWireResult
  | { ok: false; reason: "suspension-mismatch" }
  | { ok: false; reason: "scheduler-resume-failed"; retryAfterMs: number };

type GatewaySuspendCoordinatorEntryBase = {
  owner: object;
  resumeScheduling: () => void;
  reopenAdmission: () => boolean;
  warn?: (message: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  timerGeneration?: number;
};

type HeldGatewaySuspension = GatewaySuspendCoordinatorEntryBase & {
  kind: "held";
  requestId: string;
  terminalPolicy: GatewaySuspendTerminalPolicy;
  drain: boolean;
  suspensionId: string;
  expiresAtMs: number;
  phase:
    | {
        status: "draining";
        snapshot: GatewayActiveWorkSnapshot;
        inspect?: Partial<GatewayActiveWorkInspectors>;
        commitAdmission: () => boolean;
      }
    | { status: "ready"; snapshot: GatewayActiveWorkSnapshot };
  nowMs: () => number;
};

type GatewaySchedulerRecovery = GatewaySuspendCoordinatorEntryBase & {
  kind: "recovering";
};

type GatewaySuspendCoordinatorEntry = HeldGatewaySuspension | GatewaySchedulerRecovery;

type GatewaySuspendCoordinatorState = {
  current: GatewaySuspendCoordinatorEntry | null;
  retiredForLifecycleReset?: GatewaySuspendCoordinatorEntry | null;
};

const COORDINATOR_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspendCoordinatorState"),
  (): GatewaySuspendCoordinatorState => ({
    current: null,
    retiredForLifecycleReset: null,
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
  entry.timerGeneration = (entry.timerGeneration ?? 0) + 1;
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
  const generation = entry.timerGeneration;
  entry.timer = setTimeout(() => {
    if (entry.timerGeneration === generation) {
      callback();
    }
  }, delayMs);
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

function refreshHeldSuspension(held: HeldGatewaySuspension): HeldGatewaySuspension["phase"] {
  if (held.phase.status === "ready") {
    return held.phase;
  }
  // Polls and renewals must retain the update's terminal policy until the lease is ready.
  const snapshot = createGatewayActiveWorkSnapshot(held.phase.inspect, {
    ignoreTerminalSessions: held.terminalPolicy === "terminate",
  });
  if (!snapshot.idle) {
    held.phase.snapshot = snapshot;
    return held.phase;
  }
  if (!held.phase.commitAdmission()) {
    throw new Error("gateway suspension admission changed during drain completion");
  }
  held.phase = { status: "ready", snapshot };
  return held.phase;
}

function heldPrepareResult(
  held: HeldGatewaySuspension,
  phase: HeldGatewaySuspension["phase"] = refreshHeldSuspension(held),
): GatewaySuspendPrepareWireResult {
  const result = {
    suspensionId: held.suspensionId,
    expiresAtMs: held.expiresAtMs,
    activeCount: phase.snapshot.counts.totalActive,
    blockers: phase.snapshot.blockers,
  };
  return phase.status === "draining"
    ? { status: "draining", ...result, retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS }
    : { status: "ready", ...result };
}

/** Acquire an idle lease, or optionally preserve existing work behind a drain fence. */
export function prepareGatewaySuspend(params: {
  requestId: string;
  terminalPolicy?: GatewaySuspendTerminalPolicy;
  drain?: boolean;
  pauseScheduling: () => void;
  resumeScheduling: () => void;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  nowMs?: () => number;
  createSuspensionId?: () => string;
  warn?: (message: string) => void;
}): GatewaySuspendPrepareResult {
  const terminalPolicy = params.terminalPolicy ?? "preserve";
  const drain = params.drain === true;
  const activeWorkOptions = {
    ignoreTerminalSessions: terminalPolicy === "terminate",
  };
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
    if (
      existing.requestId !== params.requestId ||
      existing.terminalPolicy !== terminalPolicy ||
      existing.drain !== drain
    ) {
      return { status: "conflict", expiresAtMs: existing.expiresAtMs };
    }
    existing.nowMs = params.nowMs ?? Date.now;
    renewHeldSuspension(existing, nowMs);
    return heldPrepareResult(existing);
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
    // Restart drain must not resume the old scheduler while shutdown is in
    // flight. Keep its cleanup until the next in-process lifecycle begins.
    COORDINATOR_STATE.retiredForLifecycleReset = activeEntry;
  });
  if (!admission) {
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    return {
      status: "busy",
      reason: "gateway-draining",
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
    };
  }

  let schedulingPaused = false;
  let admissionHeld = false;
  try {
    params.pauseScheduling();
    schedulingPaused = true;
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    if (!snapshot.idle && !drain) {
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
    const admissionTransition = snapshot.idle ? admission.commit : admission.drain;
    if (!admissionTransition()) {
      throw new Error("gateway suspension admission changed during preparation");
    }
    admissionHeld = true;
    const suspensionId = (params.createSuspensionId ?? randomUUID)();
    const expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
    const held = armExpiry({
      owner,
      requestId: params.requestId,
      terminalPolicy,
      drain,
      suspensionId,
      expiresAtMs,
      phase: snapshot.idle
        ? { status: "ready", snapshot }
        : {
            status: "draining",
            snapshot,
            inspect: params.inspect,
            commitAdmission: admission.commit,
          },
      reopenAdmission: admission.release,
      resumeScheduling: params.resumeScheduling,
      nowMs: params.nowMs ?? Date.now,
      warn: params.warn,
    });
    COORDINATOR_STATE.current = held;
    return heldPrepareResult(held, held.phase);
  } catch (err) {
    if (schedulingPaused) {
      const resumed = resumeSchedulingBeforeReopen({
        owner,
        resumeScheduling: params.resumeScheduling,
        reopenAdmission: admissionHeld ? admission.release : admission.rollback,
        isInvalidated: () => suspensionInvalidated,
        warn: params.warn,
      });
      if (!resumed) {
        return schedulerRecoveryResult();
      }
    } else if (admissionHeld) {
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
  const phase = refreshHeldSuspension(held);
  if (phase.status === "draining") {
    return {
      status: "draining",
      expiresAtMs: held.expiresAtMs,
      activeCount: phase.snapshot.counts.totalActive,
      blockers: phase.snapshot.blockers,
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
    };
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

function resetGatewaySuspendCoordinator(): void {
  const current = COORDINATOR_STATE.current;
  const retired = COORDINATOR_STATE.retiredForLifecycleReset;
  COORDINATOR_STATE.current = null;
  COORDINATOR_STATE.retiredForLifecycleReset = null;
  const entries = current && current !== retired ? [current, retired] : [current ?? retired];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    clearEntryTimer(entry);
    try {
      entry.resumeScheduling();
    } catch (err) {
      entry.warn?.(`gateway scheduler resume failed during lifecycle reset: ${String(err)}`);
    }
    entry.reopenAdmission();
  }
}

// An in-process restart rebuilds scheduler and admission ownership. Resume and
// discard the old suspension first so paused work cannot leak across lifecycles.
export function resetGatewaySuspendCoordinatorForLifecycleRestart(): void {
  resetGatewaySuspendCoordinator();
}
