// Coordinates process-wide root work admission with reversible host suspension.
import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type GatewaySuspendAdmissionPhase = "accepting" | "preparing" | "prepared";

type AdmissionCloseReason = "restart-signal fence" | "restart drain" | "suspend phase";
type AdmissionReopenReason = "restart-signal fence" | "suspend phase";

export class GatewayDrainingError extends Error {
  constructor(message = "Gateway is draining; new tasks are not accepted") {
    super(message);
    this.name = "GatewayDrainingError";
  }
}

type GatewayRootWorkAdmission = {
  references: number;
  released: boolean;
};

type GatewayWorkAdmissionState = {
  restartDraining: boolean;
  restartSignalPending: boolean;
  restartSignalGeneration: number;
  suspendPhase: GatewaySuspendAdmissionPhase;
  suspendGeneration: number;
  suspendInvalidated?: () => void;
  activeRootWork: Set<GatewayRootWorkAdmission>;
  rootDrainWaiters?: Set<() => void>;
  currentRootWork: AsyncLocalStorage<GatewayRootWorkAdmission>;
  suspendOpenWaiters: Set<() => void>;
};

const admissionLog = createSubsystemLogger("gateway/admission");

const GATEWAY_WORK_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
  (): GatewayWorkAdmissionState => ({
    restartDraining: false,
    restartSignalPending: false,
    restartSignalGeneration: 0,
    suspendPhase: "accepting",
    suspendGeneration: 0,
    activeRootWork: new Set(),
    rootDrainWaiters: new Set(),
    currentRootWork: new AsyncLocalStorage(),
    suspendOpenWaiters: new Set(),
  }),
);

function logAdmissionClosed(reason: AdmissionCloseReason): void {
  admissionLog.info(`admission closed: ${reason}`);
}

function logAdmissionReopened(reason: AdmissionReopenReason): void {
  admissionLog.info(`admission reopened: ${reason}`);
}

type GatewayRootWorkAdmissionLease = {
  ownsRoot: boolean;
  release: () => void;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

type GatewaySuspendAdmissionLease = {
  commit: () => boolean;
  rollback: () => boolean;
  release: () => boolean;
};

export type GatewayRestartSignalAdmissionLease = {
  rollback: () => boolean;
};

function createGatewayRootWorkAdmission(): GatewayRootWorkAdmissionLease {
  const admission: GatewayRootWorkAdmission = { references: 1, released: false };
  GATEWAY_WORK_ADMISSION_STATE.activeRootWork.add(admission);
  const release = createGatewayRootWorkRelease(admission);
  return {
    ownsRoot: true,
    release,
    run: async <T>(run: () => Promise<T>) =>
      await GATEWAY_WORK_ADMISSION_STATE.currentRootWork.run(admission, run),
  };
}

function createGatewayRootWorkRelease(admission: GatewayRootWorkAdmission): () => void {
  let leaseReleased = false;
  return () => {
    if (leaseReleased || admission.released) {
      return;
    }
    leaseReleased = true;
    admission.references -= 1;
    if (admission.references > 0) {
      return;
    }
    admission.released = true;
    GATEWAY_WORK_ADMISSION_STATE.activeRootWork.delete(admission);
    if (GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size === 0) {
      resolveRootDrainWaiters();
    }
  };
}

function resolveRootDrainWaiters(): void {
  const rootDrainWaiters = GATEWAY_WORK_ADMISSION_STATE.rootDrainWaiters;
  if (!rootDrainWaiters) {
    return;
  }
  const waiters = Array.from(rootDrainWaiters);
  rootDrainWaiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

function invalidateSuspendAdmission(): void {
  const callback = GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated;
  const wasClosed = GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting";
  GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated = undefined;
  GATEWAY_WORK_ADMISSION_STATE.suspendPhase = "accepting";
  GATEWAY_WORK_ADMISSION_STATE.suspendGeneration += 1;
  resolveSuspendOpenWaiters();
  // Restart drain supersedes suspension without reopening process admission.
  if (wasClosed && !GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
    logAdmissionReopened("suspend phase");
  }
  callback?.();
}

function clearRestartSignalFence(): boolean {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    !GATEWAY_WORK_ADMISSION_STATE.restartSignalPending
  ) {
    return false;
  }
  GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = false;
  GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration += 1;
  resolveSuspendOpenWaiters();
  logAdmissionReopened("restart-signal fence");
  return true;
}

function resolveSuspendOpenWaiters(): void {
  const waiters = Array.from(GATEWAY_WORK_ADMISSION_STATE.suspendOpenWaiters);
  GATEWAY_WORK_ADMISSION_STATE.suspendOpenWaiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

/** True while restart signal/drain or host suspension rejects new process work. */
export function isGatewayWorkAdmissionClosed(): boolean {
  return (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting"
  );
}

/** Existing admitted roots may finish spawning subordinate command/session work.
 * New async chains still see the global fence, preserving refuse-only suspension. */
export function isGatewaySubordinateWorkAdmissionClosed(): boolean {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending
  ) {
    return true;
  }
  const current = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (current) {
    // Reset/release retires inherited ALS descendants. They must explicitly
    // re-enter admission instead of spawning untracked subordinate work.
    return current.released;
  }
  return GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting";
}

export function getGatewaySuspendAdmissionPhase(): GatewaySuspendAdmissionPhase {
  return GATEWAY_WORK_ADMISSION_STATE.suspendPhase;
}

export function isGatewayRestartDraining(): boolean {
  return (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending
  );
}

/** Restart drain is one-way until the in-process restart resets runtime state. */
export function markGatewayRestartDraining(): void {
  if (GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
    return;
  }
  // Drain supersedes the reversible signal fence; do not reopen before the
  // one-way close, or waiters could briefly admit work into a dying process.
  GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = false;
  GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration += 1;
  GATEWAY_WORK_ADMISSION_STATE.restartDraining = true;
  resolveSuspendOpenWaiters();
  logAdmissionClosed("restart drain");
  if (GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting") {
    // A restart supersedes a reversible suspension. The coordinator callback
    // drops its timer/token without reopening the scheduler being shut down.
    invalidateSuspendAdmission();
  }
}

/**
 * Blocks suspension across signal emission until the run loop starts restart drain.
 * Returns null when another owner already holds the fence or one-way drain is active.
 * Callers must not invent a stand-in lease: a dead rollback handle is how the fence
 * can stay closed after the real owner is lost.
 */
export function beginGatewayRestartSignalAdmission(): GatewayRestartSignalAdmissionLease | null {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending
  ) {
    return null;
  }
  GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = true;
  const generation = ++GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration;
  logAdmissionClosed("restart-signal fence");
  return {
    rollback: () => {
      if (
        !GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
        GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration !== generation
      ) {
        return false;
      }
      return clearRestartSignalFence();
    },
  };
}

