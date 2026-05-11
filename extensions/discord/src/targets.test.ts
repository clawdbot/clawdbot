import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDiscordDirectoryCacheForTest,
  resolveDiscordDirectoryUserId,
} from "./directory-cache.js";
import * as directoryLive from "./directory-live.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import { normalizeDiscordMessagingTarget } from "./normalize.js";
import { parseDiscordTarget, resolveDiscordChannelId, resolveDiscordTarget } from "./targets.js";

function expectTargetFields(
  target: unknown,
  expected: { kind: string; id: string; normalized?: string },
): void {
  expect(target).toBeDefined();
  expect(typeof target).toBe("object");
  expect(target).not.toBeNull();
  const actual = target as Record<string, unknown>;
  expect(actual.kind).toBe(expected.kind);
  expect(actual.id).toBe(expected.id);
  if (expected.normalized !== undefined) {
    expect(actual.normalized).toBe(expected.normalized);
  }
}

describe("parseDiscordTarget", () => {
  it("parses user mention and prefixes", () => {
    const cases = [
      { input: "<@123>", id: "123", normalized: "user:123" },
      { input: "<@!456>", id: "456", normalized: "user:456" },
      { input: "user:789", id: "789", normalized: "user:789" },
      { input: "discord:987", id: "987", normalized: "user:987" },
      { input: "discord:user:987", id: "987", normalized: "user:987" },
    ] as const;
    for (const testCase of cases) {
      expectTargetFields(parseDiscordTarget(testCase.input), {
        kind: "user",
        id: testCase.id,
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { input: "channel:555", id: "555", normalized: "channel:555" },
      { input: "discord:channel:555", id: "555", normalized: "channel:555" },
      { input: "general", id: "general", normalized: "channel:general" },
    ] as const;
    for (const testCase of cases) {
      expectTargetFields(parseDiscordTarget(testCase.input), {
        kind: "channel",
        id: testCase.id,
        normalized: testCase.normalized,
      });
    }
  });

  it("accepts numeric ids when a default kind is provided", () => {
    expectTargetFields(parseDiscordTarget("123", { defaultKind: "channel" }), {
      kind: "channel",
      id: "123",
      normalized: "channel:123",
    });
  });

  it("rejects invalid parse targets", () => {
    const cases = [
      { input: "123", expectedMessage: /Ambiguous Discord recipient/ },
      { input: "@bob", expectedMessage: /Discord DMs require a user id/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseDiscordTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });

  it("guides ambiguous numeric recipients with all supported explicit formats", () => {
    expect(() => parseDiscordTarget("123456789")).toThrow(
      'Ambiguous Discord recipient "123456789". For DMs use "user:123456789" or "<@123456789>"; for channels use "channel:123456789".',
    );
  });
});

describe("resolveDiscordChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveDiscordChannelId("channel:123")).toBe("123");
    expect(resolveDiscordChannelId("123")).toBe("123");
  });

  it("rejects user targets", () => {
    expect(() => resolveDiscordChannelId("user:123")).toThrow(/channel id is required/i);
  });
});

describe("resolveDiscordTarget", () => {
  const cfg = { channels: { discord: {} } } as OpenClawConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetDiscordDirectoryCacheForTest();
  });

  it("returns a resolved user for usernames", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    expectTargetFields(await resolveDiscordTarget("jane", { cfg, accountId: "default" }), {
      kind: "user",
      id: "999",
      normalized: "user:999",
    });
  });

  it("falls back to parsing when lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([]);
    expectTargetFields(await resolveDiscordTarget("general", { cfg, accountId: "default" }), {
      kind: "channel",
      id: "general",
    });
  });

  it("does not call directory lookup for explicit user ids", async () => {
    const listPeers = vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive");
    expectTargetFields(await resolveDiscordTarget("user:123", { cfg, accountId: "default" }), {
      kind: "user",
      id: "123",
    });
    expect(listPeers).not.toHaveBeenCalled();
  });

  it("treats bare numeric ids in allowFrom as users even when channels are the default", async () => {
    const listPeers = vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive");
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              allowFrom: ["123"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expectTargetFields(
      await resolveDiscordTarget("123", { cfg, accountId: "default" }, { defaultKind: "channel" }),
      { kind: "user", id: "123", normalized: "user:123" },
    );
    expect(listPeers).not.toHaveBeenCalled();
  });

  it("uses legacy dm.allowFrom when disambiguating bare numeric ids", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              dm: { allowFrom: ["456"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expectTargetFields(
      await resolveDiscordTarget("456", { cfg, accountId: "default" }, { defaultKind: "channel" }),
      { kind: "user", id: "456", normalized: "user:456" },
    );
  });

  it("prefers top-level allowFrom over legacy dm.allowFrom for bare numeric ids", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              allowFrom: ["123"],
              dm: { allowFrom: ["456"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expectTargetFields(
      await resolveDiscordTarget("456", { cfg, accountId: "default" }, { defaultKind: "channel" }),
      { kind: "channel", id: "456", normalized: "channel:456" },
    );
  });

  it("uses account legacy dm.allowFrom before inherited root allowFrom for bare numeric ids", async () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: ["123"],
          accounts: {
            work: {
              dm: { allowFrom: ["456"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expectTargetFields(
      await resolveDiscordTarget("456", { cfg, accountId: "work" }, { defaultKind: "channel" }),
      { kind: "user", id: "456", normalized: "user:456" },
    );
    expectTargetFields(
      await resolveDiscordTarget("123", { cfg, accountId: "work" }, { defaultKind: "channel" }),
      { kind: "channel", id: "123", normalized: "channel:123" },
    );
  });

  it("caches username lookups under the configured default account when accountId is omitted", async () => {
    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: {
            work: {
              token: "discord-work",
            },
          },
        },
      },
    } as OpenClawConfig;

    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    expectTargetFields(await resolveDiscordTarget("jane", { cfg }), {
      kind: "user",
      id: "999",
      normalized: "user:999",
    });
    expect(resolveDiscordDirectoryUserId({ accountId: "work", handle: "jane" })).toBe("999");
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "jane" })).toBeUndefined();
  });
});

