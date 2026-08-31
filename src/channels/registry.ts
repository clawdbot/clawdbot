// Public channel registry facade for channel ids, metadata, and setup copy.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatChannelId } from "./ids.js";
import type { ChannelId } from "./plugins/channel-id.types.js";
import type { ChannelMeta } from "./plugins/types.core.js";
import {
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

/**
 * Returns the plugin id that owns a registered channel, or null when the channel
 * is not registered or its registration carries no distinct plugin id.
 *
 * A channel id is not interchangeable with its plugin id: the loader accepts a
 * channel whose id differs from the plugin id whenever the manifest declares it
 * (`channelPluginIdBelongsToManifest`), which is how an installed plugin such as
 * `@tencent-weixin/openclaw-weixin` serves channel `openclaw-weixin`. Durable
 * per-plugin state is keyed by the plugin id the runtime opened it with, so a
 * caller reaching into that state must resolve the owner rather than reuse the
 * channel id.
 */
export function getRegisteredChannelOwnerPluginId(id: string): string | null {
  return normalizeOptionalString(findRegisteredChannelPluginEntryById(id)?.pluginId) ?? null;
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
