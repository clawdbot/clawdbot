/**
 * Owns shared and isolated Codex app-server client startup, auth application,
 * lease tracking, and teardown.
 */
import { resolveDefaultAgentDir, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerFallbackApiKeyCacheKey,
} from "./auth-bridge.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { CodexAppServerClient, isUnsupportedCodexAppServerVersionError } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  activeLeases: number;
  pendingAcquires: number;
  closeWhenIdle: boolean;
  closeError?: Error;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  leasedReleases: WeakMap<CodexAppServerClient, Array<() => void>>;
};

// Clients we already force-closed for suspect retirement; a repeat retire must
// report closed:false instead of pretending to close the corpse again.
const suspectClosedClients = new WeakSet<CodexAppServerClient>();

// Symbol.for shares one client table across duplicate module copies (dist +
// src bundles in one process). Plugin updates restart the gateway, so every
// copy writing this state runs the same code and the shape never migrates.
const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= {
    clients: new Map(),
    leasedReleases: new WeakMap(),
  };
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

export type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  onStartedClient?: (client: CodexAppServerClient) => void;
  abandonSignal?: AbortSignal;
};

/** Factory used by attempt startup and side turns to acquire a leased client. */
export type CodexAppServerClientFactory = (
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClient>;

type IsolatedCodexAppServerClientOptions = CodexAppServerClientOptions & {
  authProfileStore?: AuthProfileStore;
};

type ResolvedCodexAppServerClientStartContext = {
  agentDir: string;
  usesNativeAuth: boolean;
  authProfileId: string | undefined;
  authProfileStore: AuthProfileStore | undefined;
  startOptions: CodexAppServerStartOptions;
};

async function resolveCodexAppServerClientStartContext(
  options?: IsolatedCodexAppServerClientOptions,
): Promise<ResolvedCodexAppServerClientStartContext> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const usesNativeAuth =
    options?.authProfileId === null || requestedStartOptions.homeScope === "user";
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileStore =
    !usesNativeAuth && options?.authProfileStore
      ? resolveCodexAppServerAuthProfileStore({
          agentDir,
          authProfileId: requestedAuthProfileId,
          authProfileStore: options.authProfileStore,
          config: options.config,
        })
      : options?.authProfileStore;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
        ...(authProfileStore ? { authProfileStore } : {}),
      });
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
    ...(authProfileStore ? { authProfileStore } : {}),
  });
  return { agentDir, usesNativeAuth, authProfileId, authProfileStore, startOptions };
}

/** Gets or starts a shared Codex app-server client without retaining a lease. */
export async function getSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  return (await acquireSharedCodexAppServerClient(options)).client;
}

/** Gets or starts a shared Codex app-server client and records a release lease. */
export async function getLeasedSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const acquired = await acquireSharedCodexAppServerClient(options, { leased: true });
  const state = getSharedCodexAppServerClientState();
  const releases = state.leasedReleases.get(acquired.client) ?? [];
  releases.push(acquired.release);
  state.leasedReleases.set(acquired.client, releases);
  return acquired.client;
}

/** Releases one outstanding lease for a shared Codex app-server client. */
export function releaseLeasedSharedCodexAppServerClient(client: CodexAppServerClient): boolean {
  const state = getSharedCodexAppServerClientState();
  const releases = state.leasedReleases.get(client);
  if (!releases) {
    return false;
  }
  const release = releases.pop();
  if (!release) {
    return false;
  }
  if (releases.length === 0) {
    state.leasedReleases.delete(client);
  }
  release();
  return true;
}

