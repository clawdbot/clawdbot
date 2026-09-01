// Public channel registry facade for channel ids, metadata, and setup copy.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatChannelId } from "./ids.js";
import type { ChannelId } from "./plugins/channel-id.types.js";
import type { ChannelMeta } from "./plugins/types.core.js";
import {
  findRegisteredChannelPluginEntry,
  findRegisteredChannelPluginEntryById,
  listRegisteredChannelPluginEntries,
} from "./registry-lookup.js";
export { findChatChannelMeta } from "./chat-meta.js";
export { CHAT_CHANNEL_ORDER } from "./ids.js";
export type { ChatChannelId } from "./ids.js";
export { normalizeAnyChannelId } from "./registry-normalize.js";
export { normalizeChatChannelId };

/**
 * Lists registered channel plugin ids without importing their runtime implementations.
 */
export function listRegisteredChannelPluginIds(): ChannelId[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => {
    const id = normalizeOptionalString(entry.plugin.id);
    return id ? [id as ChannelId] : [];
  });
}

/**
 * Returns lightweight channel metadata used by message formatting and capability checks.
 */
export function getRegisteredChannelPluginMeta(
  id: string,
): Pick<ChannelMeta, "aliases" | "markdownCapable"> | null {
  return findRegisteredChannelPluginEntryById(id)?.plugin.meta ?? null;
}

/** The plugin a registered channel belongs to, and how many channels it registers. */
export type RegisteredChannelOwner = {
  pluginId: string;
  /** Channels this plugin registers, so a caller can tell exclusive ownership from shared. */
  channelCount: number;
};

/**
 * Returns the plugin that owns a registered channel, or null when the channel is not
 * registered or its registration carries no distinct plugin id.
 *
 * A channel id is not interchangeable with its plugin id: the loader accepts a channel
 * whose id differs from the plugin id whenever the manifest declares it
 * (`channelPluginIdBelongsToManifest`), which is how an installed plugin such as
 * `@tencent-weixin/openclaw-weixin` serves channel `openclaw-weixin`. Durable
 * per-plugin state is keyed by the plugin id the runtime opened it with, so a caller
 * reaching into that state must resolve the owner rather than reuse the channel id.
 *
 * `channelCount` is that state's blast radius: one plugin serving several channels
 * holds them in one store, so a caller acting for a single channel is not acting alone.
 */
export function findRegisteredChannelOwner(id: string): RegisteredChannelOwner | null {
  const key = normalizeOptionalLowercaseString(id);
  if (!key) {
    return null;
  }
  // Resolve through the alias-aware lookup, because operators type what the docs call
  // the channel - `wechat` for `openclaw-weixin` - and an alias that fell through to the
  // literal string would address a store nothing owns.
  const pluginId = normalizeOptionalString(findRegisteredChannelPluginEntry(key)?.pluginId);
  if (!pluginId) {
    return null;
  }
  const channelCount = listRegisteredChannelPluginEntries().filter(
    (entry) => normalizeOptionalString(entry.pluginId) === pluginId,
  ).length;
  return { pluginId, channelCount };
}

/**
 * Formats a concise channel primer line for setup/status flows.
 */
export function formatChannelPrimerLine(meta: ChannelMeta): string {
  return `${meta.label}: ${meta.blurb}`;
}

/**
 * Formats a docs-aware channel selection line for interactive setup prompts.
 */
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
