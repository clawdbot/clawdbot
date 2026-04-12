import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelDirectoryEntry,
} from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { LineProbeResult } from "../../../src/plugin-sdk/line.js";
import { loadBundledPluginApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";

type DiscordApiSurface = typeof import("@openclaw/discord/api.js");
type DiscordProbe = import("@openclaw/discord/api.js").DiscordProbe;
type DiscordTokenResolution = import("@openclaw/discord/api.js").DiscordTokenResolution;
type IMessageProbe = import("@openclaw/imessage/runtime-api.js").IMessageProbe;
type SignalProbe = import("@openclaw/signal/api.js").SignalProbe;
type SlackApiSurface = typeof import("@openclaw/slack/api.js");
type SlackProbe = import("@openclaw/slack/api.js").SlackProbe;
type TelegramApiSurface = typeof import("@openclaw/telegram/api.js");
type TelegramProbe = import("@openclaw/telegram/api.js").TelegramProbe;
type TelegramTokenResolution = import("@openclaw/telegram/api.js").TelegramTokenResolution;
type WhatsAppApiSurface = typeof import("@openclaw/whatsapp/api.js");

let discordApi: DiscordApiSurface | undefined;
let slackApi: SlackApiSurface | undefined;
let telegramApi: TelegramApiSurface | undefined;
let whatsappApi: WhatsAppApiSurface | undefined;

function getDiscordApi(): DiscordApiSurface {
  discordApi ??= loadBundledPluginApiSync<DiscordApiSurface>("discord");
  return discordApi;
}

function getSlackApi(): SlackApiSurface {
  slackApi ??= loadBundledPluginApiSync<SlackApiSurface>("slack");
  return slackApi;
}

function getTelegramApi(): TelegramApiSurface {
  telegramApi ??= loadBundledPluginApiSync<TelegramApiSurface>("telegram");
  return telegramApi;
}

function getWhatsAppApi(): WhatsAppApiSurface {
  whatsappApi ??= loadBundledPluginApiSync<WhatsAppApiSurface>("whatsapp");
  return whatsappApi;
}

type DirectoryListFn = (params: {
  cfg: OpenClawConfig;
  accountId?: string;
  query?: string | null;
  limit?: number | null;
}) => Promise<ChannelDirectoryEntry[]>;

async function listDirectoryEntriesWithDefaults(listFn: DirectoryListFn, cfg: OpenClawConfig) {
  return await listFn({
    cfg,
    accountId: "default",
    query: null,
    limit: null,
  });
}

async function expectDirectoryIds(
  listFn: DirectoryListFn,
  cfg: OpenClawConfig,
  expected: string[],
  options?: { sorted?: boolean },
) {
  const entries = await listDirectoryEntriesWithDefaults(listFn, cfg);
  const ids = entries.map((entry) => entry.id);
  expect(options?.sorted ? ids.toSorted() : ids).toEqual(expected);
}

export function describeDiscordPluginsCoreExtensionContract() {
  describe("discord plugins-core extension contract", () => {
    const listPeers = () => getDiscordApi().listDiscordDirectoryPeersFromConfig;
    const listGroups = () => getDiscordApi().listDiscordDirectoryGroupsFromConfig;

    it("DiscordProbe satisfies BaseProbeResult", () => {
      expectTypeOf<DiscordProbe>().toMatchTypeOf<BaseProbeResult>();
    });

    it("Discord token resolution satisfies BaseTokenResolution", () => {
      expectTypeOf<DiscordTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    });

    it("lists peers/groups from config (numeric ids only)", async () => {
      const cfg = {
        channels: {
          discord: {
            token: "discord-test",
            dm: { allowFrom: ["<@111>", "<@!333>", "nope"] },
            dms: { "222": {} },
            guilds: {
              "123": {
                users: ["<@12345>", " discord:444 ", "not-an-id"],
                channels: {
                  "555": {},
                  "<#777>": {},
                  "channel:666": {},
                  general: {},
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(
        listPeers(),
        cfg,
        ["user:111", "user:12345", "user:222", "user:333", "user:444"],
        { sorted: true },
      );
      await expectDirectoryIds(listGroups(), cfg, ["channel:555", "channel:666", "channel:777"], {
        sorted: true,
      });
    });

    it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
      const envSecret = {
        source: "env",
        provider: "default",
        id: "MISSING_TEST_SECRET",
      } as const;
      const cfg = {
        channels: {
          discord: {
            token: envSecret,
            dm: { allowFrom: ["<@111>"] },
            guilds: {
              "123": {
                channels: {
                  "555": {},
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listPeers(), cfg, ["user:111"]);
      await expectDirectoryIds(listGroups(), cfg, ["channel:555"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const cfg = {
        channels: {
          discord: {
            token: "discord-test",
            guilds: {
              "123": {
                channels: {
                  "555": {},
                  "666": {},
                  "777": {},
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      const groups = await listGroups()({
        cfg,
        accountId: "default",
        query: "666",
        limit: 5,
      });
      expect(groups.map((entry) => entry.id)).toEqual(["channel:666"]);
    });
  });
}

export function describeSlackPluginsCoreExtensionContract() {
  describe("slack plugins-core extension contract", () => {
    const listPeers = () => getSlackApi().listSlackDirectoryPeersFromConfig;
    const listGroups = () => getSlackApi().listSlackDirectoryGroupsFromConfig;

    it("SlackProbe satisfies BaseProbeResult", () => {
      expectTypeOf<SlackProbe>().toMatchTypeOf<BaseProbeResult>();
    });

    it("lists peers/groups from config", async () => {
      const cfg = {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            dm: { allowFrom: ["U123", "user:U999"] },
            dms: { U234: {} },
            channels: { C111: { users: ["U777"] } },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(
        listPeers(),
        cfg,
        ["user:u123", "user:u234", "user:u777", "user:u999"],
        { sorted: true },
      );
      await expectDirectoryIds(listGroups(), cfg, ["channel:c111"]);
    });

    it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
      const envSecret = {
        source: "env",
        provider: "default",
        id: "MISSING_TEST_SECRET",
      } as const;
      const cfg = {
        channels: {
          slack: {
            botToken: envSecret,
            appToken: envSecret,
            dm: { allowFrom: ["U123"] },
            channels: { C111: {} },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listPeers(), cfg, ["user:u123"]);
      await expectDirectoryIds(listGroups(), cfg, ["channel:c111"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const cfg = {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            dm: { allowFrom: ["U100", "U200"] },
            dms: { U300: {} },
          },
        },
      } as unknown as OpenClawConfig;

      const peers = await listPeers()({
        cfg,
        accountId: "default",
        query: "user:u",
        limit: 2,
      });
      expect(peers).toHaveLength(2);
      expect(peers.every((entry) => entry.id.startsWith("user:u"))).toBe(true);
    });
  });
}

export function describeTelegramPluginsCoreExtensionContract() {
  describe("telegram plugins-core extension contract", () => {
    const listPeers = () => getTelegramApi().listTelegramDirectoryPeersFromConfig;
    const listGroups = () => getTelegramApi().listTelegramDirectoryGroupsFromConfig;

    it("TelegramProbe satisfies BaseProbeResult", () => {
      expectTypeOf<TelegramProbe>().toMatchTypeOf<BaseProbeResult>();
    });

    it("Telegram token resolution satisfies BaseTokenResolution", () => {
      expectTypeOf<TelegramTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    });

    it("lists peers/groups from config", async () => {
      const cfg = {
        channels: {
          telegram: {
            botToken: "telegram-test",
            allowFrom: ["123", "alice", "tg:@bob"],
            dms: { "456": {} },
            groups: { "-1001": {}, "*": {} },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listPeers(), cfg, ["123", "456", "@alice", "@bob"], {
        sorted: true,
      });
      await expectDirectoryIds(listGroups(), cfg, ["-1001"]);
    });

    it("keeps fallback semantics when accountId is omitted", async () => {
      await withEnvAsync({ TELEGRAM_BOT_TOKEN: "tok-env" }, async () => {
        const cfg = {
          channels: {
            telegram: {
              allowFrom: ["alice"],
              groups: { "-1001": {} },
              accounts: {
                work: {
                  botToken: "tok-work",
                  allowFrom: ["bob"],
                  groups: { "-2002": {} },
                },
              },
            },
          },
        } as unknown as OpenClawConfig;

        await expectDirectoryIds(listPeers(), cfg, ["@alice"]);
        await expectDirectoryIds(listGroups(), cfg, ["-1001"]);
      });
    });

    it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
      const envSecret = {
        source: "env",
        provider: "default",
        id: "MISSING_TEST_SECRET",
      } as const;
      const cfg = {
        channels: {
          telegram: {
            botToken: envSecret,
            allowFrom: ["alice"],
            groups: { "-1001": {} },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listPeers(), cfg, ["@alice"]);
      await expectDirectoryIds(listGroups(), cfg, ["-1001"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const cfg = {
        channels: {
          telegram: {
            botToken: "telegram-test",
            groups: { "-1001": {}, "-1002": {}, "-2001": {} },
          },
        },
      } as unknown as OpenClawConfig;

      const groups = await listGroups()({
        cfg,
        accountId: "default",
        query: "-100",
        limit: 1,
      });
      expect(groups.map((entry) => entry.id)).toEqual(["-1001"]);
    });
  });
}

export function describeWhatsAppPluginsCoreExtensionContract() {
  describe("whatsapp plugins-core extension contract", () => {
    const listPeers = () => getWhatsAppApi().listWhatsAppDirectoryPeersFromConfig;
    const listGroups = () => getWhatsAppApi().listWhatsAppDirectoryGroupsFromConfig;

    it("lists peers/groups from config", async () => {
      const cfg = {
        channels: {
          whatsapp: {
            allowFrom: ["+15550000000", "*", "123@g.us"],
            groups: { "999@g.us": { requireMention: true }, "*": {} },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listPeers(), cfg, ["+15550000000"]);
      await expectDirectoryIds(listGroups(), cfg, ["999@g.us"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const cfg = {
        channels: {
          whatsapp: {
            groups: { "111@g.us": {}, "222@g.us": {}, "333@s.whatsapp.net": {} },
          },
        },
      } as unknown as OpenClawConfig;

      const groups = await listGroups()({
        cfg,
        accountId: "default",
        query: "@g.us",
        limit: 1,
      });
      expect(groups.map((entry) => entry.id)).toEqual(["111@g.us"]);
    });
  });
}

export function describeSignalPluginsCoreExtensionContract() {
  describe("signal plugins-core extension contract", () => {
    it("SignalProbe satisfies BaseProbeResult", () => {
      expectTypeOf<SignalProbe>().toMatchTypeOf<BaseProbeResult>();
    });
  });
}

export function describeIMessagePluginsCoreExtensionContract() {
  describe("imessage plugins-core extension contract", () => {
    it("IMessageProbe satisfies BaseProbeResult", () => {
      expectTypeOf<IMessageProbe>().toMatchTypeOf<BaseProbeResult>();
    });
  });
}

export function describeLinePluginsCoreExtensionContract() {
  describe("line plugins-core extension contract", () => {
    it("LineProbeResult satisfies BaseProbeResult", () => {
      expectTypeOf<LineProbeResult>().toMatchTypeOf<BaseProbeResult>();
    });
  });
}
