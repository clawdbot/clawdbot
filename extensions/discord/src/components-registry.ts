import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";
import { getOptionalDiscordRuntime } from "./runtime.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const PERSISTENT_COMPONENT_NAMESPACE = "discord.components";
const PERSISTENT_MODAL_NAMESPACE = "discord.modals";
const PERSISTENT_COMPONENT_MAX_ENTRIES = 500;
const PERSISTENT_MODAL_MAX_ENTRIES = 500;
const DISCORD_COMPONENT_ENTRIES_KEY = Symbol.for("openclaw.discord.componentEntries");
const DISCORD_MODAL_ENTRIES_KEY = Symbol.for("openclaw.discord.modalEntries");

type PersistedDiscordRegistryEntry<T extends { id: string }> = {
  version: 1;
  entry: T;
};

type DiscordPersistentStore<T> = {
  register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
};

type DiscordRegistryStore<T extends { id: string }> = DiscordPersistentStore<
  PersistedDiscordRegistryEntry<T>
>;

let componentEntries: Map<string, DiscordComponentEntry> | undefined;
let modalEntries: Map<string, DiscordModalEntry> | undefined;
let persistentComponentStore: DiscordRegistryStore<DiscordComponentEntry> | undefined;
let persistentModalStore: DiscordRegistryStore<DiscordModalEntry> | undefined;
let persistentRegistryDisabled = false;

function getComponentEntries(): Map<string, DiscordComponentEntry> {
  componentEntries ??= resolveGlobalMap<string, DiscordComponentEntry>(
    DISCORD_COMPONENT_ENTRIES_KEY,
  );
  return componentEntries;
}

function getModalEntries(): Map<string, DiscordModalEntry> {
  modalEntries ??= resolveGlobalMap<string, DiscordModalEntry>(DISCORD_MODAL_ENTRIES_KEY);
  return modalEntries;
}

function reportPersistentComponentRegistryError(error: unknown): void {
  try {
    getOptionalDiscordRuntime()
      ?.logging.getChildLogger({ plugin: "discord", feature: "component-registry-state" })
      .warn("Discord persistent component registry state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Discord interactions.
  }
}

function disablePersistentComponentRegistry(error: unknown): void {
  persistentRegistryDisabled = true;
  persistentComponentStore = undefined;
  persistentModalStore = undefined;
  reportPersistentComponentRegistryError(error);
}

function getPersistentComponentStore(): DiscordRegistryStore<DiscordComponentEntry> | undefined {
  if (persistentRegistryDisabled) {
    return undefined;
  }
  if (persistentComponentStore) {
    return persistentComponentStore;
  }
  const runtime = getOptionalDiscordRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentComponentStore = runtime.state.openKeyedStore<
      PersistedDiscordRegistryEntry<DiscordComponentEntry>
    >({
      namespace: PERSISTENT_COMPONENT_NAMESPACE,
      maxEntries: PERSISTENT_COMPONENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_COMPONENT_TTL_MS,
    });
    return persistentComponentStore;
  } catch (error) {
    disablePersistentComponentRegistry(error);
    return undefined;
  }
}

function getPersistentModalStore(): DiscordRegistryStore<DiscordModalEntry> | undefined {
  if (persistentRegistryDisabled) {
    return undefined;
  }
  if (persistentModalStore) {
    return persistentModalStore;
  }
  const runtime = getOptionalDiscordRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentModalStore = runtime.state.openKeyedStore<
      PersistedDiscordRegistryEntry<DiscordModalEntry>
    >({
      namespace: PERSISTENT_MODAL_NAMESPACE,
      maxEntries: PERSISTENT_MODAL_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_COMPONENT_TTL_MS,
    });
    return persistentModalStore;
  } catch (error) {
    disablePersistentComponentRegistry(error);
    return undefined;
  }
}

function isExpired(entry: { expiresAt?: number }, now: number) {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= now;
}

function normalizeEntryTimestamps<T extends { createdAt?: number; expiresAt?: number }>(
  entry: T,
  now: number,
  ttlMs: number,
): T {
  const createdAt = entry.createdAt ?? now;
  const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
  return { ...entry, createdAt, expiresAt };
}

function registerEntries<
  T extends { id: string; messageId?: string; createdAt?: number; expiresAt?: number },
