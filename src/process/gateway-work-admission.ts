// Coordinates process-wide root work admission with reversible host suspension.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type GatewaySuspendAdmissionPhase = "accepting" | "preparing" | "prepared";

export class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is draining; new tasks are not accepted");
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
  currentRootWork: AsyncLocalStorage<GatewayRootWorkAdmission>;
  suspendOpenWaiters: Set<() => void>;
};

const GATEWAY_WORK_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
  (): GatewayWorkAdmissionState => ({
    restartDraining: false,
    restartSignalPending: false,
    restartSignalGeneration: 0,
    suspendPhase: "accepting",
    suspendGeneration: 0,
    activeRootWork: new Set(),
    currentRootWork: new AsyncLocalStorage(),
    suspendOpenWaiters: new Set(),
  }),
);

export type GatewayRootWorkAdmissionLease = {
  ownsRoot: boolean;
  release: () => void;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

export type GatewaySuspendAdmissionLease = {
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
  };
}

function invalidateSuspendAdmission(): void {
  const callback = GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated;
  GATEWAY_WORK_ADMISSION_STATE.suspendInvalidated = undefined;
  GATEWAY_WORK_ADMISSION_STATE.suspendPhase = "accepting";
  GATEWAY_WORK_ADMISSION_STATE.suspendGeneration += 1;
  resolveSuspendOpenWaiters();
  callback?.();
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
  GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = false;
  GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration += 1;
  GATEWAY_WORK_ADMISSION_STATE.restartDraining = true;
  resolveSuspendOpenWaiters();
  if (GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting") {
    // A restart supersedes a reversible suspension. The coordinator callback
    // drops its timer/token without reopening the scheduler being shut down.
    invalidateSuspendAdmission();
  }
}

/** Blocks suspension across signal emission until the run loop starts restart drain. */
export function beginGatewayRestartSignalAdmission(): GatewayRestartSignalAdmissionLease {
  if (GATEWAY_WORK_ADMISSION_STATE.restartSignalPending) {
    return { rollback: () => false };
  }
  GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = true;
  const generation = ++GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration;
  return {
    rollback: () => {
      if (
        !GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
        GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration !== generation
      ) {
        return false;
      }
      GATEWAY_WORK_ADMISSION_STATE.restartSignalPending = false;
      GATEWAY_WORK_ADMISSION_STATE.restartSignalGeneration += 1;
      resolveSuspendOpenWaiters();
      return true;
    },
  };
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
export function tryBeginGatewayIndependentRootWorkAdmission(): GatewayRootWorkAdmissionLease | null {
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

export async function runWithGatewayRootWorkAdmission<T>(run: () => Promise<T>): Promise<T> {
  const admission = await beginGatewayRootWorkAdmissionWhenOpen();
  try {
    return await admission.run(run);
  } finally {
    admission.release();
  }
}

export async function runWithGatewayIndependentRootWorkAdmission<T>(
  run: () => Promise<T>,
): Promise<T> {
  while (true) {
    if (GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
      throw new Error("gateway is draining for restart");
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
