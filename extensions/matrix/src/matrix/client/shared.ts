// Matrix plugin module implements shared behavior.
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { toStringifiedError as toRetirementError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { LogService } from "../sdk/logger.js";
import { awaitMatrixStartupWithAbort, throwIfMatrixStartupAborted } from "../startup-abort.js";
import { resolveMatrixAuth, resolveMatrixAuthContext } from "./config.js";
import type { MatrixAuth } from "./types.js";

const loadMatrixCreateClientDeps = createLazyRuntimeModule(() =>
  import("./create-client.js").then((runtime) => ({
    createMatrixClient: runtime.createMatrixClient,
  })),
);
const MATRIX_TRANSIENT_LEASE_DRAIN_TIMEOUT_MS = 5_000;

export type MatrixClientLeaseRole = "monitor" | "transient";
export type MatrixClientReleaseMode = "stop" | "persist" | "discard";

export type MatrixMonitorRetirement = {
  closeTaskAdmission: () => void;
  detachListeners: () => void;
  waitForTasks: () => Promise<void>;
  cleanup: () => Promise<void> | void;
};

export type SharedMatrixClientLease = {
  abortSignal: AbortSignal;
  client: MatrixClient;
  role: MatrixClientLeaseRole;
  registerMonitorRetirement: (retirement: MatrixMonitorRetirement) => void;
  start: (abortSignal?: AbortSignal) => Promise<void>;
  release: (params?: { mode?: MatrixClientReleaseMode }) => Promise<void>;
};

type SharedMatrixClientPhase = "open" | "quiescing" | "closing";

type SharedMatrixClientLeaseState = {
  abortController: AbortController;
  monitorAdmitted: boolean;
  monitorRetirement: MatrixMonitorRetirement | null;
  monitorRetirementPromise: Promise<void> | null;
  role: MatrixClientLeaseRole;
  releasePromise: Promise<void> | null;
};

type SharedMatrixClientState = {
  auth: MatrixAuth;
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
  startPromise: Promise<void> | null;
  monitorAdmission: { promise: Promise<void>; resolve: () => void };
  monitorlessSyncClaim: Promise<void> | null;
  phase: SharedMatrixClientPhase;
  leases: Set<SharedMatrixClientLeaseState>;
  monitorRetirementPromises: Set<Promise<void>>;
  noLeases: { promise: Promise<void>; resolve: () => void };
  replacementReady: { promise: Promise<void>; resolve: () => void };
  retirementPromise: Promise<void> | null;
  poisonError: Error | null;
  releaseMode: MatrixClientReleaseMode;
};

type SharedMatrixClientParams = {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  auth?: MatrixAuth;
  startClient?: boolean;
  accountId?: string | null;
  abortSignal?: AbortSignal;
  role?: MatrixClientLeaseRole;
};

const sharedClientStates = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();
const retiringClientStates = new Set<SharedMatrixClientState>();
const sharedClientStopPromises = new Map<string, Promise<void>>();

function buildSharedClientKey(auth: MatrixAuth): string {
  // Serialize the tuple as a whole: Matrix URLs and credentials may contain `|`,
  // so delimiter-joined keys can alias distinct clients and couple crypto/leases.
  return JSON.stringify([
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    auth.allowPrivateNetwork ? "private-net" : "strict-net",
    auth.dispatcherPolicy ?? null,
    auth.accountId,
  ]);
}

function assertSharedClientAccountOpen(key: string): void {
  if (sharedClientStopPromises.has(key)) {
    throw new Error("Matrix shared client account is stopping");
  }
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
}): Promise<SharedMatrixClientState> {
  const { createMatrixClient } = await loadMatrixCreateClientDeps();
  const client = await createMatrixClient({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    password: params.auth.password,
    deviceId: params.auth.deviceId,
    encryption: params.auth.encryption,
    localTimeoutMs: params.timeoutMs,
    initialSyncLimit: params.auth.initialSyncLimit,
    accountId: params.auth.accountId,
    allowPrivateNetwork: params.auth.allowPrivateNetwork,
    ssrfPolicy: params.auth.ssrfPolicy,
    dispatcherPolicy: params.auth.dispatcherPolicy,
  });
  return {
    auth: params.auth,
    client,
    key: buildSharedClientKey(params.auth),
    started: false,
    cryptoReady: false,
    startPromise: null,
    monitorAdmission: createDeferred<void>(),
    monitorlessSyncClaim: null,
    phase: "open",
    leases: new Set(),
    monitorRetirementPromises: new Set(),
    noLeases: createDeferred<void>(),
    replacementReady: createDeferred<void>(),
    retirementPromise: null,
    poisonError: null,
    releaseMode: "discard",
  };
}

