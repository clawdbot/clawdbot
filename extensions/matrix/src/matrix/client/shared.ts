import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { LogService } from "../sdk/logger.js";
import { awaitMatrixStartupWithAbort } from "../startup-abort.js";
import { resolveMatrixAuth, resolveMatrixAuthContext } from "./config.js";
import type { MatrixAuth } from "./types.js";

type MatrixCreateClientDeps = {
  createMatrixClient: typeof import("./create-client.js").createMatrixClient;
};

let matrixCreateClientDepsPromise: Promise<MatrixCreateClientDeps> | undefined;

async function loadMatrixCreateClientDeps(): Promise<MatrixCreateClientDeps> {
  matrixCreateClientDepsPromise ??= import("./create-client.js").then((runtime) => ({
    createMatrixClient: runtime.createMatrixClient,
  }));
  return await matrixCreateClientDepsPromise;
}

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
  startPromise: Promise<void> | null;
  leases: number;
};

const sharedClientStates = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();

function serializeDispatcherPolicyKey(auth: MatrixAuth): string {
  return JSON.stringify(auth.dispatcherPolicy ?? null);
}

function buildSharedClientKey(auth: MatrixAuth): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    auth.allowPrivateNetwork ? "private-net" : "strict-net",
    serializeDispatcherPolicyKey(auth),
    auth.accountId,
  ].join("|");
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
    client,
    key: buildSharedClientKey(params.auth),
    started: false,
    cryptoReady: false,
    startPromise: null,
    leases: 0,
  };
}

function findSharedClientStateByInstance(client: MatrixClient): SharedMatrixClientState | null {
  for (const state of sharedClientStates.values()) {
    if (state.client === client) {
      return state;
    }
  }
  return null;
}

function deleteSharedClientState(state: SharedMatrixClientState): void {
  sharedClientStates.delete(state.key);
  sharedClientPromises.delete(state.key);
}

async function ensureSharedClientStarted(params: {
  state: SharedMatrixClientState;
  encryption?: boolean;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const waitForStart = async (startPromise: Promise<void>) => {
    await awaitMatrixStartupWithAbort(startPromise, params.abortSignal);
  };

  if (params.state.started) {
    return;
  }
  if (params.state.startPromise) {
    await waitForStart(params.state.startPromise);
    return;
  }

  const startPromise = (async () => {
    const client = params.state.client;

    // Initialize crypto if enabled
    if (params.encryption && !params.state.cryptoReady) {
      try {
        const joinedRooms = await client.getJoinedRooms();
        if (client.crypto) {
          await client.crypto.prepare(joinedRooms);
          params.state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await client.start({ abortSignal: params.abortSignal });
    params.state.started = true;
  })();
  // Keep the shared startup lock until the underlying start fully settles, even
  // if one waiter aborts early while another caller still owns the startup.
  const guardedStart = startPromise.finally(() => {
    if (params.state.startPromise === guardedStart) {
      params.state.startPromise = null;
    }
  });
  params.state.startPromise = guardedStart;

  await waitForStart(guardedStart);
}

async function resolveSharedMatrixClientState(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
    abortSignal?: AbortSignal;
  } = {},
): Promise<SharedMatrixClientState> {
  const requestedAccountId = normalizeOptionalAccountId(params.accountId);
  if (params.auth && requestedAccountId && requestedAccountId !== params.auth.accountId) {
    throw new Error(
      `Matrix shared client account mismatch: requested ${requestedAccountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const authContext = params.auth
    ? null
    : resolveMatrixAuthContext({
        cfg: params.cfg,
        env: params.env,
        accountId: params.accountId,
      });
  const auth =
    params.auth ??
    (await resolveMatrixAuth({
      cfg: authContext?.cfg ?? params.cfg,
      env: authContext?.env ?? params.env,
      accountId: authContext?.accountId,
    }));
  const key = buildSharedClientKey(auth);
  const shouldStart = params.startClient !== false;

  const existingState = sharedClientStates.get(key);
  if (existingState) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: existingState,
        encryption: auth.encryption,
        abortSignal: params.abortSignal,
      });
    }
    return existingState;
  }

  const existingPromise = sharedClientPromises.get(key);
  if (existingPromise) {
    const pending = await existingPromise;
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: pending,
        encryption: auth.encryption,
        abortSignal: params.abortSignal,
      });
    }
    return pending;
  }

  const creationPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
  });
  sharedClientPromises.set(key, creationPromise);

  try {
    const created = await creationPromise;
    sharedClientStates.set(key, created);
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: created,
        encryption: auth.encryption,
        abortSignal: params.abortSignal,
      });
    }
    return created;
  } finally {
    sharedClientPromises.delete(key);
  }
}

export async function resolveSharedMatrixClient(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
    abortSignal?: AbortSignal;
  } = {},
): Promise<MatrixClient> {
  const state = await resolveSharedMatrixClientState(params);
  return state.client;
}

export async function acquireSharedMatrixClient(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
    abortSignal?: AbortSignal;
  } = {},
): Promise<MatrixClient> {
  const state = await resolveSharedMatrixClientState(params);
  state.leases += 1;
  return state.client;
}

export function stopSharedClient(): void {
  for (const state of sharedClientStates.values()) {
    state.client.stop();
  }
  sharedClientStates.clear();
  sharedClientPromises.clear();
}

export function stopSharedClientForAccount(auth: MatrixAuth): void {
  const key = buildSharedClientKey(auth);
  const state = sharedClientStates.get(key);
  if (!state) {
    return;
  }
  state.client.stop();
  deleteSharedClientState(state);
}

export function removeSharedClientInstance(client: MatrixClient): boolean {
  const state = findSharedClientStateByInstance(client);
  if (!state) {
    return false;
  }
  deleteSharedClientState(state);
  return true;
}

export function stopSharedClientInstance(client: MatrixClient): void {
  if (!removeSharedClientInstance(client)) {
    return;
  }
  client.stop();
}

export async function releaseSharedClientInstance(
  client: MatrixClient,
  mode: "stop" | "persist" = "stop",
): Promise<boolean> {
  const state = findSharedClientStateByInstance(client);
  if (!state) {
    return false;
  }
  state.leases = Math.max(0, state.leases - 1);
  if (state.leases > 0) {
    return false;
  }
  deleteSharedClientState(state);
  if (mode === "persist") {
    await client.stopAndPersist();
  } else {
    client.stop();
  }
  return true;
}
