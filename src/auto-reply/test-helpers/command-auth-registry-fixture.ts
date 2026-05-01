import { afterEach, beforeEach } from "vitest";
import { normalizeE164 } from "../../plugin-sdk/account-resolution.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  lowercasePreservingWhitespace,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

function formatDiscordAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom
    .map((entry) => normalizeOptionalString(String(entry)) ?? "")
    .filter(Boolean)
    .map((entry) => entry.replace(/^(discord|user|pk):/i, "").replace(/^<@!?(\d+)>$/, "$1"))
    .map((entry) => lowercasePreservingWhitespace(entry));
}

function normalizePhoneAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom
    .map((entry) => normalizeOptionalString(String(entry)) ?? "")
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => {
      if (entry === "*") {
        return entry;
      }
      const stripped = entry.replace(/^whatsapp:/i, "").trim();
      if (/@g\.us$/i.test(stripped)) {
        return stripped;
      }
      if (/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i.test(stripped)) {
        const match = stripped.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i);
        return match ? normalizeE164(match[1]) : null;
      }
      if (/^(\d+)@lid$/i.test(stripped)) {
        const match = stripped.match(/^(\d+)@lid$/i);
        return match ? normalizeE164(match[1]) : null;
      }
      if (stripped.includes("@")) {
        return null;
      }
      return normalizeE164(stripped);
    })
    .filter((entry): entry is string => Boolean(entry));
}

function resolveChannelAllowFrom(
  cfg: Record<string, unknown>,
  channelId: string,
): Array<string | number> | undefined {
  const channels =
    cfg.channels && typeof cfg.channels === "object"
      ? (cfg.channels as Record<string, unknown>)
      : undefined;
  const channel =
    channels?.[channelId] && typeof channels[channelId] === "object"
      ? (channels[channelId] as Record<string, unknown>)
      : undefined;
  const allowFrom = channel?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : undefined;
}

const createCommandAuthRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: {
        ...createOutboundTestPlugin({ id: "discord", outbound: { deliveryMode: "direct" } }),
        config: {
          listAccountIds: () => [],
          resolveAllowFrom: ({ cfg }: { cfg: Record<string, unknown> }) =>
            resolveChannelAllowFrom(cfg, "discord"),
          formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
            formatDiscordAllowFromEntries(allowFrom),
        },
      },
      source: "test",
    },
    {
      pluginId: "whatsapp",
      plugin: {
        ...createOutboundTestPlugin({ id: "whatsapp", outbound: { deliveryMode: "direct" } }),
        config: {
          listAccountIds: () => [],
          resolveAllowFrom: ({ cfg }: { cfg: Record<string, unknown> }) =>
            resolveChannelAllowFrom(cfg, "whatsapp"),
          formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
            normalizePhoneAllowFromEntries(allowFrom),
        },
      },
      source: "test",
    },
  ]);

export function installDiscordRegistryHooks() {
  beforeEach(() => {
    setActivePluginRegistry(createCommandAuthRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createCommandAuthRegistry());
  });
}
