import {
  CHAT_PROVIDER_ORDER,
  type ChatProviderId,
  normalizeChatProviderId,
} from "../registry.js";
import { discordPlugin } from "./discord.js";
import { imessagePlugin } from "./imessage.js";
import { msteamsPlugin } from "./msteams.js";
import { signalPlugin } from "./signal.js";
import { slackPlugin } from "./slack.js";
import { telegramPlugin } from "./telegram.js";
import type { ProviderId, ProviderPlugin } from "./types.js";
import { whatsappPlugin } from "./whatsapp.js";

// Provider plugins registry (runtime).
//
// This module is intentionally "heavy" (plugins may import provider monitors, web login, etc).
// Shared code paths (reply flow, command auth, sandbox explain) should depend on `src/providers/dock.ts`
// instead, and only call `getProviderPlugin()` at execution boundaries.
//
// Adding a provider:
// - add `<id>Plugin` import + entry in `resolveProviders()`
// - add an entry to `src/providers/dock.ts` for shared behavior (capabilities, allowFrom, threading, …)
// - add ids/aliases in `src/providers/registry.ts`
function resolveProviders(): ProviderPlugin[] {
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

export function listProviderPlugins(): ProviderPlugin[] {
  return resolveProviders().sort((a, b) => {
    const indexA = CHAT_PROVIDER_ORDER.indexOf(a.id as ChatProviderId);
    const indexB = CHAT_PROVIDER_ORDER.indexOf(b.id as ChatProviderId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

export function getProviderPlugin(id: ProviderId): ProviderPlugin | undefined {
  return resolveProviders().find((plugin) => plugin.id === id);
}

export function normalizeProviderId(raw?: string | null): ProviderId | null {
  // Provider docking: keep input normalization centralized in src/providers/registry.ts
  // so CLI/API/protocol can rely on stable aliases without plugin init side effects.
  return normalizeChatProviderId(raw);
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
export type { ProviderId, ProviderPlugin } from "./types.js";
