import { normalize, resolve, sep } from "node:path";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { loadCopilotSdk } from "./sdk-loader.js";

// SAFETY: The pool reuses CopilotClient instances per normalized PoolKey and does not
// serialize concurrent client.createSession() calls. attempt-bridge MUST treat shared
// CopilotClients as having safe concurrent multi-session semantics that are NOT YET PROVEN;
// if probe q4 reveals concurrency hazards, attempt-bridge must add per-key serialization.

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const POOL_DISPOSED_MESSAGE = "[copilot-pool] pool disposed";

export interface PoolKey {
  readonly agentId: string;
  readonly copilotHome: string;
  readonly authMode: "useLoggedInUser" | "gitHubToken";
  readonly authProfileId?: string;
  readonly authProfileVersion?: string;
}

export interface ClientCreateOptions extends Omit<
  CopilotClientOptions,
  "copilotHome" | "useLoggedInUser" | "gitHubToken"
> {
  readonly copilotHome: string;
  readonly useLoggedInUser?: boolean;
  readonly gitHubToken?: string;
}

export interface PooledClient {
  readonly key: PoolKey;
  readonly client: CopilotClient;
}

export interface CopilotClientPoolOptions {
  readonly sdkFactory?: (opts: CopilotClientOptions) => CopilotClient | Promise<CopilotClient>;
  readonly idleTtlMs?: number;
  readonly now?: () => number;
}

export interface CopilotClientPool {
  acquire(key: PoolKey, options: ClientCreateOptions): Promise<PooledClient>;
  release(handle: PooledClient): Promise<void>;
  dispose(): Promise<Error[]>;
  size(): number;
}

type EntryState =
  | { kind: "creating"; promise: Promise<CopilotClient> }
  | { kind: "ready"; client: CopilotClient }
  | {
      kind: "idle";
      client: CopilotClient;
      idleTimer: ReturnType<typeof setTimeout>;
      idleSinceMs: number;
    }
  | { kind: "stopping"; client: CopilotClient; promise: Promise<Error[]> }
  | { kind: "stopped" };

interface PoolEntry {
  readonly key: PoolKey;
  readonly cacheKey: string;
  refCount: number;
  stopRan: boolean;
  state: EntryState;
}