describe("normalizeDiscordMessagingTarget", () => {
  it("defaults raw numeric ids to channels", () => {
    expect(normalizeDiscordMessagingTarget("123")).toBe("channel:123");
  });
});

describe("discord group policy", () => {
  it("prefers channel policy, then guild policy, with sender-specific overrides", () => {
    const discordCfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              toolsBySender: {
                "id:user:guild-admin": { allow: ["sessions.list"] },
              },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                  toolsBySender: {
                    "id:user:channel-admin": { deny: ["exec"] },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    expect(
      resolveDiscordGroupRequireMention({ cfg: discordCfg, groupSpace: "guild1", groupId: "123" }),
    ).toBe(true);
    expect(
      resolveDiscordGroupRequireMention({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
      }),
    ).toBe(false);
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "123",
        senderId: "user:channel-admin",
      }),
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "123",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.channel"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
        senderId: "user:guild-admin",
      }),
    ).toEqual({ allow: ["sessions.list"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.guild"] });
  });

  it("honors account-scoped guild and channel overrides", () => {
    const discordCfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: true,
              tools: { allow: ["message.root"] },
            },
          },
          accounts: {
            work: {
              token: "discord-work",
              guilds: {
                guild1: {
                  requireMention: false,
                  tools: { allow: ["message.account"] },
                  channels: {
                    "123": {
                      requireMention: true,
                      tools: { allow: ["message.account-channel"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    expect(
      resolveDiscordGroupRequireMention({
        cfg: discordCfg,
        accountId: "work",
        groupSpace: "guild1",
        groupId: "missing",
      }),
    ).toBe(false);
    expect(
      resolveDiscordGroupRequireMention({
        cfg: discordCfg,
        accountId: "work",
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toBe(true);
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        accountId: "work",
        groupSpace: "guild1",
        groupId: "missing",
      }),
    ).toEqual({ allow: ["message.account"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        accountId: "work",
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toEqual({ allow: ["message.account-channel"] });
  });
});
