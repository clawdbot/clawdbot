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

const PROVIDERS: ProviderPlugin[] = [
  telegramPlugin,
  whatsappPlugin,
  discordPlugin,
  slackPlugin,
  signalPlugin,
  imessagePlugin,
  msteamsPlugin,
];

const PROVIDER_ALIASES = (() => {
  const map = new Map<string, ProviderId>();
  for (const plugin of PROVIDERS) {
    for (const alias of plugin.meta.aliases ?? []) {
      map.set(alias.toLowerCase(), plugin.id);
    }
  }
  return map;
})();

export function listProviderPlugins(): ProviderPlugin[] {
  return [...PROVIDERS].sort((a, b) => {
    const indexA = CHAT_PROVIDER_ORDER.indexOf(a.id as ChatProviderId);
    const indexB = CHAT_PROVIDER_ORDER.indexOf(b.id as ChatProviderId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

export function getProviderPlugin(id: ProviderId): ProviderPlugin | undefined {
  return PROVIDERS.find((plugin) => plugin.id === id);
}

export function normalizeProviderId(raw?: string | null): ProviderId | null {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  const normalized = PROVIDER_ALIASES.get(trimmed) ?? trimmed;
  const chat = normalizeChatProviderId(normalized);
  if (chat) return chat;
  return normalized === "msteams" ? "msteams" : null;
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
