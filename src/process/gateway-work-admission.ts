// Coordinates process-wide root work admission with reversible host suspension.
import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type GatewaySuspendAdmissionPhase = "accepting" | "preparing" | "draining" | "prepared";

type AdmissionCloseReason = "restart-signal fence" | "restart drain" | "suspend phase";
type AdmissionReopenReason = "restart-signal fence" | "suspend phase";

export class GatewayDrainingError extends Error {
  constructor(message = "Gateway is draining; new tasks are not accepted") {
    super(message);
    this.name = "GatewayDrainingError";
  }
}

type GatewayRootWorkAdmission = {
  origin: string;
  references: number;
  released: boolean;
  retiredByReset?: true;
};

type GatewayWorkAdmissionState = {
  restartDraining: boolean;
  restartDrainController: AbortController;
  restartSignalPending: boolean;
  restartSignalGeneration: number;
  suspendPhase: GatewaySuspendAdmissionPhase;
  suspendGeneration: number;
  suspendInvalidated?: () => void;
  activeRootWork: Set<GatewayRootWorkAdmission>;
  currentRootWork: AsyncLocalStorage<GatewayRootWorkAdmission>;
  suspendOpenWaiters: Set<() => void>;
};

const admissionLog = createSubsystemLogger("gateway/admission");

