import { getActivePluginChannelRegistryFromState } from "../plugins/runtime-channel-state.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  CHANNEL_IDS,
  CHAT_CHANNEL_ALIASES,
  CHAT_CHANNEL_ORDER,
  listChatChannelAliases,
  normalizeChatChannelId,
  type ChatChannelId,
} from "./ids.js";
import type { ChannelId } from "./plugins/channel-id.types.js";
import type { ChannelMeta } from "./plugins/types.core.js";
export { getChatChannelMeta, listChatChannels } from "./chat-meta.js";
export { CHANNEL_IDS, CHAT_CHANNEL_ORDER } from "./ids.js";
export type { ChatChannelId } from "./ids.js";

type RegisteredChannelPluginEntry = {
  plugin: {
    id?: string | null;
    meta?: Pick<ChannelMeta, "aliases" | "markdownCapable"> | null;
  };
};

function listRegisteredChannelPluginEntries(): RegisteredChannelPluginEntry[] {
  const channelRegistry = getActivePluginChannelRegistryFromState();
  if (channelRegistry && channelRegistry.channels && channelRegistry.channels.length > 0) {
    return channelRegistry.channels;
  }
  return [];
}

function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): RegisteredChannelPluginEntry | undefined {
  return listRegisteredChannelPluginEntries().find((entry) => {
    const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
    if (id && id === normalizedKey) {
      return true;
    }
    return (entry.plugin.meta?.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalizedKey,
    );
  });
}

function findRegisteredChannelPluginEntryById(
  id: string,
): RegisteredChannelPluginEntry | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return listRegisteredChannelPluginEntries().find(
    (entry) => normalizeOptionalLowercaseString(entry.plugin.id) === normalizedId,
  );
}
export { CHAT_CHANNEL_ALIASES, listChatChannelAliases, normalizeChatChannelId };

// Channel docking: prefer this helper in shared code. Importing from
// `src/channels/plugins/*` can eagerly load channel implementations.
export function normalizeChannelId(raw?: string | null): ChatChannelId | null {
  return normalizeChatChannelId(raw);
}

// Normalizes registered channel plugins (bundled or external).
//
// Keep this light: we do not import channel plugins here (those are "heavy" and can pull in
// monitors, web login, etc). The plugin registry must be initialized first.
export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return null;
  }
  return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}

export function listRegisteredChannelPluginIds(): ChannelId[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => {
    const id = normalizeOptionalString(entry.plugin.id);
    return id ? [id as ChannelId] : [];
  });
}

export function listRegisteredChannelPluginAliases(): string[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => entry.plugin.meta?.aliases ?? []);
}

export function getRegisteredChannelPluginMeta(
  id: string,
): Pick<ChannelMeta, "aliases" | "markdownCapable"> | null {
  return findRegisteredChannelPluginEntryById(id)?.plugin.meta ?? null;
}

export function formatChannelPrimerLine(meta: ChannelMeta): string {
  return `${meta.label}: ${meta.blurb}`;
}

export function formatChannelSelectionLine(
  meta: ChannelMeta,
  docsLink: (path: string, label?: string) => string,
): string {
  const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
  const docsLabel = meta.docsLabel ?? meta.id;
  const docs = meta.selectionDocsOmitLabel
    ? docsLink(meta.docsPath)
    : docsLink(meta.docsPath, docsLabel);
  const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
  return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}
