// Verifies group-policy normalization and runtime resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConcreteConfigPath } from "../shared/dot-path.js";
import { resolveMergedAccountConfig } from "./channel-account-config.js";
import { setConfigValueAtPath } from "./config-paths.js";
import type { OpenClawConfig } from "./config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveChannelGroups,
  resolveChannelGroupsConfigPath,
  resolveToolsBySender,
} from "./group-policy.js";

function firstWarningCall(warningSpy: ReturnType<typeof vi.spyOn>): [unknown, { code?: unknown }?] {
  const [call] = warningSpy.mock.calls;
  if (!call) {
    throw new Error("expected process.emitWarning call");
  }
  return call as [unknown, { code?: unknown }?];
}

describe("resolveChannelGroupPolicy", () => {
  it("fails closed when groupPolicy=allowlist and groups are missing", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("allows configured groups when groupPolicy=allowlist", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "123@g.us": { requireMention: true },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("blocks all groups when groupPolicy=disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "disabled",
          groups: {
            "*": { requireMention: false },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
    });

    expect(policy.allowed).toBe(false);
  });

  it("respects account-scoped groupPolicy overrides", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      accountId: "work",
      groupId: "123@g.us",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("allows groups when groupPolicy=allowlist with hasGroupAllowFrom but no groups", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
      hasGroupAllowFrom: true,
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("still fails closed when groupPolicy=allowlist without groups or groupAllowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "whatsapp",
      groupId: "123@g.us",
      hasGroupAllowFrom: false,
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("can default explicitly configured groups to no mention for channels that opt in", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {},
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveChannelGroupRequireMention({
        cfg,
        channel: "whatsapp",
        groupId: "123@g.us",
      }),
    ).toBe(true);
    expect(
      resolveChannelGroupRequireMention({
        cfg,
        channel: "whatsapp",
        groupId: "123@g.us",
        configuredGroupDefaultsToNoMention: true,
      }),
    ).toBe(false);
  });

  it("falls back to root channel groups when account.groups is an empty object (regression: #79427)", () => {
    const cfg = {
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123": { requireMention: false },
          },
          accounts: {
            default: { botToken: "123:default", groups: {} },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      groupId: "-100123",
      accountId: "default",
    });

    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(true);
  });

  it("uses populated account.groups instead of root when both are configured", () => {
    const cfg = {
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100root": { requireMention: false },
          },
          accounts: {
            default: {
              botToken: "123:default",
              groups: { "-100account": { requireMention: false } },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveChannelGroupPolicy({
        cfg,
        channel: "telegram",
        groupId: "-100account",
        accountId: "default",
      }).allowed,
    ).toBe(true);
    expect(
      resolveChannelGroupPolicy({
        cfg,
        channel: "telegram",
        groupId: "-100root",
        accountId: "default",
      }).allowed,
    ).toBe(false);
  });
});

describe("resolveChannelGroupsConfigPath", () => {
  it.each([
    { name: "inherited root", accountId: "work", accountKey: "Work", override: false },
    {
      name: "normalized account override",
      accountId: " WORK ",
      accountKey: "Work",
      override: true,
    },
    {
      name: "explicit default account",
      accountId: "default",
      accountKey: "default",
      override: true,
    },
  ])(
    "updates the $name map while retaining sibling policies",
    ({ accountId, accountKey, override }) => {
      const rootGroups = {
        "*": { requireMention: true, tools: { deny: ["exec"] } },
        room: { requireMention: true, tools: { deny: ["write"] } },
        sibling: { requireMention: true, tools: { deny: ["read"] } },
      };
      const accountGroups = override ? structuredClone(rootGroups) : undefined;
      const cfg = {
        channels: {
          imessage: {
            groups: rootGroups,
            accounts: { [accountKey]: accountGroups ? { groups: accountGroups } : {} },
          },
        },
      } satisfies OpenClawConfig;
      const groups = resolveChannelGroups(cfg, "imessage", accountId);
      const groupsPath = resolveChannelGroupsConfigPath({
        cfg,
        channel: "imessage",
        accountId,
        groups,
      });
      expect(groupsPath).toBe(
        override
          ? `channels.imessage.accounts[${JSON.stringify(accountKey)}].groups`
          : "channels.imessage.groups",
      );
      const before = structuredClone(rootGroups);

      setConfigValueAtPath(
        cfg,
        parseConcreteConfigPath(`${groupsPath}["room"].requireMention`),
        false,
      );

      expect(resolveChannelGroups(cfg, "imessage", accountId)).toEqual({
        ...before,
        room: { ...before.room, requireMention: false },
      });
      expect(
        resolveChannelGroupRequireMention({ cfg, channel: "imessage", accountId, groupId: "room" }),
      ).toBe(false);
      expect(
        resolveChannelGroupPolicy({ cfg, channel: "imessage", accountId, groupId: "sibling" })
          .allowed,
      ).toBe(true);
      if (override) {
        expect(rootGroups).toEqual(before);
      } else {
        expect(cfg.channels.imessage.accounts[accountKey]).toEqual({});
      }
    },
  );

  it.each([
    { name: "shared single-account inheritance", shallow: false, multiple: false, scope: "root" },
    { name: "shared multi-account override", shallow: false, multiple: true, scope: "account" },
    { name: "plugin-owned shallow override", shallow: true, multiple: false, scope: "account" },
  ])("honors $name for an empty map", ({ shallow, multiple, scope }) => {
    const channelConfig = {
      groups: { sibling: { requireMention: false } },
      accounts: { Work: { groups: {} }, ...(multiple ? { Other: {} } : {}) },
    };
    const cfg = { channels: { line: channelConfig } } satisfies OpenClawConfig;
    const groups = shallow
      ? resolveMergedAccountConfig<{ groups?: Record<string, { requireMention?: boolean }> }>({
          channelConfig,
          accounts: channelConfig.accounts,
          accountId: "work",
        }).groups
      : resolveChannelGroups(cfg, "line", "work");
    expect(
      resolveChannelGroupsConfigPath({ cfg, channel: "line", accountId: "work", groups }),
    ).toBe(scope === "root" ? "channels.line.groups" : 'channels.line.accounts["Work"].groups');
  });

  it.each([
    { accountId: "work", expected: 'channels.signal.accounts["Work"].groups' },
    { accountId: "default", expected: 'channels.signal.accounts["default"].groups' },
    { accountId: "missing", expected: "channels.signal.groups" },
  ])(
    "locates a new map for $accountId without inventing a fallback account",
    ({ accountId, expected }) => {
      const cfg = {
        channels: { signal: { accounts: { Work: {}, default: {} } } },
      } satisfies OpenClawConfig;
      expect(
        resolveChannelGroupsConfigPath({ cfg, channel: "signal", accountId, groups: undefined }),
      ).toBe(expected);
    },
  );

  it("preserves exact account-key precedence when config objects share a reference", () => {
    const account = { groups: {} };
    const cfg = {
      channels: { signal: { accounts: { Work: account, work: account } } },
    } satisfies OpenClawConfig;
    expect(
      resolveChannelGroupsConfigPath({
        cfg,
        channel: "signal",
        accountId: "work",
        groups: account.groups,
      }),
    ).toBe('channels.signal.accounts["work"].groups');
  });
});

describe("resolveToolsBySender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches typed sender IDs", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "id:user:alice": { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "user:alice",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("matches channel-scoped sender IDs through canonical channel aliases", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "channel:msteams:user:alice": { allow: ["exec"] },
          "id:user:alice": { deny: ["exec"] },
          "*": { deny: ["write"] },
        },
        messageProvider: "teams",
        senderId: "user:alice",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("keeps legacy colon sender IDs as sender IDs, not channel keys", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    expect(
      resolveToolsBySender({
        toolsBySender: {
          "discord:user:alice": { allow: ["exec"] },
          "channel:discord:user:alice": { deny: ["exec"] },
        },
        messageProvider: "slack",
        senderId: "discord:user:alice",
      }),
    ).toEqual({ allow: ["exec"] });

    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it("does not allow senderName collisions to match id keys", () => {
    const victimId = "f4ce8a7d-1111-2222-3333-444455556666";
    expect(
      resolveToolsBySender({
        toolsBySender: {
          [`id:${victimId}`]: { allow: ["exec", "fs.read"] },
          "*": { deny: ["exec"] },
        },
        senderId: "attacker-real-id",
        senderName: victimId,
        senderUsername: "attacker",
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("treats untyped legacy keys as senderId only", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const victimId = "legacy-owner-id";
    expect(
      resolveToolsBySender({
        toolsBySender: {
          [victimId]: { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "attacker-real-id",
        senderName: victimId,
      }),
    ).toEqual({ deny: ["exec"] });

    expect(
      resolveToolsBySender({
        toolsBySender: {
          [victimId]: { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: victimId,
        senderName: "attacker",
      }),
    ).toEqual({ allow: ["exec"] });
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it("matches username keys only against senderUsername", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "username:alice": { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "alice",
        senderUsername: "other-user",
      }),
    ).toEqual({ deny: ["exec"] });

    expect(
      resolveToolsBySender({
        toolsBySender: {
          "username:alice": { allow: ["exec"] },
          "*": { deny: ["exec"] },
        },
        senderId: "other-id",
        senderUsername: "@alice",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("matches e164 and name only when explicitly typed", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "e164:+15550001111": { allow: ["exec"] },
          "name:owner": { deny: ["exec"] },
        },
        senderE164: "+15550001111",
        senderName: "owner",
      }),
    ).toEqual({ allow: ["exec"] });
  });

  it("prefers id over username over name", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "id:alice": { deny: ["exec"] },
          "username:alice": { allow: ["exec"] },
          "name:alice": { allow: ["read"] },
        },
        senderId: "alice",
        senderUsername: "alice",
        senderName: "alice",
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("prefers channel-specific sender policy before generic id policy", () => {
    expect(
      resolveToolsBySender({
        toolsBySender: {
          "channel:discord:alice": { allow: ["read"] },
          "id:alice": { deny: ["read"] },
          "*": { deny: ["exec"] },
        },
        messageProvider: "discord",
        senderId: "alice",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("emits one deprecation warning per legacy key", () => {
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const legacyKey = "legacy-warning-key";
    const policy = {
      [legacyKey]: { allow: ["exec"] },
      "*": { deny: ["exec"] },
    };

    resolveToolsBySender({
      toolsBySender: policy,
      senderId: "other-id",
    });
    resolveToolsBySender({
      toolsBySender: policy,
      senderId: "other-id",
    });

    expect(warningSpy).toHaveBeenCalledTimes(1);
    const [warningMessage, warningMeta] = firstWarningCall(warningSpy);
    expect(String(warningMessage)).toContain(`toolsBySender key "${legacyKey}"`);
    expect(warningMeta?.code).toBe("OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY");
  });

  describe("legacy key warning dedupe cache", () => {
    let resolveToolsBySenderFn: typeof resolveToolsBySender;

    const resolveFreshConfig = (legacyKey: string) => {
      resolveToolsBySenderFn({
        toolsBySender: { [legacyKey]: { allow: ["read"] }, "*": { deny: ["exec"] } },
        senderId: "some-id",
      });
    };

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import("./group-policy.js");
      resolveToolsBySenderFn = mod.resolveToolsBySender;
    });

    it("refreshes recent keys across config snapshots and re-warns evicted keys", () => {
      const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

      for (let i = 0; i < 4096; i++) {
        resolveFreshConfig(`legacy-key-${i}`);
      }
      expect(warningSpy).toHaveBeenCalledTimes(4096);

      resolveFreshConfig("legacy-key-0");
      expect(warningSpy).toHaveBeenCalledTimes(4096);

      resolveFreshConfig("overflow-key");
      expect(warningSpy).toHaveBeenCalledTimes(4097);

      resolveFreshConfig("legacy-key-0");
      expect(warningSpy).toHaveBeenCalledTimes(4097);

      resolveFreshConfig("legacy-key-1");
      expect(warningSpy).toHaveBeenCalledTimes(4098);
    });
  });
});