const GATEWAY_WORK_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
  (): GatewayWorkAdmissionState => ({
    restartDraining: false,
    restartDrainController: new AbortController(),
    restartSignalPending: false,
    restartSignalGeneration: 0,
    suspendPhase: "accepting",
    suspendGeneration: 0,
    activeRootWork: new Set(),
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

export type GatewayRootWorkAdmissionContinuationScope = {
  release: () => void;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

type GatewaySuspendAdmissionLease = {
  drain: () => boolean;
  commit: () => boolean;
  rollback: () => boolean;
  release: () => boolean;
};

export type GatewayRestartSignalAdmissionLease = {
  rollback: () => boolean;
};

const GATEWAY_ROOT_WORK_ORIGIN_MAX_CHARS = 80;

function createGatewayRootWorkAdmission(origin: string): GatewayRootWorkAdmissionLease {
  const normalizedOrigin = origin
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, GATEWAY_ROOT_WORK_ORIGIN_MAX_CHARS);
  const admission: GatewayRootWorkAdmission = {
    origin: normalizedOrigin || "gateway",
    references: 1,
    released: false,
  };
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
  if (GATEWAY_WORK_ADMISSION_STATE.suspendPhase === "accepting") {
    logAdmissionReopened("restart-signal fence");
  } else {
    admissionLog.info("restart-signal fence cleared; suspension remains closed");
  }
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

/** Resolves when one-way drain commits or the reversible signal fence clears. */
export async function waitForGatewayRestartFenceSettlement(): Promise<void> {
  if (!GATEWAY_WORK_ADMISSION_STATE.restartSignalPending) {
    return;
  }
  await new Promise<void>((resolve) => {
    GATEWAY_WORK_ADMISSION_STATE.suspendOpenWaiters.add(resolve);
  });
  await waitForGatewayRestartFenceSettlement();
}

export function getGatewayRestartDrainSignal(): AbortSignal {
  return GATEWAY_WORK_ADMISSION_STATE.restartDrainController.signal;
}

export function isGatewayRestartDrainError(error: unknown): error is GatewayDrainingError {
  return error instanceof GatewayDrainingError && isGatewayRestartDraining();
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
  GATEWAY_WORK_ADMISSION_STATE.restartDrainController.abort(
    new GatewayDrainingError("gateway is draining for restart"),
  );
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
export function tryBeginGatewayRootWorkAdmission(
  origin = "gateway",
): GatewayRootWorkAdmissionLease | null {
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
  return createGatewayRootWorkAdmission(origin);
}

/**
 * Tracks a host-selected restart-startup recovery handshake without reopening admission.
 * The caller still owns frame/auth validation; this lease grants no method authority.
 */
export function tryBeginGatewayRestartStartupRootWorkAdmission(): GatewayRootWorkAdmissionLease | null {
  if (
    (!GATEWAY_WORK_ADMISSION_STATE.restartDraining &&
      !GATEWAY_WORK_ADMISSION_STATE.restartSignalPending) ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting"
  ) {
    return null;
  }
  return createGatewayRootWorkAdmission("restart-startup");
}

/**
 * Admits only the exact predecessor-bound restart selected by the RPC router.
 * The held root preserves signal-to-drain ordering without reopening suspension.
 */
export function tryBeginGatewayPreparedRestartRootWorkAdmission(): GatewayRootWorkAdmissionLease | null {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "prepared" ||
    GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size > 0
  ) {
    return null;
  }
  return createGatewayRootWorkAdmission("restart-prepared");
}

/** Independent detached work counts separately even when launched by an admitted parent. */
function tryBeginGatewayIndependentRootWorkAdmission(
  origin = "independent",
): GatewayRootWorkAdmissionLease | null {
  if (
    GATEWAY_WORK_ADMISSION_STATE.restartDraining ||
    GATEWAY_WORK_ADMISSION_STATE.restartSignalPending ||
    GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting"
  ) {
    return null;
  }
  return createGatewayRootWorkAdmission(origin);
}

/** Waits through a prepared lease, then joins the root-work set atomically. */
export async function beginGatewayRootWorkAdmissionWhenOpen(
  origin = "gateway",
): Promise<GatewayRootWorkAdmissionLease> {
  while (true) {
    if (GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
      throw new GatewayDrainingError();
    }
    const admission = tryBeginGatewayRootWorkAdmission(origin);
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
  origin?: string,
): Promise<T> {
  while (true) {
    if (GATEWAY_WORK_ADMISSION_STATE.restartDraining) {
      throw new GatewayDrainingError("gateway is draining for restart");
    }
    const admission = tryBeginGatewayIndependentRootWorkAdmission(origin);
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

/** Re-admits preserved work whose inherited root was retired before it could run. */
export const runWithGatewayRootWorkReadmission = <T>(run: () => Promise<T>): Promise<T> =>
  GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore()?.retiredByReset
    ? runWithGatewayIndependentRootWorkAdmission(run, "runtime:readmission")
    : run();

/**
 * Detaches required follow-up from the current admitted transaction.
 * A live parent synchronously reserves a tracked root even after restart or
 * suspension closes admission. The detached root keeps its caller origin
 * because it can outlive the parent; otherwise the normal fence applies.
 */
export function runWithGatewayIndependentRootWorkContinuation<T>(
  run: () => Promise<T>,
  origin = "independent",
): Promise<T> {
  const parent = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (!parent || parent.released) {
    return runWithGatewayIndependentRootWorkAdmission(run, origin);
  }
  const admission = createGatewayRootWorkAdmission(origin);
  return admission.run(run).finally(admission.release);
}

function createGatewayRootWorkAdmissionContinuationScope(
  retainRoot: boolean,
): GatewayRootWorkAdmissionContinuationScope | null {
  const current = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  if (!current || current.released || !GATEWAY_WORK_ADMISSION_STATE.activeRootWork.has(current)) {
    return null;
  }
  if (retainRoot) {
    current.references += 1;
  }
  const releaseAdmission = retainRoot ? createGatewayRootWorkRelease(current) : undefined;
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      releaseAdmission?.();
    },
    run: async <T>(run: () => Promise<T>) => {
      if (
        released ||
        current.released ||
        !GATEWAY_WORK_ADMISSION_STATE.activeRootWork.has(current)
      ) {
        throw new GatewayDrainingError("gateway root work continuation is no longer active");
      }
      // Completion owners can settle and release their retained handle inside
      // this callback; keep the root live until that entire callback finishes.
      current.references += 1;
      const releaseRun = createGatewayRootWorkRelease(current);
      try {
        return await GATEWAY_WORK_ADMISSION_STATE.currentRootWork.run(current, run);
      } finally {
        releaseRun();
      }
    },
  };
}

/** Borrows exact root ownership without extending the creating request's lifetime. */
export function captureGatewayRootWorkAdmissionContinuationScope(): GatewayRootWorkAdmissionContinuationScope | null {
  return createGatewayRootWorkAdmissionContinuationScope(false);
}

/** Retains exact root ownership for work that intentionally outlives its handler. */
export function retainGatewayRootWorkAdmissionContinuationScope(): GatewayRootWorkAdmissionContinuationScope | null {
  return createGatewayRootWorkAdmissionContinuationScope(true);
}

/** Transfers an admitted request root to work that intentionally outlives its handler. */
export function retainGatewayRootWorkAdmissionContinuation(): (() => void) | null {
  return retainGatewayRootWorkAdmissionContinuationScope()?.release ?? null;
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

/** Bounded, deterministic root-owner inventory for shutdown diagnostics. */
export function getActiveGatewayRootWorkHolders(opts?: { excludeCurrent?: boolean }): string[] {
  const current = GATEWAY_WORK_ADMISSION_STATE.currentRootWork.getStore();
  const counts = new Map<string, number>();
  for (const admission of GATEWAY_WORK_ADMISSION_STATE.activeRootWork) {
    if (opts?.excludeCurrent === true && admission === current) {
      continue;
    }
    counts.set(admission.origin, (counts.get(admission.origin) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([origin, count]) => (count > 1 ? `${origin} (${count})` : origin));
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
    drain: () => transition("preparing", "draining"),
    commit: () => transition("preparing", "prepared") || transition("draining", "prepared"),
    rollback: () => transition("preparing", "accepting"),
    release: () => transition("draining", "accepting") || transition("prepared", "accepting"),
  };
}

/** Clears restart/suspend admission during SIGUSR1 and isolated tests. */
export function resetGatewayWorkAdmission(): void {
  // SIGUSR1 can abandon old async chains before their finally blocks run.
  // Retire their ALS records so surviving chains must re-enter admission.
  for (const admission of GATEWAY_WORK_ADMISSION_STATE.activeRootWork) {
    admission.references = 0;
    admission.retiredByReset = true;
    admission.released = true;
  }
  GATEWAY_WORK_ADMISSION_STATE.activeRootWork.clear();
  GATEWAY_WORK_ADMISSION_STATE.restartDraining = false;
  GATEWAY_WORK_ADMISSION_STATE.restartDrainController = new AbortController();
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