function detachSharedClientState(state: SharedMatrixClientState): void {
  if (sharedClientStates.get(state.key) === state) {
    sharedClientStates.delete(state.key);
  }
  retiringClientStates.add(state);
  state.replacementReady.resolve();
}

function deleteSharedClientState(state: SharedMatrixClientState): void {
  if (sharedClientStates.get(state.key) === state) {
    sharedClientStates.delete(state.key);
  }
  retiringClientStates.delete(state);
  state.replacementReady.resolve();
}

async function ensureSharedClientStarted(
  state: SharedMatrixClientState,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (state.started) {
    return;
  }
  if (state.startPromise) {
    await awaitMatrixStartupWithAbort(state.startPromise, abortSignal);
    return;
  }

  const startPromise = (async () => {
    if (state.auth.encryption && !state.cryptoReady) {
      try {
        const joinedRooms = await state.client.getJoinedRooms();
        if (state.client.crypto) {
          await state.client.crypto.prepare(joinedRooms);
          state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await awaitMatrixStartupWithAbort(state.client.start({ abortSignal }), abortSignal);
    state.started = true;
  })();
  const guardedStart = startPromise.finally(() => {
    if (state.startPromise === guardedStart) {
      state.startPromise = null;
    }
  });
  state.startPromise = guardedStart;
  await awaitMatrixStartupWithAbort(guardedStart, abortSignal);
}

async function resolveSharedMatrixAuth(params: SharedMatrixClientParams): Promise<MatrixAuth> {
  const requestedAccountId = normalizeOptionalAccountId(params.accountId);
  if (params.auth && requestedAccountId && requestedAccountId !== params.auth.accountId) {
    throw new Error(
      `Matrix shared client account mismatch: requested ${requestedAccountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  if (params.auth) {
    return params.auth;
  }
  if (!params.cfg) {
    throw new Error(
      "Matrix shared client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const authContext = resolveMatrixAuthContext({
    cfg: params.cfg,
    env: params.env,
    accountId: params.accountId,
  });
  return await resolveMatrixAuth({
    cfg: authContext.cfg,
    env: authContext.env,
    accountId: authContext.accountId,
  });
}

async function resolveOpenSharedMatrixClientState(
  params: SharedMatrixClientParams,
): Promise<SharedMatrixClientState> {
  const auth = await resolveSharedMatrixAuth(params);
  const key = buildSharedClientKey(auth);

  while (true) {
    assertSharedClientAccountOpen(key);
    const existing = sharedClientStates.get(key);
    if (existing?.poisonError) {
      throw existing.poisonError;
    }
    if (existing?.phase === "open") {
      return existing;
    }
    if (existing?.retirementPromise) {
      await awaitMatrixStartupWithAbort(existing.replacementReady.promise, params.abortSignal);
      continue;
    }

    const pending = sharedClientPromises.get(key);
    if (pending) {
      await awaitMatrixStartupWithAbort(pending, params.abortSignal);
      continue;
    }

    const creationPromise = createSharedMatrixClient({
      auth,
      timeoutMs: params.timeoutMs,
    });
    sharedClientPromises.set(key, creationPromise);
    try {
      const created = await creationPromise;
      sharedClientStates.set(key, created);
      assertSharedClientAccountOpen(key);
      return created;
    } finally {
      sharedClientPromises.delete(key);
    }
  }
}

async function runMonitorRetirement(
  retirement: MatrixMonitorRetirement | undefined,
): Promise<void> {
  if (!retirement) {
    return;
  }
  retirement.closeTaskAdmission();
  retirement.detachListeners();
  await retirement.waitForTasks();
  await retirement.cleanup();
}

function retireMonitorLease(
  state: SharedMatrixClientState,
  lease: SharedMatrixClientLeaseState,
): Promise<void> {
  if (lease.monitorRetirementPromise) {
    return lease.monitorRetirementPromise;
  }
  lease.monitorRetirementPromise = runMonitorRetirement(lease.monitorRetirement ?? undefined);
  state.monitorRetirementPromises.add(lease.monitorRetirementPromise);
  return lease.monitorRetirementPromise;
}

async function retireMonitorLeases(
  state: SharedMatrixClientState,
  leases: SharedMatrixClientLeaseState[],
): Promise<void> {
  for (const lease of leases) {
    void retireMonitorLease(state, lease);
  }
  const results = await Promise.allSettled(state.monitorRetirementPromises);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

function mergeReleaseMode(
  current: MatrixClientReleaseMode,
  requested: MatrixClientReleaseMode,
): MatrixClientReleaseMode {
  // Release requirements belong to the generation; one lease cannot weaken another's durability.
  if (current === "persist" || requested === "persist") {
    return "persist";
  }
  if (current === "stop" || requested === "stop") {
    return "stop";
  }
  return "discard";
}

function abortGenerationLeases(state: SharedMatrixClientState): void {
  for (const lease of state.leases) {
    lease.abortController.abort();
  }
}

function forceReleaseLeases(
  state: SharedMatrixClientState,
  releasePromise = Promise.resolve(),
): void {
  for (const lease of state.leases) {
    lease.abortController.abort();
    lease.releasePromise ??= releasePromise;
  }
  state.leases.clear();
  state.noLeases.resolve();
}

async function waitForLeaseDrain(state: SharedMatrixClientState): Promise<void> {
  if (state.leases.size === 0) {
    return;
  }
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      state.noLeases.promise,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          reject(
            new Error(
              `Matrix transient leases did not drain within ${MATRIX_TRANSIENT_LEASE_DRAIN_TIMEOUT_MS}ms`,
            ),
          );
        }, MATRIX_TRANSIENT_LEASE_DRAIN_TIMEOUT_MS);
        deadline.unref?.();
      }),
    ]);
  } finally {
    if (deadline) {
      clearTimeout(deadline);
    }
  }
}

function beginGenerationRetirement(params: {
  state: SharedMatrixClientState;
  monitorLeases?: SharedMatrixClientLeaseState[];
  detachOnTimeout?: boolean;
}): Promise<void> {
  const { state } = params;
  if (state.retirementPromise) {
    return state.retirementPromise;
  }
  state.phase = "quiescing";
  state.retirementPromise = Promise.resolve().then(async () => {
    try {
      await state.client.quiesceSync();
      state.started = false;
      await state.client.drainPendingDecryptions("matrix monitor sync quiesce");
    } catch (error) {
      state.poisonError = toRetirementError(error);
    }

    try {
      await retireMonitorLeases(state, params.monitorLeases ?? []);
    } catch (error) {
      state.poisonError ??= toRetirementError(error);
    }

    state.phase = "closing";
    try {
      await waitForLeaseDrain(state);
    } catch (error) {
      if (params.detachOnTimeout) {
        // Sync is already quiesced and its cursor frozen. Detach this generation
        // so a monitor can start while legitimate slow work finishes naturally.
        detachSharedClientState(state);
        await state.noLeases.promise;
      } else {
        state.poisonError ??= toRetirementError(error);
        forceReleaseLeases(state);
      }
    }

    if (state.poisonError) {
      await state.client
        .drainPendingDecryptions("matrix poisoned client shutdown")
        .catch(() => undefined);
      try {
        state.client.stopWithoutPersist();
      } finally {
        deleteSharedClientState(state);
      }
      throw state.poisonError;
    }

    try {
      await state.client.drainPendingDecryptions("matrix shared client final shutdown");
    } catch (error) {
      state.poisonError = toRetirementError(error);
      try {
        state.client.stopWithoutPersist();
      } finally {
        deleteSharedClientState(state);
      }
      throw state.poisonError;
    }
    try {
      const persist = () =>
        retiringClientStates.has(state)
          ? state.client.stopAndPersist({ persistSyncCursor: false })
          : state.client.stopAndPersist();
      if (state.releaseMode === "persist") {
        await persist();
      } else if (state.releaseMode === "discard") {
        state.client.stopWithoutPersist();
      } else {
        await persist().catch(() => state.client.stopWithoutPersist());
      }
    } finally {
      deleteSharedClientState(state);
    }
  });
  abortGenerationLeases(state);
  return state.retirementPromise;
}

function createSharedMatrixClientLease(
  state: SharedMatrixClientState,
  role: MatrixClientLeaseRole,
): SharedMatrixClientLease {
  const leaseState: SharedMatrixClientLeaseState = {
    abortController: new AbortController(),
    monitorAdmitted: false,
    monitorRetirement: null,
    monitorRetirementPromise: null,
    role,
    releasePromise: null,
  };
  state.leases.add(leaseState);

  return {
    abortSignal: leaseState.abortController.signal,
    client: state.client,
    role,
    registerMonitorRetirement: (retirement) => {
      if (role !== "monitor") {
        throw new Error("Matrix transient leases cannot register monitor retirement");
      }
      if (leaseState.releasePromise || state.phase !== "open") {
        throw new Error("Matrix monitor lease is already retiring");
      }
      if (leaseState.monitorRetirement && leaseState.monitorRetirement !== retirement) {
        throw new Error("Matrix monitor retirement is already registered");
      }
      leaseState.monitorRetirement = retirement;
    },
    start: async (abortSignal) => {
      if (leaseState.releasePromise) {
        throw new Error("Matrix client lease has already been released");
      }
      if (state.phase !== "open") {
        throw new Error("Matrix client generation is retiring");
      }
      const startupSignal = abortSignal
        ? AbortSignal.any([abortSignal, leaseState.abortController.signal])
        : leaseState.abortController.signal;
      throwIfMatrixStartupAborted(startupSignal);
      const monitorAttached = [...state.leases].some((candidate) => candidate.role === "monitor");
      if (role === "transient" && monitorAttached) {
        await awaitMatrixStartupWithAbort(state.monitorAdmission.promise, startupSignal);
      } else if (role === "transient") {
        // Transient sync may initialize crypto, but only the monitor may advance the
        // durable inbound cursor; otherwise a later monitor can silently skip events.
        state.monitorlessSyncClaim ??= state.client.freezeSyncCursorPersistence();
        await awaitMatrixStartupWithAbort(state.monitorlessSyncClaim, startupSignal);
      }
      throwIfMatrixStartupAborted(startupSignal);
      if (state.phase !== "open") {
        throw new Error("Matrix client generation is retiring");
      }
      if (role === "monitor") {
        // Monitor listeners are attached before lease.start() opens sync admission.
        leaseState.monitorAdmitted = true;
        state.monitorAdmission.resolve();
      }
      await ensureSharedClientStarted(state, startupSignal);
    },
    release: (releaseParams = {}) => {
      if (leaseState.releasePromise) {
        return leaseState.releasePromise;
      }
      state.releaseMode = mergeReleaseMode(state.releaseMode, releaseParams.mode ?? "stop");
      state.leases.delete(leaseState);
      if (state.leases.size === 0) {
        state.noLeases.resolve();
      }

      const remainingMonitors = [...state.leases].filter((lease) => lease.role === "monitor");
      const finalMonitor = role === "monitor" && remainingMonitors.length === 0;
      const finalAdmittedMonitor =
        role === "monitor" &&
        leaseState.monitorAdmitted &&
        !remainingMonitors.some((lease) => lease.monitorAdmitted);
      if (role === "monitor" && !finalMonitor && !finalAdmittedMonitor) {
        leaseState.releasePromise = retireMonitorLease(state, leaseState);
        return leaseState.releasePromise;
      }
      const shouldRetire = finalMonitor || finalAdmittedMonitor || state.leases.size === 0;
      if (!shouldRetire) {
        leaseState.releasePromise = Promise.resolve();
        return leaseState.releasePromise;
      }
      leaseState.releasePromise = beginGenerationRetirement({
        state,
        monitorLeases: role === "monitor" ? [leaseState, ...remainingMonitors] : undefined,
      });
      return leaseState.releasePromise;
    },
  };
}

export async function acquireSharedMatrixClient(
  params: SharedMatrixClientParams = {},
): Promise<SharedMatrixClientLease> {
  const role = params.role ?? "transient";
  let state: SharedMatrixClientState;
  while (true) {
    state = await resolveOpenSharedMatrixClientState(params);
    assertSharedClientAccountOpen(state.key);
    if (role === "monitor" && state.monitorlessSyncClaim) {
      // Rotate a transient-first generation so the monitor resumes from the
      // homeserver cursor that transient sync was forbidden to persist.
      throwIfMatrixStartupAborted(params.abortSignal);
      const retirement = beginGenerationRetirement({ state, detachOnTimeout: true });
      void retirement.catch((error: unknown) => {
        LogService.warn("MatrixClientLite", "Failed to retire transient-first generation:", error);
      });
      await awaitMatrixStartupWithAbort(state.replacementReady.promise, params.abortSignal);
      continue;
    }
    break;
  }
  const lease = createSharedMatrixClientLease(state, role);
  if (params.startClient !== false) {
    try {
      await lease.start(params.abortSignal);
    } catch (error) {
      await lease.release({ mode: "stop" }).catch(() => undefined);
      throw error;
    }
  }
  return lease;
}

async function forceRetireState(state: SharedMatrixClientState): Promise<void> {
  state.releaseMode = mergeReleaseMode(state.releaseMode, "stop");
  const monitorLeases = Array.from(state.leases).filter((lease) => lease.role === "monitor");
  const retirementPromise = beginGenerationRetirement({
    state,
    monitorLeases,
  });
  forceReleaseLeases(state, retirementPromise);
  if (state.poisonError) {
    await retirementPromise.catch(() => undefined);
    deleteSharedClientState(state);
    return;
  }
  await retirementPromise.catch((error: unknown) => {
    if (!state.poisonError) {
      throw error;
    }
  });
  if (state.poisonError) {
    deleteSharedClientState(state);
  }
}

export async function stopSharedClientForAccount(auth: MatrixAuth): Promise<void> {
  const key = buildSharedClientKey(auth);
  const pendingStop = sharedClientStopPromises.get(key);
  if (pendingStop) {
    await pendingStop;
    return;
  }
  const stopPromise = Promise.resolve().then(async () => {
    while (true) {
      await sharedClientPromises.get(key)?.catch(() => undefined);
      const states = Array.from(retiringClientStates).filter((state) => state.key === key);
      const active = sharedClientStates.get(key);
      if (active) {
        states.push(active);
      }
      if (states.length === 0) {
        return;
      }
      const results = await Promise.allSettled(states.map((state) => forceRetireState(state)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    }
  });
  sharedClientStopPromises.set(key, stopPromise);
  try {
    await stopPromise;
  } finally {
    if (sharedClientStopPromises.get(key) === stopPromise) {
      sharedClientStopPromises.delete(key);
    }
  }
}
