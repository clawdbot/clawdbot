import { discordComponentRegistryState } from "./components-registry-state.js";

export function clearDiscordComponentEntriesForTest(): void {
  discordComponentRegistryState.reset();
}
