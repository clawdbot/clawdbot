import { discordChannelInfoCacheState } from "./message-channel-info-state.js";

export function clearDiscordChannelInfoCacheForTest(): void {
  discordChannelInfoCacheState.entries.clear();
}