/**
 * Reopens a reversible restart-signal fence that no longer has a live lease.
 * No-op while one-way restart drain owns admission.
 */
export function rollbackGatewayRestartSignalFence(): boolean {
  return clearRestartSignalFence();
}

/** Root RPC/timer admission. Nested work in the same async chain counts once. */
export function tryBeginGatewayRootWorkAdmission(): GatewayRootWorkAdmissionLease | null {
  const current = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (current && !current.released) {
    return {
      ownsRoot: false,
      release: () => {},
      run: async <T>(run: () => Promise<T>) => await run(),
    };
  }
  // Existing request chains use the ALS path above; new roots stop for either
  // restart drain or host suspension.
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting"
  ) {
    return null;
  }
  return createGatewayRootWorkAdmission();
}

/** Independent detached work counts separately even when launched by an admitted parent. */
function tryBeginGatewayIndependentRootWorkAdmission(): GatewayRootWorkAdmissionLease | null {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting"
  ) {
    return null;
  }
  return createGatewayRootWorkAdmission();
}

/** Waits through a prepared lease, then joins the root-work set atomically. */
export async function beginGatewayRootWorkAdmissionWhenOpen(): Promise<GatewayRootWorkAdmissionLease> {
  while (true) {
    if (GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
      throw new GatewayDrainingError();
    }
    const admission = tryBeginGatewayRootWorkAdmission();
    if (admission) {
      return admission;
    }
    await new Promise<void>((resolve) => {
      GATEWAY_WORK_ADMISSION_STATE.suspendOpenWaiters.add(resolve);
    });
  }
}

export async function runWithGatewayIndependentRootWorkAdmission<T>(
  run: () => Promise<T>,
): Promise<T> {
  while (true) {
    if (GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
      throw new GatewayDrainingError("gateway is draining for restart");
    }
    const admission = tryBeginGatewayIndependentRootWorkAdmission();
    if (admission) {
      try {
        return await admission.run(run);
      } finally {
        admission.release();
      }
    }
    await new Promise<void>((resolve) => {
      GATEWAY_WORK_ADMISSION_STATE.suspendOpenWaiters.add(resolve);
    });
  }
}

/**
 * Detaches required follow-up from the current admitted transaction.
 * A live parent synchronously reserves a tracked root even after restart or
 * suspension closes admission; callers without a live parent use the normal
 * independent-root fence.
 */
