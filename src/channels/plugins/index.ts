import {
  CHAT_CHANNEL_ORDER,
  type ChatChannelId,
  normalizeChatChannelId,
} from "../registry.js";
import { discordPlugin } from "./discord.js";
import { imessagePlugin } from "./imessage.js";
import { msteamsPlugin } from "./msteams.js";
import { signalPlugin } from "./signal.js";
import { slackPlugin } from "./slack.js";
import { telegramPlugin } from "./telegram.js";
import type { ChannelId, ChannelPlugin } from "./types.js";
import { whatsappPlugin } from "./whatsapp.js";

// Channel plugins registry (runtime).
//
// This module is intentionally "heavy" (plugins may import channel monitors, web login, etc).
// Shared code paths (reply flow, command auth, sandbox explain) should depend on `src/channels/dock.ts`
// instead, and only call `getChannelPlugin()` at execution boundaries.
//
// Adding a channel:
// - add `<id>Plugin` import + entry in `resolveChannels()`
// - add an entry to `src/channels/dock.ts` for shared behavior (capabilities, allowFrom, threading, …)
// - add ids/aliases in `src/channels/registry.ts`
function resolveChannels(): ChannelPlugin[] {
  return [
    telegramPlugin,
    whatsappPlugin,
    discordPlugin,
    slackPlugin,
    signalPlugin,
    imessagePlugin,
    msteamsPlugin,
  ];
}

export function listChannelPlugins(): ChannelPlugin[] {
  return resolveChannels().sort((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return resolveChannels().find((plugin) => plugin.id === id);
}

export function normalizeChannelId(raw?: string | null): ChannelId | null {
  // Channel docking: keep input normalization centralized in src/channels/registry.ts
  // so CLI/API/protocol can rely on stable aliases without plugin init side effects.
  return normalizeChatChannelId(raw);
}

export {
  discordPlugin,
  imessagePlugin,
  msteamsPlugin,
  signalPlugin,
  slackPlugin,
  telegramPlugin,
  whatsappPlugin,
};
export type { ChannelId, ChannelPlugin } from "./types.js";
