import { createRequire } from "node:module";

type DiscordVoiceSdk = typeof import("@discordjs/voice");

let cachedDiscordVoiceSdk: DiscordVoiceSdk | null = null;

export function loadDiscordVoiceSdk(): DiscordVoiceSdk {
  if (cachedDiscordVoiceSdk) {
    return cachedDiscordVoiceSdk;
  }
  const req = createRequire(import.meta.url);
  cachedDiscordVoiceSdk = req("@discordjs/voice") as DiscordVoiceSdk;
  return cachedDiscordVoiceSdk;
}
