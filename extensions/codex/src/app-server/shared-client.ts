import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
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
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
};

type LegacySharedCodexAppServerClientState = Partial<SharedCodexAppServerClientEntry> & {
  key?: string;
  clients?: unknown;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: unknown;
  };
  const state = globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
  if (isSharedCodexAppServerClientState(state)) {
    return state;
  }
  const legacyState = readLegacySharedCodexAppServerClientState(state);
  const clients = new Map<string, SharedCodexAppServerClientEntry>();
  if (legacyState?.key && (legacyState.client || legacyState.promise)) {
    const legacyKey = legacyState.key;
    clients.set(legacyKey, { client: legacyState.client, promise: legacyState.promise });
    legacyState.client?.addCloseHandler((closedClient) =>
      clearSharedClientEntryIfCurrent(legacyKey, closedClient),
    );
  }
  const nextState: SharedCodexAppServerClientState = { clients };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] = nextState;
  return nextState;
}

function isSharedCodexAppServerClientState(
  value: unknown,
): value is SharedCodexAppServerClientState {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { clients?: unknown }).clients instanceof Map
  );
}

function readLegacySharedCodexAppServerClientState(
  value: unknown,
): LegacySharedCodexAppServerClientState | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as LegacySharedCodexAppServerClientState;
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir: usesNativeAuth ? undefined : agentDir,
  });
  const state = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(state, key);
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      entry.client = client;
      client.addCloseHandler((closedClient) => clearSharedClientEntryIfCurrent(key, closedClient));
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId: usesNativeAuth ? null : authProfileId,
          startOptions,
          config: options?.config,
        });
        return client;
      } catch (error) {
        // Startup failures happen before callers own the shared client, so close
        // the child here instead of leaving a rejected daemon attached to stdio.
        client.close();
        throw error;
      }
    })());
  try {
    return await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    const currentEntry = state.clients.get(key);
    if (currentEntry?.promise === sharedPromise) {
      clearSharedClientEntry(key, currentEntry);
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId: usesNativeAuth ? null : authProfileId,
      startOptions,
      config: options?.config,
    });
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  state.clients.clear();
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  for (const client of clients) {
    client.close();
  }
}

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
    entry = {};
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

function collectSharedClients(state: SharedCodexAppServerClientState): CodexAppServerClient[] {
  return [
    ...new Set(
      [...state.clients.values()]
        .map((entry) => entry.client)
        .filter((client): client is CodexAppServerClient => Boolean(client)),
    ),
  ];
}
