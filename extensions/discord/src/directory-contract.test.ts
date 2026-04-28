import type { BaseProbeResult, BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
import type { DiscordProbe } from "./probe.js";
import type { DiscordTokenResolution } from "./token.js";

describe("Discord directory contract", () => {
  it("keeps public probe and token resolution aligned with base contracts", () => {
    expectTypeOf<DiscordProbe>().toMatchTypeOf<BaseProbeResult>();
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
      listDiscordDirectoryPeersFromConfig,
      cfg,
      ["user:111", "user:12345", "user:222", "user:333", "user:444"],
      { sorted: true },
    );
    await expectDirectoryIds(
      listDiscordDirectoryGroupsFromConfig,
      cfg,
      ["channel:555", "channel:666", "channel:777"],
      { sorted: true },
    );
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

    await expectDirectoryIds(listDiscordDirectoryPeersFromConfig, cfg, ["user:111"]);
    await expectDirectoryIds(listDiscordDirectoryGroupsFromConfig, cfg, ["channel:555"]);
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

    const groups = await listDiscordDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "666",
      limit: 5,
    });
    expect(groups.map((entry) => entry.id)).toEqual(["channel:666"]);
  });
});
