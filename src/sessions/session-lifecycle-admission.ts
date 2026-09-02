// Serializes lifecycle mutations and work admission for logical session identities.
import { AsyncLocalStorage } from "node:async_hooks";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { decodeSessionIdentity, normalizeSessionIdentities } from "./session-lifecycle-identity.js";
import {
  clearSessionWorkAdmissionHandoffs,
  createSessionWorkAdmissionHandoff,
  type HandoffSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "./session-work-admission-handoff.js";

export {
  cancelSessionWorkAdmissionHandoff,
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "./session-work-admission-handoff.js";

export const SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS = 15_000;
type SessionWorkAdmission = HandoffSessionWorkAdmission & {
  phase: "pending" | "acquired";
  owner?: symbol;
  interrupt?: (reason?: Error) => void;
  released: Promise<void>;
};

type SessionLifecycleMutationOwner = {
  identities: readonly string[];
};

type SessionWorkAdmissionClosure = SessionLifecycleMutationOwner & { reason: Error };

type SessionLifecycleAdmissionState = {
  lifecycleQueues: Map<string, StoreWriterQueue>;
  mutationQueues: Map<string, StoreWriterQueue>;
  activeAdmissions: Map<string, Set<SessionWorkAdmission>>;
  activeMutations: Map<string, number>;
  activeMutationRuns?: Set<SessionLifecycleMutationOwner>;
  admissionClosures: Set<SessionWorkAdmissionClosure>;
  activeMutationKinds: Map<string, Map<SessionLifecycleMutationKind, number>>;
  idleWaiters: Map<string, Set<() => void>>;
  currentAdmissions: AsyncLocalStorage<ReadonlySet<SessionWorkAdmission>>;
};

type SessionLifecycleMutationKind = "compaction";

type SessionLifecycleMutationTarget = {
  scope: string;
  identities: Iterable<string | undefined>;
};

type SessionLifecycleMutationParams<T> = {
  kind?: SessionLifecycleMutationKind;
  prepare?: (owner: { closeWorkAdmissions: (reason: Error) => void }) => Promise<void>;
  finalize?: () => Promise<void>;
  run: () => Promise<T>;
  signal?: AbortSignal;
} & (SessionLifecycleMutationTarget | { targets: Iterable<SessionLifecycleMutationTarget> });

// Runtime chunks can load separate module instances while still coordinating
// the same sessions. One shared state keeps every lock and admission visible.
const SESSION_LIFECYCLE_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionLifecycleAdmissionState"),
  (): SessionLifecycleAdmissionState => ({
    lifecycleQueues: new Map(),
    mutationQueues: new Map(),
    activeAdmissions: new Map(),
    activeMutations: new Map(),
    activeMutationRuns: new Set(),
    admissionClosures: new Set(),
    activeMutationKinds: new Map(),
    idleWaiters: new Map(),
    currentAdmissions: new AsyncLocalStorage(),
  }),
);
const {
  lifecycleQueues: SESSION_LIFECYCLE_QUEUES,
  mutationQueues: SESSION_LIFECYCLE_MUTATION_QUEUES,
  activeAdmissions: ACTIVE_SESSION_WORK_ADMISSIONS,
  activeMutations: ACTIVE_SESSION_LIFECYCLE_MUTATIONS,
  activeMutationKinds: ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS,
  idleWaiters: SESSION_LIFECYCLE_IDLE_WAITERS,
  currentAdmissions: CURRENT_SESSION_WORK_ADMISSIONS,
  admissionClosures: SESSION_WORK_ADMISSION_CLOSURES,
} = SESSION_LIFECYCLE_ADMISSION_STATE;
// Older runtime chunks can create the shared state without this newer index.
const ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS =
  (SESSION_LIFECYCLE_ADMISSION_STATE.activeMutationRuns ??= new Set());

async function runWithSessionIdentityLocks<T>(
  identities: readonly string[],
  index: number,
  run: () => Promise<T>,
  kind: "lifecycle" | "mutation" = "lifecycle",
): Promise<T> {
  const identity = identities[index];
  if (!identity) {
    return await run();
  }
  return await runQueuedStoreWrite({
    queues: kind === "mutation" ? SESSION_LIFECYCLE_MUTATION_QUEUES : SESSION_LIFECYCLE_QUEUES,
    storePath: identity,
    label:
      kind === "mutation" ? "runExclusiveSessionLifecycleMutation" : "runExclusiveSessionLifecycle",
    reentrant: true,
    fn: async () => await runWithSessionIdentityLocks(identities, index + 1, run, kind),
  });
}

function hasActiveSessionLifecycleMutation(identities: readonly string[]): boolean {
  return identities.some((identity) => (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0) > 0);
}

function hasOnlyActiveSessionLifecycleMutationKind(
  identities: readonly string[],
  kind: SessionLifecycleMutationKind,
): boolean {
  let foundActiveMutation = false;
  for (const identity of identities) {
    const activeCount = ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0;
    if (activeCount === 0) {
      continue;
    }
    foundActiveMutation = true;
    if ((ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.get(identity)?.get(kind) ?? 0) !== activeCount) {
      return false;
    }
  }
  return foundActiveMutation;
}

async function waitForNormalizedSessionLifecycleMutationIdle(
  identities: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const activeIdentities = identities.filter(
    (identity) => (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0) > 0,
  );
  if (activeIdentities.length === 0) {
    return;
  }
  signal?.throwIfAborted();
  const idle = Promise.all(
    activeIdentities.map(
      (identity) =>
        new Promise<void>((resolve) => {
          const waiters = SESSION_LIFECYCLE_IDLE_WAITERS.get(identity) ?? new Set();
          waiters.add(resolve);
          SESSION_LIFECYCLE_IDLE_WAITERS.set(identity, waiters);
        }),
    ),
  );
  if (!signal) {
    await idle;
    return;
  }
  let rejectAborted = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("session work admission aborted"),
      );
    signal.addEventListener("abort", rejectAborted, { once: true });
  });
  try {
    await Promise.race([idle, aborted]);
  } finally {
    signal.removeEventListener("abort", rejectAborted);
  }
}