async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<{ client: CodexAppServerClient }>;
async function acquireSharedCodexAppServerClient(
  options: CodexAppServerClientOptions | undefined,
  leaseOptions: { leased: true },
): Promise<{ client: CodexAppServerClient; release: () => void }>;
async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
  leaseOptions?: { leased: true },
): Promise<{ client: CodexAppServerClient; release?: () => void }> {
  const { agentDir, usesNativeAuth, authProfileId, startOptions } =
    await resolveCodexAppServerClientStartContext(options);
  const fallbackApiKeyCacheKey = authProfileId
    ? undefined
    : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir: usesNativeAuth ? undefined : agentDir,
    fallbackApiKeyCacheKey,
  });
  const state = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(state, key);
  const releasePendingAcquire = retainPendingSharedClientAcquire(entry);
  let cleanupAbandonSignal: (() => void) | undefined;
  if (options?.abandonSignal) {
    const abandon = () => {
      // Release this acquire before cleanup checks ownership; only other
      // pending callers should keep the startup client alive.
      releasePendingAcquire();
      closeSharedClientEntryIfUnclaimed(key, entry);
    };
    options.abandonSignal.addEventListener("abort", abandon, { once: true });
    cleanupAbandonSignal = () => options.abandonSignal?.removeEventListener("abort", abandon);
    if (options.abandonSignal.aborted) {
      abandon();
    }
  }
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = await startInitializedCodexAppServerClient({
        startOptions,
        agentDir,
        authProfileId: usesNativeAuth ? null : authProfileId,
        config: options?.config,
        onStartedClient: (startedClient) => {
          entry.client = startedClient;
          options?.onStartedClient?.(startedClient);
        },
      });
      entry.client = client;
      client.addCloseHandler((closedClient) => clearSharedClientEntryIfCurrent(key, closedClient));
      return client;
    })());
  try {
    const client = await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
    if (entry.closeError) {
      throw entry.closeError;
    }
    // Later leases of the same keyed client may carry fresher config; the
    // runtime install itself stays one-per-physical-client.
    ensureCodexAppServerClientRuntime(client, {
      agentDir,
      authProfileId: usesNativeAuth ? undefined : authProfileId,
      config: options?.config,
    });
    const release = leaseOptions?.leased ? retainSharedClientEntry(entry) : undefined;
    return release ? { client, release } : { client };
  } catch (error) {
    const currentEntry = state.clients.get(key);
    if (currentEntry?.promise === sharedPromise) {
      clearSharedClientEntry(key, currentEntry);
    }
    throw error;
  } finally {
    cleanupAbandonSignal?.();
    releasePendingAcquire();
  }
}

/** Starts a non-shared Codex app-server client owned entirely by the caller. */
export async function createIsolatedCodexAppServerClient(
  options?: IsolatedCodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const { agentDir, usesNativeAuth, authProfileId, authProfileStore, startOptions } =
    await resolveCodexAppServerClientStartContext(options);
  return await startInitializedCodexAppServerClient({
    startOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    authProfileStore,
    config: options?.config,
    timeoutMs: options?.timeoutMs,
    onStartedClient: options?.onStartedClient,
  });
}

async function startInitializedCodexAppServerClient(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId: string | null | undefined;
  authProfileStore?: AuthProfileStore;
  config?: CodexAppServerClientOptions["config"];
  timeoutMs?: number;
  onStartedClient?: (client: CodexAppServerClient) => void;
}): Promise<CodexAppServerClient> {
  const startOptionsCandidates = resolveManagedFallbackStartOptions(params.startOptions);
  for (let index = 0; index < startOptionsCandidates.length; index += 1) {
    const startOptions = startOptionsCandidates[index];
    const client = CodexAppServerClient.start(startOptions);
    params.onStartedClient?.(client);
    const initialize = client.initialize();
    try {
      await withTimeout(initialize, params.timeoutMs ?? 0, "codex app-server initialize timed out");
    } catch (error) {
      client.close();
      void initialize.catch(() => undefined);
      if (shouldTryManagedFallbackStartOption(error, startOptions, index, startOptionsCandidates)) {
        continue;
      }
      throw error;
    }

    ensureCodexAppServerClientRuntime(client, {
      agentDir: params.agentDir,
      authProfileId: params.authProfileId ?? undefined,
      ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
      config: params.config,
    });

    try {
      await applyCodexAppServerAuthProfile({
        client,
        agentDir: params.agentDir,
        authProfileId: params.authProfileId,
        startOptions,
        config: params.config,
        ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  throw new Error("Managed Codex app-server fallback candidates were exhausted.");
}

function resolveManagedFallbackStartOptions(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions[] {
  const commands = [startOptions.command, ...(startOptions.managedFallbackCommandPaths ?? [])];
  const candidates: CodexAppServerStartOptions[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const managedFallbackCommandPaths = commands.slice(index + 1);
    const candidate = {
      ...startOptions,
      command,
    };
    if (managedFallbackCommandPaths.length === 0) {
      delete candidate.managedFallbackCommandPaths;
    } else {
      candidate.managedFallbackCommandPaths = managedFallbackCommandPaths;
    }
    candidates.push(candidate);
  }
  return candidates;
}

function shouldTryManagedFallbackStartOption(
  error: unknown,
  startOptions: CodexAppServerStartOptions,
  index: number,
  startOptionsCandidates: readonly CodexAppServerStartOptions[],
): boolean {
  return (
    startOptions.commandSource === "resolved-managed" &&
    index < startOptionsCandidates.length - 1 &&
    isUnsupportedCodexAppServerVersionError(error)
  );
}

/** Clears and closes all shared clients for deterministic tests. */
export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  state.leasedReleases = new WeakMap();
  for (const client of clients) {
    client.close();
  }
}

/** Clears and closes all shared clients. */
export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  for (const client of clients) {
    client.close();
  }
}

/** Clears and closes the shared entry only if it still owns the supplied client. */
export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      client.close();
      return true;
    }
  }
  return false;
}

/** Detaches the shared entry without closing the client when it still matches. */
export function detachSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      return true;
    }
  }
  return false;
}

