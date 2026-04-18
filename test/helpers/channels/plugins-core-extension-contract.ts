import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelDirectoryEntry,
} from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { LineProbeResult } from "../../../src/plugin-sdk/line.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";

type DiscordDirectoryContractApiSurface = Pick<
  typeof import("@openclaw/discord/directory-contract-api.js"),
  "listDiscordDirectoryPeersFromConfig" | "listDiscordDirectoryGroupsFromConfig"
>;
type DiscordProbe = import("@openclaw/discord/api.js").DiscordProbe;
type DiscordTokenResolution = import("@openclaw/discord/api.js").DiscordTokenResolution;
type IMessageProbe = import("@openclaw/imessage/runtime-api.js").IMessageProbe;
type SignalProbe = import("@openclaw/signal/api.js").SignalProbe;
type SlackDirectoryContractApiSurface = Pick<
  typeof import("@openclaw/slack/directory-contract-api.js"),
  "listSlackDirectoryPeersFromConfig" | "listSlackDirectoryGroupsFromConfig"
>;
type SlackProbe = import("@openclaw/slack/api.js").SlackProbe;
type TelegramDirectoryContractApiSurface = Pick<
  typeof import("@openclaw/telegram/directory-contract-api.js"),
  "listTelegramDirectoryPeersFromConfig" | "listTelegramDirectoryGroupsFromConfig"
>;
type TelegramProbe = import("@openclaw/telegram/api.js").TelegramProbe;
type TelegramTokenResolution = import("@openclaw/telegram/api.js").TelegramTokenResolution;
type WhatsAppDirectoryContractApiSurface = Pick<
  typeof import("@openclaw/whatsapp/directory-contract-api.js"),
  "listWhatsAppDirectoryPeersFromConfig" | "listWhatsAppDirectoryGroupsFromConfig"
>;

let discordDirectoryContractApi: Promise<DiscordDirectoryContractApiSurface> | undefined;
let slackDirectoryContractApi: Promise<SlackDirectoryContractApiSurface> | undefined;
let telegramDirectoryContractApi: Promise<TelegramDirectoryContractApiSurface> | undefined;
let whatsappDirectoryContractApi: Promise<WhatsAppDirectoryContractApiSurface> | undefined;

async function importDirectoryContractApi<T extends object>(pluginId: string): Promise<T> {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId,
    artifactBasename: "directory-contract-api.js",
  });
  return (await import(moduleId)) as T;
}

function getDiscordDirectoryContractApi(): Promise<DiscordDirectoryContractApiSurface> {
  discordDirectoryContractApi ??=
    importDirectoryContractApi<DiscordDirectoryContractApiSurface>("discord");
  return discordDirectoryContractApi;
}

function getSlackDirectoryContractApi(): Promise<SlackDirectoryContractApiSurface> {
  slackDirectoryContractApi ??=
    importDirectoryContractApi<SlackDirectoryContractApiSurface>("slack");
  return slackDirectoryContractApi;
}

function getTelegramDirectoryContractApi(): Promise<TelegramDirectoryContractApiSurface> {
  telegramDirectoryContractApi ??=
    importDirectoryContractApi<TelegramDirectoryContractApiSurface>("telegram");
  return telegramDirectoryContractApi;
}

