// Memory Core dreaming state lives in SQLite-backed plugin state.
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
export const DREAMING_DAILY_INGESTION_NAMESPACE = "dreaming-daily-ingestion";
export const DREAMING_SESSION_INGESTION_FILES_NAMESPACE = "dreaming-session-ingestion-files";
export const DREAMING_SESSION_INGESTION_SEEN_NAMESPACE = "dreaming-session-ingestion-seen";
export const SHORT_TERM_RECALL_NAMESPACE = "short-term-recall";
export const SHORT_TERM_PHASE_SIGNAL_NAMESPACE = "short-term-phase-signals";
export const SHORT_TERM_META_NAMESPACE = "short-term-meta";
export const SHORT_TERM_LOCK_NAMESPACE = "short-term-locks";

const DREAMING_WORKSPACE_STATE_MAX_ENTRIES = 50_000;
export const SHORT_TERM_LOCK_MAX_ENTRIES = 4_096;
export const SESSION_SEEN_HASHES_PER_CHUNK = 512;

type MemoryCoreOpenKeyedStore = <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;

type WorkspaceValue<T> = {
  version: 1;
  workspaceKey: string;
  workspaceDir: string;
  key: string;
  value: T;
};

type MemoryCoreWorkspaceEntry<T> = { key: string; value: T };

type MemoryCoreWorkspaceParams = {
  namespace: string;
  workspaceDir: string;
};

type WriteMemoryCoreWorkspaceEntriesParams<T> = MemoryCoreWorkspaceParams & {
  entries: Array<MemoryCoreWorkspaceEntry<T>>;
};

type WriteMemoryCoreWorkspaceEntryParams<T> = MemoryCoreWorkspaceParams &
  MemoryCoreWorkspaceEntry<T>;

let configuredOpenKeyedStore: MemoryCoreOpenKeyedStore | undefined;

export function configureMemoryCoreDreamingState(openKeyedStore: MemoryCoreOpenKeyedStore): void {
  configuredOpenKeyedStore = openKeyedStore;
}

export function openMemoryCoreStateStore<T>(
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  if (!configuredOpenKeyedStore) {
    throw new Error("memory-core dreaming SQLite state store is not configured");
  }
  return configuredOpenKeyedStore<T>(options);
}

export function normalizeMemoryCoreWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function memoryCoreWorkspaceStateKey(workspaceDir: string): string {
  return createHash("sha256").update(normalizeMemoryCoreWorkspaceKey(workspaceDir)).digest("hex");
}

export function memoryCoreWorkspaceEntryKey(workspaceDir: string, logicalKey: string): string {
  const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const itemKey = createHash("sha256").update(logicalKey).digest("hex");
  return `${workspaceKey}:${itemKey}`;
}

export function memoryCoreStateReference(namespace: string, workspaceDir: string): string {
  return `plugin-state:${MEMORY_CORE_PLUGIN_ID}/${namespace}/${memoryCoreWorkspaceStateKey(workspaceDir)}`;
}

function openWorkspaceStore<T>(namespace: string): PluginStateKeyedStore<WorkspaceValue<T>> {
  return openMemoryCoreStateStore<WorkspaceValue<T>>({
    namespace,
    maxEntries: DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
  });
}

// Caller owns typed decoding for values read from plugin state.
export function readMemoryCoreWorkspaceEntries<T>(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<T>>>;
export async function readMemoryCoreWorkspaceEntries(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<unknown>>> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const prefix = `${workspaceKey}:`;
  const entries = await openWorkspaceStore<unknown>(params.namespace).entries();
  return entries
    .filter((entry) => entry.key.startsWith(prefix) && entry.value.workspaceKey === workspaceKey)
    .map((entry) => ({ key: entry.value.key, value: entry.value.value }));
}

// Caller owns typed encoding for values written to plugin state.
export function writeMemoryCoreWorkspaceEntries<T>(
  params: WriteMemoryCoreWorkspaceEntriesParams<T>,
): Promise<void>;
export async function writeMemoryCoreWorkspaceEntries(
  params: WriteMemoryCoreWorkspaceEntriesParams<unknown>,
): Promise<void> {
  const store = openWorkspaceStore<unknown>(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const prefix = `${workspaceKey}:`;
  const replacementKeys = new Set<string>();
  for (const entry of params.entries) {
    const stateKey = memoryCoreWorkspaceEntryKey(params.workspaceDir, entry.key);
    replacementKeys.add(stateKey);
    await store.register(stateKey, {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      key: entry.key,
      value: entry.value,
    });
  }
  for (const entry of await store.entries()) {
    if (entry.key.startsWith(prefix) && !replacementKeys.has(entry.key)) {
      await store.delete(entry.key);
    }
  }
}

// Caller owns typed encoding for values written to plugin state.
export function writeMemoryCoreWorkspaceEntry<T>(
  params: WriteMemoryCoreWorkspaceEntryParams<T>,
): Promise<void>;
export async function writeMemoryCoreWorkspaceEntry(
  params: WriteMemoryCoreWorkspaceEntryParams<unknown>,
): Promise<void> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  await openWorkspaceStore<unknown>(params.namespace).register(
    memoryCoreWorkspaceEntryKey(params.workspaceDir, params.key),
    {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      key: params.key,
      value: params.value,
    },
  );
}

export async function clearMemoryCoreWorkspaceNamespace(params: {
  namespace: string;
  workspaceDir: string;
}): Promise<void> {
  const store = openWorkspaceStore(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const prefix = `${workspaceKey}:`;
  for (const entry of await store.entries()) {
    if (entry.key.startsWith(prefix)) {
      await store.delete(entry.key);
    }
  }
}
