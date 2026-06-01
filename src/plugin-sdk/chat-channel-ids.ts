/**
 * Canonical bundled chat-channel id list.
 *
 * Mirrors the channel catalog ids that can be passed to the inbound-envelope
 * formatter (src/auto-reply/envelope.ts -> formatInboundEnvelope ->
 * formatAgentEnvelope) for its leading `[<channel> ...]` header. Plugins that
 * need to recognize an envelope-prefixed message (for example a memory plugin
 * filtering envelope sludge out of long-term capture) should not hardcode their
 * own channel-id table that can drift from the catalog.
 *
 * The list is derived from the same bundled/official channel catalog reader as
 * runtime channel metadata so catalog-only channels stay covered even when they
 * do not have a generated config metadata entry.
 */
import { listBundledChannelCatalogEntries } from "../channels/bundled-channel-catalog-read.js";

const BUNDLED_CHAT_CHANNEL_ENTRIES = listBundledChannelCatalogEntries();

function pushUniquePrefix(target: string[], seen: Set<string>, raw: string | undefined): void {
  const value = raw?.trim();
  if (!value) {
    return;
  }
  const key = value.toLocaleLowerCase("en-US");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  target.push(value);
}

export const BUNDLED_CHAT_CHANNEL_IDS = Object.freeze(
  BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id),
);

export const BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES = Object.freeze(
  (() => {
    const seen = new Set<string>();
    const prefixes: string[] = [];
    for (const entry of BUNDLED_CHAT_CHANNEL_ENTRIES) {
      pushUniquePrefix(prefixes, seen, entry.id);
      pushUniquePrefix(prefixes, seen, entry.channel.label);
      for (const alias of entry.aliases) {
        pushUniquePrefix(prefixes, seen, alias);
      }
    }
    return prefixes;
  })(),
);
export type { ChatChannelId } from "../channels/ids.js";