function getWhatsAppDirectoryContractApi(): Promise<WhatsAppDirectoryContractApiSurface> {
  whatsappDirectoryContractApi ??=
    importDirectoryContractApi<WhatsAppDirectoryContractApiSurface>("whatsapp");
  return whatsappDirectoryContractApi;
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
    it("DiscordProbe satisfies BaseProbeResult", () => {
      expectTypeOf<DiscordProbe>().toMatchTypeOf<BaseProbeResult>();
    });

    it("Discord token resolution satisfies BaseTokenResolution", () => {
      expectTypeOf<DiscordTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    });

    it("lists peers/groups from config (numeric ids only)", async () => {
      const { listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig } =
        await getDiscordDirectoryContractApi();
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
        listDiscordDirectoryPeersFromConfig,
        cfg,
        ["user:111", "user:12345", "user:222", "user:333", "user:444"],
        { sorted: true },
      );
      await expectDirectoryIds(
        listDiscordDirectoryGroupsFromConfig,
        cfg,
        ["channel:555", "channel:666", "channel:777"],
        {
          sorted: true,
        },
      );
    });

    it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
      const { listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig } =
        await getDiscordDirectoryContractApi();
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

      await expectDirectoryIds(listDiscordDirectoryPeersFromConfig, cfg, ["user:111"]);
      await expectDirectoryIds(listDiscordDirectoryGroupsFromConfig, cfg, ["channel:555"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const { listDiscordDirectoryGroupsFromConfig } = await getDiscordDirectoryContractApi();
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

      const groups = await listDiscordDirectoryGroupsFromConfig({
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
    it("SlackProbe satisfies BaseProbeResult", () => {
      expectTypeOf<SlackProbe>().toMatchTypeOf<BaseProbeResult>();
    });

    it("lists peers/groups from config", async () => {
      const { listSlackDirectoryGroupsFromConfig, listSlackDirectoryPeersFromConfig } =
        await getSlackDirectoryContractApi();
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
        listSlackDirectoryPeersFromConfig,
        cfg,
        ["user:u123", "user:u234", "user:u777", "user:u999"],
        { sorted: true },
      );
      await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
    });

    it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
      const { listSlackDirectoryGroupsFromConfig, listSlackDirectoryPeersFromConfig } =
        await getSlackDirectoryContractApi();
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

      await expectDirectoryIds(listSlackDirectoryPeersFromConfig, cfg, ["user:u123"]);
      await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const { listSlackDirectoryPeersFromConfig } = await getSlackDirectoryContractApi();
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

      const peers = await listSlackDirectoryPeersFromConfig({
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
    it("TelegramProbe satisfies BaseProbeResult", () => {
      expectTypeOf<TelegramProbe>().toMatchTypeOf<BaseProbeResult>();
    });

    it("Telegram token resolution satisfies BaseTokenResolution", () => {
      expectTypeOf<TelegramTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    });

    it("lists peers/groups from config", async () => {
      const { listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig } =
        await getTelegramDirectoryContractApi();
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

      await expectDirectoryIds(
        listTelegramDirectoryPeersFromConfig,
        cfg,
        ["123", "456", "@alice", "@bob"],
        {
          sorted: true,
        },
      );
      await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
    });

    it("keeps fallback semantics when accountId is omitted", async () => {
      const { listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig } =
        await getTelegramDirectoryContractApi();
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

        await expectDirectoryIds(listTelegramDirectoryPeersFromConfig, cfg, ["@alice"]);
        await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
      });
    });

    it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
      const { listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig } =
        await getTelegramDirectoryContractApi();
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

      await expectDirectoryIds(listTelegramDirectoryPeersFromConfig, cfg, ["@alice"]);
      await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const { listTelegramDirectoryGroupsFromConfig } = await getTelegramDirectoryContractApi();
      const cfg = {
        channels: {
          telegram: {
            botToken: "telegram-test",
            groups: { "-1001": {}, "-1002": {}, "-2001": {} },
          },
        },
      } as unknown as OpenClawConfig;

      const groups = await listTelegramDirectoryGroupsFromConfig({
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
    it("lists peers/groups from config", async () => {
      const { listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig } =
        await getWhatsAppDirectoryContractApi();
      const cfg = {
        channels: {
          whatsapp: {
            allowFrom: ["+15550000000", "*", "123@g.us"],
            groups: { "999@g.us": { requireMention: true }, "*": {} },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listWhatsAppDirectoryPeersFromConfig, cfg, ["+15550000000"]);
      await expectDirectoryIds(listWhatsAppDirectoryGroupsFromConfig, cfg, ["999@g.us"]);
    });

    it("applies query and limit filtering for config-backed directories", async () => {
      const { listWhatsAppDirectoryGroupsFromConfig } = await getWhatsAppDirectoryContractApi();
      const cfg = {
        channels: {
          whatsapp: {
            groups: { "111@g.us": {}, "222@g.us": {}, "333@s.whatsapp.net": {} },
          },
        },
      } as unknown as OpenClawConfig;

      const groups = await listWhatsAppDirectoryGroupsFromConfig({
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
