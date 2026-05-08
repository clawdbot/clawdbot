import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";

type TestChannelGroupContext = {
  cfg: OpenClawConfig;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
};

function normalizeTestSlug(raw?: string | null): string {
  return raw?.trim().replace(/^#/, "").toLowerCase() ?? "";
}

function resolveDiscordRequireMentionForTest(params: TestChannelGroupContext): boolean {
  const discordCfg = params.cfg.channels?.discord as
    | {
        guilds?: Record<
          string,
          {
            requireMention?: boolean;
            slug?: string;
            channels?: Record<string, { requireMention?: boolean }>;
          }
        >;
      }
    | undefined;
  const guilds = discordCfg?.guilds;
  if (!guilds) {
    return true;
  }
  const space = params.groupSpace?.trim() ?? "";
  const spaceSlug = normalizeTestSlug(space);
  const guild =
    (space ? guilds[space] : undefined) ??
    (spaceSlug ? guilds[spaceSlug] : undefined) ??
    Object.values(guilds).find((entry) => normalizeTestSlug(entry?.slug) === spaceSlug) ??
    guilds["*"];
  const channelSlug = normalizeTestSlug(params.groupChannel);
  const channel =
    (params.groupId ? guild?.channels?.[params.groupId] : undefined) ??
    (channelSlug ? guild?.channels?.[channelSlug] : undefined) ??
    (channelSlug ? guild?.channels?.[`#${channelSlug}`] : undefined);
  return channel?.requireMention ?? guild?.requireMention ?? true;
}

function resolveSlackRequireMentionForTest(params: TestChannelGroupContext): boolean {
  const slackCfg = params.cfg.channels?.slack as
    | {
        defaultAccount?: string;
        channels?: Record<string, { requireMention?: boolean }>;
        accounts?: Record<string, { channels?: Record<string, { requireMention?: boolean }> }>;
      }
    | undefined;
  if (!slackCfg) {
    return true;
  }
  const accountId = params.accountId ?? slackCfg.defaultAccount;
  const channels =
    (accountId ? slackCfg.accounts?.[accountId]?.channels : undefined) ?? slackCfg.channels;
  if (!channels) {
    return true;
  }
  const channelName = params.groupChannel?.trim().replace(/^#/, "");
  const channelSlug = normalizeTestSlug(channelName);
  const candidates = [
    params.groupId?.trim(),
    channelName ? `#${channelName}` : undefined,
    channelName,
    channelSlug,
    "*",
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const entry = channels[candidate];
    if (typeof entry?.requireMention === "boolean") {
      return entry.requireMention;
    }
  }
  return true;
}

export function installGroupRequireMentionTestPlugins() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord" }),
          groups: { resolveRequireMention: resolveDiscordRequireMentionForTest },
        },
        source: "test",
      },
      {
        pluginId: "slack",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack" }),
          groups: { resolveRequireMention: resolveSlackRequireMentionForTest },
        },
        source: "test",
      },
      {
        pluginId: "line",
        plugin: createChannelTestPluginBase({ id: "line" }),
        source: "test",
      },
      {
        pluginId: "imessage",
        plugin: createChannelTestPluginBase({ id: "imessage" }),
        source: "test",
      },
    ]),
  );
}
