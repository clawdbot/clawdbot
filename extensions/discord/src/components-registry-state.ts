import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

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

export type DiscordRegistryStore<T extends { id: string }> = DiscordPersistentStore<
  PersistedDiscordRegistryEntry<T>
>;

export const discordComponentRegistryState = {
  componentEntries: resolveGlobalMap<string, DiscordComponentEntry>(
    Symbol.for("openclaw.discord.componentEntries"),
  ),
  modalEntries: resolveGlobalMap<string, DiscordModalEntry>(
    Symbol.for("openclaw.discord.modalEntries"),
  ),
  persistentComponentStore: undefined as DiscordRegistryStore<DiscordComponentEntry> | undefined,
  persistentModalStore: undefined as DiscordRegistryStore<DiscordModalEntry> | undefined,
  persistentRegistryDisabled: false,
  reset(): void {
    this.componentEntries.clear();
    this.modalEntries.clear();
    this.persistentComponentStore = undefined;
    this.persistentModalStore = undefined;
    this.persistentRegistryDisabled = false;
  },
};
