import { discordDirectoryCacheState } from "./directory-cache-state.js";

export function clearDiscordDirectoryCacheForTest(): void {
  discordDirectoryCacheState.handlesByAccount.clear();
}