async function runExclusiveSessionLifecycle<T>(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  while (true) {
    params.signal?.throwIfAborted();
    if (hasActiveSessionLifecycleMutation(identities)) {
      await waitForNormalizedSessionLifecycleMutationIdle(identities, params.signal);
      continue;
    }
    const attempt = await runWithSessionIdentityLocks(identities, 0, async () => {
      params.signal?.throwIfAborted();
      if (hasActiveSessionLifecycleMutation(identities)) {
        return { blocked: true as const };
      }
      return { blocked: false as const, value: await params.run() };
    });
    if (!attempt.blocked) {
      return attempt.value;
    }
    await waitForNormalizedSessionLifecycleMutationIdle(identities, params.signal);
  }
}

export async function runExclusiveSessionLifecycleMutation<T>(
  params: SessionLifecycleMutationParams<T>,
): Promise<T> {
  // Normalize every store and session into one globally ordered identity set.
  // Cross-agent mutations then acquire one fence and count as one active run,
  // instead of nesting store locks in caller-selected order.
  const identities =
    "targets" in params
      ? Array.from(
          new Set(
            Array.from(params.targets, (target) =>
              normalizeSessionIdentities(target.scope, target.identities),
            ).flat(),
          ),
        ).toSorted()
      : normalizeSessionIdentities(params.scope, params.identities);
  const signal = params.signal;
  signal?.throwIfAborted();
  const callerAdmissions = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
  const mutationRun: SessionLifecycleMutationOwner = { identities };
  let mutationActivated = false;
  let removeAbortListener = () => {};
  let releaseWorkAdmissions: (() => void) | undefined;
  const mutation = runWithSessionIdentityLocks(
    identities,
    0,
    async () =>
      await CURRENT_SESSION_WORK_ADMISSIONS.run(callerAdmissions, async () => {
        await runWithSessionIdentityLocks(identities, 0, async () => {
          signal?.throwIfAborted();
          mutationActivated = true;
          removeAbortListener();
          ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.add(mutationRun);
          for (const identity of identities) {
            ACTIVE_SESSION_LIFECYCLE_MUTATIONS.set(
              identity,
              (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0) + 1,
            );
            if (params.kind) {
              const kinds = ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.get(identity) ?? new Map();
              kinds.set(params.kind, (kinds.get(params.kind) ?? 0) + 1);
              ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.set(identity, kinds);
            }
          }
        });
        // Cancellation may abandon a queued contender, but never an active
        // mutation whose caller must observe cleanup and completion.
        try {
          await params.prepare?.({
            // The same mutation owner fences ingress through every awaited cleanup step.
            // Removing this owner below reopens admission for an explicit later request.
            closeWorkAdmissions: (reason) => {
              releaseWorkAdmissions?.();
              releaseWorkAdmissions = closeNormalizedSessionWorkAdmissions(identities, reason);
            },
          });
          return await runWithSessionIdentityLocks(identities, 0, params.run);
        } finally {
          // Resource finalization is part of the mutation: successors remain
          // fenced until rollback or exact-generation cleanup has completed.
          try {
            await params.finalize?.();
          } finally {
            await runWithSessionIdentityLocks(identities, 0, async () => {
              for (const identity of identities) {
                if (params.kind) {
                  const kinds = ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.get(identity);
                  const remainingKindCount = (kinds?.get(params.kind) ?? 1) - 1;
                  if (remainingKindCount > 0) {
                    kinds?.set(params.kind, remainingKindCount);
                  } else {
                    kinds?.delete(params.kind);
                    if (kinds?.size === 0) {
                      ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.delete(identity);
                    }
                  }
                }
                const remaining = (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 1) - 1;
                if (remaining > 0) {
                  ACTIVE_SESSION_LIFECYCLE_MUTATIONS.set(identity, remaining);
                  continue;
                }
                ACTIVE_SESSION_LIFECYCLE_MUTATIONS.delete(identity);
                const waiters = SESSION_LIFECYCLE_IDLE_WAITERS.get(identity);
                SESSION_LIFECYCLE_IDLE_WAITERS.delete(identity);
                for (const resolve of waiters ?? []) {
                  resolve();
                }
              }
              ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.delete(mutationRun);
              releaseWorkAdmissions?.();
            });
          }
        }
      }),
    "mutation",
  );
  if (!signal) {
    return await mutation;
  }
  if (mutationActivated) {
    return await mutation;
  }
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      if (mutationActivated) {
        return;
      }
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([mutation, aborted]);
  } finally {
    removeAbortListener();
  }
}

export function isSessionLifecycleMutationActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  return hasActiveSessionLifecycleMutation(normalizeSessionIdentities(scope, identities));
}

export function hasOnlySessionLifecycleMutationKindActive(
  scope: string,
  identities: Iterable<string | undefined>,
  kind: SessionLifecycleMutationKind,
): boolean {
  return hasOnlyActiveSessionLifecycleMutationKind(
    normalizeSessionIdentities(scope, identities),
    kind,
  );
}

export function isSessionWorkAdmissionActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  return normalizeSessionIdentities(scope, identities).some((identity) =>
    [...(ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? [])].some(
      (admission) => admission.phase === "acquired",
    ),
  );
}

export function isSessionWorkAdmissionTargetActive(params: {
  scope: string;
  sessionKey: string;
  sessionId: string;
}): boolean {
  const identities = normalizeSessionIdentities(params.scope, [
    params.sessionKey,
    params.sessionId,
  ]);
  // Singleton leases intentionally own one identity. Multi-identity leases must
  // cover the pair together; pooling owners would manufacture a false pair.
  return identities.some((identity) =>
    Array.from(ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? []).some(
      (admission) =>
        admission.phase === "acquired" &&
        (admission.identities.size === 1 ||
          identities.every((target) => admission.identities.has(target))),
    ),
  );
}

/** Whether another admitted turn currently owns any of these session identities. */
export function isCompetingSessionWorkAdmissionActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  const currentAdmissions = CURRENT_SESSION_WORK_ADMISSIONS.getStore();
  return normalizeSessionIdentities(scope, identities).some((identity) =>
    Array.from(
      ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? [],
      (admission) => admission.phase === "acquired" && !currentAdmissions?.has(admission),
    ).some(Boolean),
  );
}

type SessionWorkAdmissionReleaseParams = {
  scope: string;
  identities: Iterable<string | undefined>;
};

/** Completion of the currently active turns that own a session. */
export function getSessionWorkAdmissionRelease(
  params: SessionWorkAdmissionReleaseParams,
): Promise<void> | undefined {
  const matchingAdmissions = new Set<SessionWorkAdmission>();
  for (const identity of normalizeSessionIdentities(params.scope, params.identities)) {
    for (const admission of ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? []) {
      if (admission.phase === "acquired") {
        matchingAdmissions.add(admission);
      }
    }
  }
  if (matchingAdmissions.size === 0) {
    return undefined;
  }

  // A gateway turn can adopt an outer reply admission and open its own inner
  // admission. Self-archive must wait for both owners to release the session.
  return Promise.all(Array.from(matchingAdmissions, (admission) => admission.released)).then(
    () => undefined,
  );
}