export function createCopilotClientPool(options: CopilotClientPoolOptions = {}): CopilotClientPool {
  const sdkFactory =
    options.sdkFactory ??
    (async (clientOptions: CopilotClientOptions) => {
      // Lazy-load the SDK so packaged installs without @github/copilot-sdk
      // (the default; see sdk-loader.ts for rationale) crash with an
      // actionable install message instead of a generic MODULE_NOT_FOUND
      // at import time. The loader caches the resolved module after the
      // first successful load.
      const sdk = await loadCopilotSdk();
      return new sdk.CopilotClient(clientOptions);
    });
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, PoolEntry>();
  const releasedHandles = new WeakSet<PooledClient>();
  let disposed = false;
  let disposePromise: Promise<Error[]> | undefined;
  let disposeCompleted = false;

  const createDisposedError = () => new Error(POOL_DISPOSED_MESSAGE);

  const maybeDeleteEntry = (entry: PoolEntry) => {
    if (entries.get(entry.cacheKey) === entry) {
      entries.delete(entry.cacheKey);
    }
  };

  const stopReadyOrIdleEntry = (
    entry: PoolEntry,
    client: CopilotClient,
    idleTimer?: ReturnType<typeof setTimeout>,
  ) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (entry.stopRan) {
      if (entry.state.kind === "stopping") {
        return entry.state.promise;
      }
      if (entry.state.kind === "stopped") {
        return Promise.resolve([]);
      }
    }

    entry.stopRan = true;
    const stopPromise = (async () => {
      try {
        return await client.stop();
      } catch (error: unknown) {
        return [toError(error)];
      } finally {
        entry.state = { kind: "stopped" };
        maybeDeleteEntry(entry);
      }
    })();

    entry.state = { kind: "stopping", client, promise: stopPromise };
    return stopPromise;
  };

  const stopEntry = async (entry: PoolEntry): Promise<Error[]> => {
    switch (entry.state.kind) {
      case "creating": {
        try {
          await entry.state.promise;
        } catch (error: unknown) {
          maybeDeleteEntry(entry);
          return [toError(error)];
        }
        return stopEntry(entry);
      }
      case "ready":
        return stopReadyOrIdleEntry(entry, entry.state.client);
      case "idle":
        return stopReadyOrIdleEntry(entry, entry.state.client, entry.state.idleTimer);
      case "stopping":
        return entry.state.promise;
      case "stopped":
        return [];
      default: {
        const exhaustive: never = entry.state;
        return exhaustive;
      }
    }
  };

  const scheduleIdleStop = (entry: PoolEntry, client: CopilotClient) => {
    const idleTimer = setTimeout(() => {
      void stopEntry(entry);
    }, idleTtlMs);
    entry.state = {
      kind: "idle",
      client,
      idleTimer,
      idleSinceMs: now(),
    };
  };

  const createEntry = (key: PoolKey, cacheKey: string, clientOptions: CopilotClientOptions) => {
    const entry: PoolEntry = {
      key,
      cacheKey,
      refCount: 1,
      stopRan: false,
      state: {
        kind: "creating",
        promise: Promise.resolve(undefined as unknown as CopilotClient),
      },
    };

    const createPromise = (async () => {
      try {
        const client = await sdkFactory(clientOptions);
        entry.state = { kind: "ready", client };
        return client;
      } catch (error: unknown) {
        entry.state = { kind: "stopped" };
        maybeDeleteEntry(entry);
        throw toError(error);
      }
    })();

    entry.state = { kind: "creating", promise: createPromise };
    entries.set(cacheKey, entry);
    return { entry, createPromise };
  };

  const acquire = async (
    inputKey: PoolKey,
    optionsForCreate: ClientCreateOptions,
  ): Promise<PooledClient> => {
    const key = normalizePoolKey(inputKey, optionsForCreate.copilotHome);
    const cacheKey = JSON.stringify(key);
    const clientOptions = normalizeClientCreateOptions(optionsForCreate, key.copilotHome);

    while (true) {
      if (disposed) {
        throw createDisposedError();
      }

      const existing = entries.get(cacheKey);
      if (!existing) {
        const created = createEntry(key, cacheKey, clientOptions);
        try {
          const client = await created.createPromise;
          if (disposed) {
            await stopEntry(created.entry);
            throw createDisposedError();
          }
          return { key: created.entry.key, client };
        } catch (error: unknown) {
          throw toError(error);
        }
      }

      switch (existing.state.kind) {
        case "creating": {
          existing.refCount += 1;
          try {
            const client = await existing.state.promise;
            if (disposed) {
              await stopEntry(existing);
              throw createDisposedError();
            }
            return { key: existing.key, client };
          } catch (error: unknown) {
            throw toError(error);
          }
        }
        case "ready":
          existing.refCount += 1;
          return { key: existing.key, client: existing.state.client };
        case "idle": {
          const client = existing.state.client;
          clearTimeout(existing.state.idleTimer);
          existing.refCount += 1;
          existing.state = { kind: "ready", client };
          return { key: existing.key, client };
        }
        case "stopping":
          await existing.state.promise;
          continue;
        case "stopped":
          maybeDeleteEntry(existing);
          continue;
      }
    }
  };

  const release = async (handle: PooledClient): Promise<void> => {
    if (releasedHandles.has(handle)) {
      return;
    }
    releasedHandles.add(handle);

    const entry = entries.get(JSON.stringify(handle.key));
    if (!entry) {
      return;
    }

    switch (entry.state.kind) {
      case "creating":
      case "stopping":
      case "stopped":
        return;
      case "ready":
      case "idle":
        if (entry.state.client !== handle.client) {
          return;
        }
        break;
    }

    if (entry.refCount <= 0) {
      return;
    }

    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }

    if (disposed) {
      await stopEntry(entry);
      return;
    }

    if (entry.state.kind === "ready") {
      scheduleIdleStop(entry, entry.state.client);
      return;
    }

    if (entry.state.kind === "idle") {
      clearTimeout(entry.state.idleTimer);
      scheduleIdleStop(entry, entry.state.client);
    }
  };

  const dispose = async (): Promise<Error[]> => {
    if (disposeCompleted) {
      return [];
    }
    if (disposePromise) {
      await disposePromise;
      return [];
    }

    disposed = true;
    const snapshot = [...entries.values()];
    for (const entry of snapshot) {
      if (entry.state.kind === "idle") {
        clearTimeout(entry.state.idleTimer);
      }
    }

    disposePromise = (async () => {
      const errors: Error[] = [];
      for (const entry of snapshot) {
        const stopErrors = await stopEntry(entry);
        errors.push(...stopErrors);
      }
      entries.clear();
      disposeCompleted = true;
      return errors;
    })();

    try {
      return await disposePromise;
    } finally {
      disposePromise = undefined;
    }
  };

  return {
    acquire,
    release,
    dispose,
    size: () => entries.size,
  };
}

function normalizePoolKey(key: PoolKey, rawCopilotHome: string): PoolKey {
  return {
    agentId: key.agentId,
    copilotHome: normalizeCopilotHome(rawCopilotHome),
    authMode: key.authMode,
    authProfileId: key.authProfileId,
    authProfileVersion: key.authProfileVersion,
  };
}

function normalizeClientCreateOptions(
  options: ClientCreateOptions,
  normalizedCopilotHome: string,
): CopilotClientOptions {
  return {
    ...options,
    copilotHome: normalizedCopilotHome,
  };
}

function normalizeCopilotHome(copilotHome: string): string {
  let normalizedHome = resolve(copilotHome);
  normalizedHome = normalize(normalizedHome);
  if (normalizedHome.endsWith(sep) && normalizedHome.length > 1) {
    normalizedHome = normalizedHome.slice(0, -1);
  }
  if (process.platform === "win32") {
    normalizedHome = normalizedHome.toLowerCase();
  }
  return normalizedHome;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
