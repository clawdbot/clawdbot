import { describe, expect, it } from "vitest";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";
import {
  CHAT_CHANNEL_ALIASES,
  CHAT_CHANNEL_ORDER,
  normalizeChatChannelId,
  type ChatChannelId,
} from "./ids.js";

function collectChatChannelAliases(): Record<string, ChatChannelId> {
  const aliases = new Map<string, ChatChannelId>();

  for (const entry of listBundledChannelCatalogEntries()) {
    const rawId = entry.id.trim();
    if (!rawId || !CHAT_CHANNEL_ORDER.includes(rawId)) {
      continue;
    }
    const channelId = rawId;
    for (const alias of entry.aliases ?? []) {
      const normalizedAlias = alias.trim().toLowerCase();
      if (!normalizedAlias) {
        continue;
      }
      aliases.set(normalizedAlias, channelId);
    }
  }

  return Object.fromEntries(
    [...aliases.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, ChatChannelId>;
}

describe("channel ids", () => {
  it("normalizes built-in aliases + trims whitespace", () => {
    expect(normalizeChatChannelId(" imsg ")).toBe("imessage");
    expect(normalizeChatChannelId("gchat")).toBe("googlechat");
    expect(normalizeChatChannelId("google-chat")).toBe("googlechat");
    expect(normalizeChatChannelId("internet-relay-chat")).toBe("irc");
    expect(normalizeChatChannelId("telegram")).toBe("telegram");
    expect(normalizeChatChannelId("web")).toBeNull();
    expect(normalizeChatChannelId("nope")).toBeNull();
  });

  it("matches channel catalog alias metadata", () => {
    expect(CHAT_CHANNEL_ALIASES).toEqual(collectChatChannelAliases());
  });
});
