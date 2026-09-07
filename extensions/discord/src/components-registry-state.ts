import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
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

export const discordComponentRegistryState = resolveGlobalSingleton(
  Symbol.for("openclaw.discord.componentRegistryState"),
  () => ({
    componentEntries: new Map<string, DiscordComponentEntry>(),
    modalEntries: new Map<string, DiscordModalEntry>(),
    persistentComponentStore: undefined as DiscordRegistryStore<DiscordComponentEntry> | undefined,
    persistentModalStore: undefined as DiscordRegistryStore<DiscordModalEntry> | undefined,
    persistentRegistryDisabled: false,
  }),
  (state) => {
    state.componentEntries.clear();
    state.modalEntries.clear();
    state.persistentComponentStore = undefined;
    state.persistentModalStore = undefined;
    state.persistentRegistryDisabled = false;
  },
);