/** Retains the matching shared client and returns a release callback. */
export function retainSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): (() => void) | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    if (entry.client === client) {
      return retainSharedClientEntry(entry);
    }
  }
  return undefined;
}

/**
 * Retires a matching shared client. Default is graceful: detach from the map
 * (future acquisitions get a fresh client) and close once leases drain.
 * `failActiveLeases` is for suspect clients only (timed-out turns): it closes
 * the physical connection immediately so co-leased attempts hit the normal
 * client-closed retry path, and pending acquires reject instead of leasing
 * the poisoned process. Routine cleanup must NOT use it — it would abort
 * healthy sibling turns on a working client.
 */
export function retireSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
  opts?: { failActiveLeases?: boolean },
): { activeLeases: number; closed: boolean } | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      entry.closeWhenIdle = true;
      if (opts?.failActiveLeases) {
        entry.closeError = new Error("codex app-server client is closed");
        const closed = closeRetiredSharedClientEntry(entry);
        if (closed) {
          suspectClosedClients.add(client);
        }
        return { activeLeases: entry.activeLeases, closed };
      }
      const closed = closeRetiredSharedClientEntryIfIdle(entry);
      return { activeLeases: entry.activeLeases, closed };
    }
  }
  const activeLeases = state.leasedReleases.get(client)?.length ?? 0;
  if (activeLeases > 0) {
    // A gracefully detached client (e.g. one-shot cleanup) can still be leased
    // when a later terminal-idle kill declares it suspect; the map miss must
    // not let the poisoned process keep serving those co-leases.
    if (opts?.failActiveLeases && !suspectClosedClients.has(client)) {
      suspectClosedClients.add(client);
      client.close();
      return { activeLeases, closed: true };
    }
    return { activeLeases, closed: false };
  }
  return undefined;
}

/** Clears a matching shared client and waits for its process to exit. */
export async function clearSharedCodexAppServerClientIfCurrentAndWait(
  client: CodexAppServerClient | undefined,
  options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  },
): Promise<boolean> {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      await client.closeAndWait(options);
      return true;
    }
  }
  return false;
}

/** Clears all shared clients and waits for their processes to exit. */
export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = { activeLeases: 0, pendingAcquires: 0, closeWhenIdle: false };
    state.clients.set(key, entry);
  }
  return entry;
}

function clearSharedClientEntry(key: string, entry: SharedCodexAppServerClientEntry): void {
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(key) !== entry) {
    return;
  }
  state.clients.delete(key);
  entry.client?.close();
}

function clearSharedClientEntryIfCurrent(key: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.clients.get(key);
  if (entry?.client === client) {
    state.clients.delete(key);
  }
}

/** Clears a matching shared client only when no lease or acquire currently claims it. */
export function clearSharedCodexAppServerClientIfCurrentAndUnclaimed(
  client: CodexAppServerClient | undefined,
): { found: boolean; closed: boolean; activeLeases: number; pendingAcquires: number } {
  if (!client) {
    return { found: false, closed: false, activeLeases: 0, pendingAcquires: 0 };
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      return {
        found: true,
        closed: closeSharedClientEntryIfUnclaimed(key, entry),
        activeLeases: entry.activeLeases,
        pendingAcquires: entry.pendingAcquires,
      };
    }
  }
  return { found: false, closed: false, activeLeases: 0, pendingAcquires: 0 };
}

function retainPendingSharedClientAcquire(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.pendingAcquires += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.pendingAcquires = Math.max(0, entry.pendingAcquires - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
  };
}

function retainSharedClientEntry(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.activeLeases += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
  };
}

function closeRetiredSharedClientEntryIfIdle(entry: SharedCodexAppServerClientEntry): boolean {
  if (
    !entry.closeWhenIdle ||
    entry.activeLeases > 0 ||
    entry.pendingAcquires > 0 ||
    !entry.client
  ) {
    return false;
  }
  const client = entry.client;
  entry.closeWhenIdle = false;
  entry.client = undefined;
  client.close();
  return true;
}

function closeRetiredSharedClientEntry(entry: SharedCodexAppServerClientEntry): boolean {
  const client = entry.client;
  if (!client) {
    return false;
  }
  entry.client = undefined;
  client.close();
  return true;
}

function closeSharedClientEntryIfUnclaimed(
  key: string,
  entry: SharedCodexAppServerClientEntry,
): boolean {
  if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(key) !== entry) {
    return false;
  }
  state.clients.delete(key);
  entry.client?.close();
  return Boolean(entry.client);
}

function collectSharedClients(state: SharedCodexAppServerClientState): CodexAppServerClient[] {
  return [
    ...new Set(
      [...state.clients.values()]
        .map((entry) => entry.client)
        .filter((client): client is CodexAppServerClient => Boolean(client)),
    ),
  ];
}
