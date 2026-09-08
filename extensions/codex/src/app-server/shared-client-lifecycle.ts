/** Client ownership and synchronous retirement, independent of startup/auth execution. */
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";

export type SharedCodexAppServerClientEntry = {
  readonly key: string;
  client?: CodexAppServerClient;
  startup?: SharedCodexAppServerClientStartup;
  activeLeases: number;
  // Anonymous releases cannot consume explicit native-subagent retains.
  anonymousLeases: number;
  pendingAcquires: number;
  closeWhenIdle: boolean;
  closeError?: Error;
  startupAbort?: AbortController;
  onStartedClientCallbacks: Set<(client: CodexAppServerClient) => void>;
};

export type SharedCodexAppServerClientStartup = {
  initialized: Promise<void>;
  ready: Promise<CodexAppServerClient>;
};

export type CodexAppServerStartupLifetime = {
  controller: AbortController;
  pending: Set<Promise<unknown>>;
};

export type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  liveClients: Set<CodexAppServerClient>;
  isolatedClients: Set<CodexAppServerClient>;
  entriesByClient: WeakMap<CodexAppServerClient, SharedCodexAppServerClientEntry>;
  desktopGenerationDrainChecks: Set<() => void>;
  startup: CodexAppServerStartupLifetime;
  startMetadata: WeakMap<CodexAppServerClient, CodexAppServerClientStartMetadata>;
};

type CodexAppServerClientStartMetadata = {
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  nativeCommand?: string;
  desktopGeneration?: CodexDesktopGeneration;
};

export const createCodexAppServerStartupLifetime = (): CodexAppServerStartupLifetime => ({
  controller: new AbortController(),
  pending: new Set(),
});

// Share same-build module copies without adopting an older in-process plugin's clients.
export const getSharedCodexAppServerClientState = defineCodexBuildState(
  "openclaw.codexAppServerClientState",
  (): SharedCodexAppServerClientState => ({
    clients: new Map(),
    liveClients: new Set(),
    isolatedClients: new Set(),
    entriesByClient: new WeakMap(),
    desktopGenerationDrainChecks: new Set(),
    startup: createCodexAppServerStartupLifetime(),
    startMetadata: new WeakMap(),
  }),
);

export function getCurrentSharedClientEntry(
  client: CodexAppServerClient | undefined,
): SharedCodexAppServerClientEntry | undefined {
  const state = getSharedCodexAppServerClientState();
  const entry = client ? state.entriesByClient.get(client) : undefined;
  return entry && entry.client === client && state.clients.get(entry.key) === entry
    ? entry
    : undefined;
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
  const currentEntry = getCurrentSharedClientEntry(client);
  const entry = currentEntry ?? state.entriesByClient.get(client);
  if (!entry || (entry.client !== client && !entry.closeError)) {
    return undefined;
  }
  if (currentEntry) {
    state.clients.delete(entry.key);
    entry.closeWhenIdle = true;
  }
  // Detached entries still own explicit native-subagent retains and remember
  // forced closure after the physical client has been cleared.
  if (opts?.failActiveLeases && (currentEntry || !entry.closeError)) {
    entry.closeError = new Error("codex app-server client is closed");
    return {
      activeLeases: entry.activeLeases,
      closed: closeRetiredSharedClientEntry(entry),
    };
  }
  return {
    activeLeases: entry.activeLeases,
    closed: currentEntry ? closeRetiredSharedClientEntryIfIdle(entry) : false,
  };
}

/** Gracefully retires exact clients attached to an older desktop generation. */
export function retireSharedCodexAppServerClientsBeforeDesktopGeneration(
  generation: CodexDesktopGeneration,
): void {
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    const client = entry.client;
    const attached = client ? state.startMetadata.get(client) : undefined;
    if (
      client &&
      attached?.desktopGeneration &&
      attached.desktopGeneration.epoch < generation.epoch
    ) {
      retireSharedCodexAppServerClientIfCurrent(client);
    }
  }
}

export function closeRetiredSharedClientEntryIfIdle(
  entry: SharedCodexAppServerClientEntry,
): boolean {
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

export function closeRetiredSharedClientEntry(entry: SharedCodexAppServerClientEntry): boolean {
  const client = entry.client;
  if (!client) {
    return false;
  }
  entry.client = undefined;
  client.close();
  return true;
}
