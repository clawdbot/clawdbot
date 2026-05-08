import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-types";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as resolveChannelsModule from "../resolve-channels.js";
import * as resolveUsersModule from "../resolve-users.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";

describe("resolveDiscordAllowlistConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(resolveChannelsModule, "resolveDiscordChannelAllowlist").mockResolvedValue([]);
    vi.spyOn(resolveUsersModule, "resolveDiscordUserAllowlist").mockImplementation(
      async (params: { entries: string[] }) =>
        params.entries.map((entry) => {
          switch (entry) {
            case "Alice":
              return { input: entry, resolved: true, id: "111" };
            case "Bob":
              return { input: entry, resolved: true, id: "222" };
            case "Carol":
              return { input: entry, resolved: false };
            case "387":
              return { input: entry, resolved: true, id: "387", name: "Peter" };
            default:
              return { input: entry, resolved: true, id: entry };
          }
        }),
    );
  });

  it("canonicalizes resolved user names to ids in runtime config", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const result = await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: ["Alice", "111", "*"],
      guildEntries: {
        "*": {
          users: ["Bob", "999"],
          channels: {
            "*": {
              users: ["Carol", "888"],
            },
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
    });

    expect(result.allowFrom).toEqual(["111", "*"]);
    expect(result.guildEntries?.["*"]?.users).toEqual(["222", "999"]);
    expect(result.guildEntries?.["*"]?.channels?.["*"]?.users).toEqual(["Carol", "888"]);
    expect(resolveUsersModule.resolveDiscordUserAllowlist).toHaveBeenCalledTimes(2);
  });

  it("logs discord name metadata for resolved and unresolved allowlist entries", async () => {
    vi.spyOn(resolveChannelsModule, "resolveDiscordChannelAllowlist").mockResolvedValueOnce([
      {
        input: "145/c404",
        resolved: false,
        guildId: "145",
        guildName: "Ops",
        channelName: "missing-room",
      },
    ]);
    const runtime = createNonExitingRuntimeEnv();

    await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: ["387"],
      guildEntries: {
        "145": {
          channels: {
            c404: {},
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
    });

    const logs = (runtime.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([line]) => String(line))
      .join("\n");
    expect(logs).toContain(
      "discord channels unresolved: 145/c404 (guild:Ops; channel:missing-room)",
    );
    expect(logs).toContain("discord users resolved: 387→Peter (id:387)");
  });

  it("groups resolved discord channel aliases under one target line", async () => {
    vi.spyOn(resolveChannelsModule, "resolveDiscordChannelAllowlist").mockResolvedValueOnce([
      {
        input: "1456350064065904867/1464953333713473657",
        resolved: true,
        guildId: "1456350064065904867",
        guildName: "Friends of the Crustacean 🦞🤝",
        channelId: "1464953333713473657",
        channelName: "dev",
      },
      {
        input: "1456350064065904867/1456744319972282449",
        resolved: true,
        guildId: "1456350064065904867",
        guildName: "Friends of the Crustacean 🦞🤝",
        channelId: "1456744319972282449",
        channelName: "maintainers",
      },
      {
        input: "friends-of-the-crustacean/1464953333713473657",
        resolved: true,
        guildId: "1456350064065904867",
        guildName: "Friends of the Crustacean 🦞🤝",
        channelId: "1464953333713473657",
        channelName: "dev",
      },
    ]);

    const runtime = createNonExitingRuntimeEnv();

    await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: [],
      guildEntries: {
        "1456350064065904867": {
          channels: {
            "1464953333713473657": {},
            "1456744319972282449": {},
          },
        },
        "friends-of-the-crustacean": {
          channels: {
            "1464953333713473657": {},
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
      discordConfig: {} as DiscordAccountConfig,
    });

    const logs = (runtime.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([line]) => String(line))
      .join("\n");
    expect(logs.match(/1456350064065904867\/1464953333713473657/g)?.length).toBe(1);
    expect(logs).toContain("aliases:friends-of-the-crustacean/1464953333713473657");
    expect(logs).toContain(
      "1456350064065904867/1456744319972282449 (guild:Friends of the Crustacean 🦞🤝; channel:maintainers)",
    );
  });

  it("keeps user allowlist names unresolved unless name matching is enabled", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const result = await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: ["Alice", "111", "*"],
      guildEntries: {
        "*": {
          users: ["Bob", "999"],
          channels: {
            "*": {
              users: ["Carol", "888"],
            },
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
      discordConfig: {} as DiscordAccountConfig,
    });

    expect(result.allowFrom).toEqual(["Alice", "111", "*"]);
    expect(result.guildEntries?.["*"]?.users).toEqual(["Bob", "999"]);
    expect(result.guildEntries?.["*"]?.channels?.["*"]?.users).toEqual(["Carol", "888"]);
    expect(resolveUsersModule.resolveDiscordUserAllowlist).not.toHaveBeenCalled();
  });

  it("still resolves guild and channel ids when name matching is disabled", async () => {
    vi.spyOn(resolveChannelsModule, "resolveDiscordChannelAllowlist").mockResolvedValueOnce([
      {
        input: "ops/general",
        resolved: true,
        guildId: "145",
        guildName: "Ops",
        channelId: "246",
        channelName: "general",
      },
    ]);
    const runtime = createNonExitingRuntimeEnv();

    const result = await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: ["Alice"],
      guildEntries: {
        ops: {
          users: ["Bob"],
          channels: {
            general: {
              users: ["Carol"],
            },
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
      discordConfig: {} as DiscordAccountConfig,
    });

    expect(result.allowFrom).toEqual(["Alice"]);
    expect(result.guildEntries?.["145"]?.channels?.["246"]?.users).toEqual(["Carol"]);
    expect(result.guildEntries?.ops?.users).toEqual(["Bob"]);
    expect(resolveChannelsModule.resolveDiscordChannelAllowlist).toHaveBeenCalledTimes(1);
    expect(resolveUsersModule.resolveDiscordUserAllowlist).not.toHaveBeenCalled();
  });
});
