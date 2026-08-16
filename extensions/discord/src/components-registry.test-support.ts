import { discordComponentRegistryState } from "./components-registry-state.js";

export function clearDiscordComponentEntriesForTest(): void {
  discordComponentRegistryState.componentEntries.clear();
  discordComponentRegistryState.modalEntries.clear();
  discordComponentRegistryState.persistentComponentStore = undefined;
  discordComponentRegistryState.persistentModalStore = undefined;
  discordComponentRegistryState.persistentRegistryDisabled = false;
}