/** Completion of a named owner that is starting or actively working on a session. */
export function getSessionWorkAdmissionOwnerRelease(
  params: SessionWorkAdmissionReleaseParams & { owner: symbol },
): Promise<void> | undefined {
  const matching = new Set<SessionWorkAdmission>();
  for (const identity of normalizeSessionIdentities(params.scope, params.identities)) {
    for (const admission of ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? []) {
      if (admission.owner === params.owner) {
        matching.add(admission);
      }
    }
  }
  return matching.size > 0
    ? Promise.all(Array.from(matching, (admission) => admission.released)).then(() => undefined)
    : undefined;
}

/** Active session identities grouped by their authoritative store/lifecycle scope. */
export function collectActiveSessionWorkAdmissions(): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const [normalizedIdentity, admissions] of ACTIVE_SESSION_WORK_ADMISSIONS) {
    if (![...admissions].some((admission) => admission.phase === "acquired")) {
      continue;
    }
    const decoded = decodeSessionIdentity(normalizedIdentity);
    if (!decoded) {
      continue;
    }
    const identities = targets.get(decoded.scope) ?? new Set<string>();
    identities.add(decoded.identity);
    targets.set(decoded.scope, identities);
  }
  return targets;
}

/** Unique admitted turns; one lease can be indexed under several identities. */
export function getActiveSessionWorkAdmissionCount(): number {
  const admissions = new Set<SessionWorkAdmission>();
  for (const active of ACTIVE_SESSION_WORK_ADMISSIONS.values()) {
    for (const admission of active) {
      if (admission.phase === "acquired") {
        admissions.add(admission);
      }
    }
  }
  return admissions.size;
}

/** Unique active lifecycle mutations; one run can be indexed under several identities. */
export function getActiveSessionLifecycleMutationCount(): number {
  if (ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.size > 0) {
    return ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.size;
  }
  // A mutation from an older loaded chunk may only populate the identity index.
  return ACTIVE_SESSION_LIFECYCLE_MUTATIONS.size > 0 ? 1 : 0;
}

export async function beginSessionWorkAdmission(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  /** Stable process-wide identity for owners that must be observable while still pending. */
  owner?: symbol;
  assertAllowed: () => Promise<void> | void;
  /** Final writer-ordered validation; use when one-time effects must not run during the first check. */
  revalidateAllowed?: () => Promise<void> | void;
  onInterrupt?: (reason?: Error) => void;
  signal?: AbortSignal;
}): Promise<SessionWorkAdmissionLease> {
  if (isGatewaySubordinateWorkAdmissionClosed()) {
    throw new GatewayDrainingError();
  }
  const rawIdentities = Array.from(params.identities);
  const identities = normalizeSessionIdentities(params.scope, rawIdentities);
  const pendingController = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, pendingController.signal])
    : pendingController.signal;
  let writerBarrierStarted = false;
  let resolveReleased = () => {};
  const admission: SessionWorkAdmission = {
    phase: "pending",
    ...(params.owner ? { owner: params.owner } : {}),
    handoffIds: new Set(),
    identities: new Set(identities),
    interrupted: undefined,
    interrupt: (reason) => {
      admission.interrupted ??= reason ?? new Error("Session work admission interrupted");
      try {
        params.onInterrupt?.(admission.interrupted);
      } finally {
        if (!writerBarrierStarted) {
          pendingController.abort(admission.interrupted);
        }
      }
    },
    released: new Promise<void>((resolve) => {
      resolveReleased = resolve;
    }),
  };
  // Reserve before waiting: Stop must own queued ingress as well as running work.
  for (const identity of identities) {
    const active = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? new Set();
    active.add(admission);
    ACTIVE_SESSION_WORK_ADMISSIONS.set(identity, active);
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    for (const identity of identities) {
      const active = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity);
      active?.delete(admission);
      if (!active?.size) {
        ACTIVE_SESSION_WORK_ADMISSIONS.delete(identity);
      }
    }
    clearSessionWorkAdmissionHandoffs(admission);
    resolveReleased();
  };
  const lease: SessionWorkAdmissionLease = {
    isActive: () => !released,
    createHandoff: () => {
      if (released) {
        throw new Error("cannot hand off a released session work admission");
      }
      return createSessionWorkAdmissionHandoff(admission, lease);
    },
    release,
    released: admission.released,
    run: async <T>(run: () => Promise<T>) => {
      const current = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
      current.add(admission);
      return await CURRENT_SESSION_WORK_ADMISSIONS.run(current, run);
    },
  };
  let removeAbortListener = () => {};
  try {
    const closedOwner = [...SESSION_WORK_ADMISSION_CLOSURES].find((owner) =>
      owner.identities.some((identity) => admission.identities.has(identity)),
    );
    if (closedOwner) {
      admission.interrupt?.(closedOwner.reason);
    }
    const queuedAbort = new Promise<never>((_, reject) => {
      const onAbort = () => {
        if (!writerBarrierStarted) {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("session work admission aborted"),
          );
        }
      };
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
    const acquired = runExclusiveSessionLifecycle({
      scope: params.scope,
      identities: rawIdentities,
      signal,
      run: async () => {
        const current = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
        current.add(admission);
        await CURRENT_SESSION_WORK_ADMISSIONS.run(current, params.assertAllowed);
        if (isGatewaySubordinateWorkAdmissionClosed()) {
          throw new GatewayDrainingError();
        }
        signal.throwIfAborted();
        admission.phase = "acquired";
        await runExclusiveSessionStoreWrite(
          params.scope,
          async () => {
            writerBarrierStarted = true;
            signal.throwIfAborted();
            await lease.run(async () => await (params.revalidateAllowed ?? params.assertAllowed)());
          },
          { reentrant: true },
        );
        return lease;
      },
    });
    // Queued acquisition may sit behind the mutation's locks. Abort releases only
    // that reservation; a started writer remains owned until its real completion.
    return await Promise.race([acquired, queuedAbort]);
  } catch (error) {
    release();
    throw error;
  } finally {
    removeAbortListener();
  }
}