>(
  entries: T[],
  store: Map<string, T>,
  params: { now: number; ttlMs: number; messageId?: string },
): T[] {
  const normalizedEntries: T[] = [];
  for (const entry of entries) {
    const normalized = normalizeEntryTimestamps(
      { ...entry, messageId: params.messageId ?? entry.messageId },
      params.now,
      params.ttlMs,
    );
    store.set(entry.id, normalized);
    normalizedEntries.push(normalized);
  }
  return normalizedEntries;
}

function resolveEntry<T extends { expiresAt?: number }>(
  store: Map<string, T>,
  params: { id: string; consume?: boolean },
): T | null {
  const entry = store.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    store.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    store.delete(params.id);
  }
  return entry;
}

function readPersistedRegistryEntry<T extends { id: string }>(
  persisted: PersistedDiscordRegistryEntry<T> | undefined,
): T | null {
  if (persisted?.version !== 1 || typeof persisted.entry?.id !== "string") {
    return null;
  }
  return persisted.entry;
}

function registerPersistentRegistryEntries<T extends { id: string }>(params: {
  entries: T[];
  ttlMs: number;
  openStore: () => DiscordRegistryStore<T> | undefined;
}): void {
  if (params.entries.length === 0) {
    return;
  }
  const store = params.openStore();
  if (!store) {
    return;
  }
  for (const entry of params.entries) {
    void store
      .register(entry.id, { version: 1, entry }, { ttlMs: params.ttlMs })
      .catch(disablePersistentComponentRegistry);
  }
}

function registerPersistentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs: number;
}): void {
  registerPersistentRegistryEntries({
    entries: params.entries,
    ttlMs: params.ttlMs,
    openStore: getPersistentComponentStore,
  });
  registerPersistentRegistryEntries({
    entries: params.modals,
    ttlMs: params.ttlMs,
    openStore: getPersistentModalStore,
  });
}

function deletePersistentEntry<T extends { id: string }>(params: {
  id: string;
  openStore: () => DiscordRegistryStore<T> | undefined;
}): void {
  const store = params.openStore();
  if (!store) {
    return;
  }
  void store.delete(params.id).catch(disablePersistentComponentRegistry);
}

async function resolvePersistentRegistryEntry<T extends { id: string }>(params: {
  id: string;
  consume?: boolean;
  openStore: () => DiscordRegistryStore<T> | undefined;
}): Promise<T | null> {
  const store = params.openStore();
  if (!store) {
    return null;
  }
  try {
    const value =
      params.consume === false ? await store.lookup(params.id) : await store.consume(params.id);
    return readPersistedRegistryEntry(value);
  } catch (error) {
    disablePersistentComponentRegistry(error);
    return null;
  }
}

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  const normalizedEntries = registerEntries(params.entries, getComponentEntries(), {
    now,
    ttlMs,
    messageId: params.messageId,
  });
  const normalizedModals = registerEntries(params.modals, getModalEntries(), {
    now,
    ttlMs,
    messageId: params.messageId,
  });
  registerPersistentEntries({
    entries: normalizedEntries,
    modals: normalizedModals,
    ttlMs,
  });
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  return resolveEntry(getComponentEntries(), params);
}

export async function resolveDiscordComponentEntryWithPersistence(params: {
  id: string;
  consume?: boolean;
}): Promise<DiscordComponentEntry | null> {
  const inMemory = resolveDiscordComponentEntry(params);
  if (inMemory) {
    if (params.consume !== false) {
      deletePersistentEntry({ ...params, openStore: getPersistentComponentStore });
    }
    return inMemory;
  }
  return await resolvePersistentRegistryEntry({
    ...params,
    openStore: getPersistentComponentStore,
  });
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  return resolveEntry(getModalEntries(), params);
}

export async function resolveDiscordModalEntryWithPersistence(params: {
  id: string;
  consume?: boolean;
}): Promise<DiscordModalEntry | null> {
  const inMemory = resolveDiscordModalEntry(params);
  if (inMemory) {
    if (params.consume !== false) {
      deletePersistentEntry({ ...params, openStore: getPersistentModalStore });
    }
    return inMemory;
  }
  return await resolvePersistentRegistryEntry({
    ...params,
    openStore: getPersistentModalStore,
  });
}

export function clearDiscordComponentEntries(): void {
  getComponentEntries().clear();
  getModalEntries().clear();
  persistentComponentStore = undefined;
  persistentModalStore = undefined;
  persistentRegistryDisabled = false;
}
