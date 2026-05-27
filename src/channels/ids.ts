import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";

export type ChatChannelId = string;

type BundledChatChannelEntry = {
  id: ChatChannelId;
  aliases: readonly string[];
  order: number;
};

function listBundledChatChannelEntries(): BundledChatChannelEntry[] {
  return GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false)
    .map((entry) => ({
      id: normalizeOptionalLowercaseString(entry.channelId) ?? entry.channelId,
      aliases: entry.aliases ?? [],
      order: entry.order ?? Number.MAX_SAFE_INTEGER,
    }))
    .toSorted(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id, "en", { sensitivity: "base" }),
    );
}

const BUNDLED_CHAT_CHANNEL_ENTRIES = Object.freeze(listBundledChatChannelEntries());
const CHAT_CHANNEL_ID_SET = new Set(BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id));
let runtimeBundledChatChannelEntries: BundledChatChannelEntry[] | null = null;

export const CHAT_CHANNEL_ORDER = Object.freeze(
  BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id),
);

export const CHANNEL_IDS = CHAT_CHANNEL_ORDER;

export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = Object.freeze(
  Object.fromEntries(
    BUNDLED_CHAT_CHANNEL_ENTRIES.flatMap((entry) =>
      entry.aliases.map((alias) => [alias, entry.id] as const),
    ),
  ),
) as Record<string, ChatChannelId>;

export function listChatChannelAliases(): string[] {
  return Object.keys(CHAT_CHANNEL_ALIASES);
}

function listRuntimeBundledChatChannelEntries(): BundledChatChannelEntry[] {
  runtimeBundledChatChannelEntries ??= listBundledChannelCatalogEntries().map((entry) => ({
    id: entry.id,
    aliases: entry.aliases,
    order: entry.order,
  }));
  return runtimeBundledChatChannelEntries;
}

function normalizeRuntimeBundledChatChannelId(normalized: string): ChatChannelId | null {
  for (const entry of listRuntimeBundledChatChannelEntries()) {
    if (entry.id === normalized || entry.aliases.includes(normalized)) {
      return entry.id;
    }
  }
  return null;
}

export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ID_SET.has(resolved)
    ? resolved
    : normalizeRuntimeBundledChatChannelId(normalized);
}