export function runWithGatewayIndependentRootWorkContinuation<T>(
  run: () => Promise<T>,
): Promise<T> {
  const parent = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (!parent || parent.released) {
    return runWithGatewayIndependentRootWorkAdmission(run);
  }
  const admission = createGatewayRootWorkAdmission();
  return admission.run(run).finally(admission.release);
}

/** Transfers an admitted request root to work that intentionally outlives its handler. */
export function retainGatewayRootWorkAdmissionContinuation(): (() => void) | null {
  const current = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (!current || current.released) {
    return null;
  }
  current.references += 1;
  return createGatewayRootWorkRelease(current);
}

/** Starts process-lifetime work without inheriting the request root that created it. */
export function runOutsideGatewayRootWorkAdmission<T>(run: () => T): T {
  return GATEWAY_WORK_ADMISSION_STATE.currentRootWork.exit(run);
}

/** Active root requests/ticks, optionally excluding the caller running prepare. */
export function getActiveGatewayRootWorkCount(opts?: { excludeCurrent?: boolean }): number {
  let count = GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size;
  const current = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (
    opts?.excludeCurrent === true &&
    current &&
    !current.released &&
    GATEWAY_WORK_ADMISSION_STATE.activeRootWork.has(current)
  ) {
    count -= 1;
  }
  return Math.max(0, count);
}

/** Waits for admitted root transactions after restart has closed new admission. */
export async function waitForActiveGatewayRootWork(
  timeoutMs?: number,
): Promise<{ drained: boolean; active: number }> {
  if (GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size === 0) {
    return { drained: true, active: 0 };
  }
  const timeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(0, Math.floor(timeoutMs))
      : undefined;
  if (timeout === 0) {
    return { drained: false, active: GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDrain = () => {};
  await new Promise<void>((resolve) => {
    resolveDrain = () => resolve();
    const waiters =
      GATEWAY_WORK_ADMISSION_STATE.rootDrainWaiters ??
      (GATEWAY_WORK_ADMISSION_STATE.rootDrainWaiters = new Set());
    waiters.add(resolveDrain);
    if (timeout !== undefined) {
      timer = setTimeout(resolve, timeout);
    }
  });
  if (timer) {
    clearTimeout(timer);
  }
  GATEWAY_WORK_ADMISSION_STATE.rootDrainWaiters?.delete(resolveDrain);
  const active = GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size;
  return { drained: active === 0, active };
}

/** Atomically closes new suspension admission before synchronous inspection. */
export function tryBeginGatewaySuspendAdmission(
  onInvalidated: () => void,
): GatewaySuspendAdmissionLease | null {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting"
  ) {
    return null;
  }
  GATEWAY_WORK_ADMISSION_STATE.suspendPhase = "preparing";
  const generation = ++GATEWAY_WORK_ADMISSION_STATE.suspendGeneration;
  GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated = onInvalidated;
  logAdmissionClosed("suspend phase");

  const transition = (
    expected: GatewaySuspendAdmissionPhase,
    next: GatewaySuspendAdmissionPhase,
  ): boolean => {
    if (
      GATEWAY_WORK_ADMISSION_STATE.suspendGeneration !== generation ||
      GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== expected
    ) {
      return false;
    }
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase = next;
    if (next === "accepting") {
      GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated = undefined;
      resolveSuspendOpenWaiters();
      logAdmissionReopened("suspend phase");
    }
    return true;
  };

  return {
    commit: () => transition("preparing", "prepared"),
    rollback: () => transition("preparing", "accepting"),
    release: () => transition("prepared", "accepting"),
  };
}

/** Clears restart/suspend admission during SIGUSR1 and isolated tests. */
export function resetGatewayWorkAdmission(): void {
  // SIGUSR1 can abandon old async chains before their finally blocks run.
  // Retire their ALS records so surviving chains must re-enter admission.
  for (const admission of GATEWAY_WORK_ADMISSION_STATE.activeRootWork) {
    admission.references = 0;
    admission.released = true;
  }
  GATEWAY_WORK_ADMISSION_STATE.activeRootWork.clear();
  resolveRootDrainWaiters();
  GATEWAY_WORK_ADMISSION_STATE.restartDraining = false;
  GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = false;
  GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration += 1;
  if (GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting") {
    invalidateSuspendAdmission();
  } else {
    GATEWAY_WORK_ADMISSION_STATE.suspendGeneration += 1;
    GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated = undefined;
  }
  resolveSuspendOpenWaiters();
}