function closeNormalizedSessionWorkAdmissions(identities: readonly string[], reason: Error) {
  const owner = { identities, reason };
  SESSION_WORK_ADMISSION_CLOSURES.add(owner);
  // Retire queued ingress immediately; acquired runs keep their canonical cancellation owner.
  try {
    startNormalizedSessionWorkAdmissionInterruption({ identities, reason, pendingOnly: true });
  } catch (error) {
    SESSION_WORK_ADMISSION_CLOSURES.delete(owner);
    throw error;
  }
  return () => {
    SESSION_WORK_ADMISSION_CLOSURES.delete(owner);
  };
}

/** Fence ingress while awaiting cleanup that must run outside lifecycle/placement locks. */
export function closeSessionWorkAdmissions(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  reason: Error;
}): () => void {
  return closeNormalizedSessionWorkAdmissions(
    normalizeSessionIdentities(params.scope, params.identities),
    params.reason,
  );
}

function startNormalizedSessionWorkAdmissionInterruption(params: {
  reason?: Error;
  identities: readonly string[];
  pendingOnly?: boolean;
}): { released: Promise<void> } {
  const admissions = new Set<SessionWorkAdmission>();
  const currentAdmissions = CURRENT_SESSION_WORK_ADMISSIONS.getStore();
  for (const identity of params.identities) {
    for (const admission of ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? []) {
      if (params.pendingOnly && admission.phase !== "pending") {
        continue;
      }
      // In-band lifecycle commands suspend their own admitted turn while the
      // mutation runs. Interrupt competing work, not the initiating stack.
      if (currentAdmissions?.has(admission)) {
        continue;
      }
      admissions.add(admission);
    }
  }
  for (const admission of admissions) {
    admission.interrupted ??= params.reason ?? new Error("Session work admission interrupted");
    admission.interrupt?.(admission.interrupted);
  }
  return {
    released: Promise.all(Array.from(admissions, (admission) => admission.released)).then(
      () => undefined,
    ),
  };
}

export function startSessionWorkAdmissionInterruption(params: {
  reason?: Error;
  scope: string;
  identities: Iterable<string | undefined>;
}): { released: Promise<void> } {
  return startNormalizedSessionWorkAdmissionInterruption({
    identities: normalizeSessionIdentities(params.scope, params.identities),
    reason: params.reason,
  });
}

export async function interruptSessionWorkAdmissions(params: {
  reason?: Error;
  scope: string;
  identities: Iterable<string | undefined>;
  timeoutMs?: number;
}): Promise<boolean> {
  const { released } = startSessionWorkAdmissionInterruption(params);
  if (params.timeoutMs === undefined) {
    await released;
    return true;
  }
  const timeoutMs = params.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      released.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionLifecycleAdmissionTestApi")
  ] = { runExclusiveSessionLifecycle };
}
