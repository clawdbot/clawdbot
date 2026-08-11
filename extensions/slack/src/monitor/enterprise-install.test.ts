import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  assertEnterpriseSlackBindingsAreWorkspaceQualified,
  assertEnterpriseSlackPolicyConfig,
  resolveSlackInstallationIdentity,
} from "./enterprise-install.js";

describe("resolveSlackInstallationIdentity", () => {
  it("preserves degraded startup when auth.test is unavailable", () => {
    expect(resolveSlackInstallationIdentity({})).toEqual({
      kind: "degraded",
      reason: "auth_test_failed",
    });
  });

  it("detects an org-wide installation", () => {
    expect(
      resolveSlackInstallationIdentity({
        auth: {
          app_id: "A123",
          enterprise_id: "E123",
          team_id: "T_INSTALLER",
          is_enterprise_install: true,
        },
      }),
    ).toEqual({ kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" });
  });

  it("detects a workspace installation when auth.test omits app_id", () => {
    expect(
      resolveSlackInstallationIdentity({
        auth: {
          team_id: "T123",
          is_enterprise_install: false,
        },
      }),
    ).toEqual({ kind: "workspace", teamId: "T123" });
  });

  it("preserves the human workspace name from auth.test", () => {
    expect(
      resolveSlackInstallationIdentity({
        auth: {
          team: "Local Claw",
          team_id: "T123",
          is_enterprise_install: false,
        },
      }),
    ).toEqual({ kind: "workspace", teamId: "T123", teamName: "Local Claw" });
  });

  it("accepts an org-wide auth.test response without app_id", () => {
    expect(
      resolveSlackInstallationIdentity({
        auth: {
          enterprise_id: "E123",
          is_enterprise_install: true,
        },
      }),
    ).toEqual({ kind: "enterprise", enterpriseId: "E123" });
  });

  it("uses the transport app id when org-wide auth.test omits app_id", () => {
    expect(
      resolveSlackInstallationIdentity({
        transportApiAppId: "A123",
        auth: {
          enterprise_id: "E123",
          is_enterprise_install: true,
        },
      }),
    ).toEqual({ kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" });
  });

  it("rejects mismatched bot and transport app ids", () => {
    expect(() =>
      resolveSlackInstallationIdentity({
        transportApiAppId: "A_TRANSPORT",
        auth: {
          app_id: "A_BOT",
          enterprise_id: "E123",
          is_enterprise_install: true,
        },
      }),
    ).toThrow(/token mismatch/);
  });
});

describe("assertEnterpriseSlackPolicyConfig", () => {
  it("accepts only runtime-supported stable channel forms", () => {
    expect(() =>
      assertEnterpriseSlackPolicyConfig({
        accountId: "org",
        config: {
          allowFrom: ["U01234567", "slack:W01234567", "user:U12345678"],
          dm: { groupChannels: ["G01234567", "channel:G12345678"] },
          mentionPatterns: {
            mode: "allow",
            allowIn: ["team:T01234567:channel:C01234567"],
            denyIn: ["team:T12345678:channel:C12345678"],
          },
          channels: {
            C01234567: {
              users: ["U01234567", "slack:W01234567", "user:U12345678"],
              toolsBySender: {
                U01234567: {},
                "id:W01234567": {},
                "channel:slack:U12345678": {},
                "*": {},
              },
            },
            "channel:C12345678": {},
            "*": {},
          },
        },
      }),
    ).not.toThrow();
  });

  it.each(["allowIn", "denyIn"] as const)(
    "rejects unqualified Enterprise mention pattern policy %s",
    (field) => {
      expect(() =>
        assertEnterpriseSlackPolicyConfig({
          accountId: "org",
          config: { mentionPatterns: { [field]: ["C123"] } },
        }),
      ).toThrow(/stable Slack IDs.*mentionPatterns/);
    },
  );

  it("rejects the mutable-name matching escape hatch", () => {
    expect(() =>
      assertEnterpriseSlackPolicyConfig({
        accountId: "org",
        config: { dangerouslyAllowNameMatching: true },
      }),
    ).toThrow(/cannot use dangerouslyAllowNameMatching/);
  });

  it.each<[string, SlackAccountConfig]>([
    ["channels key", { channels: { general: {} } }],
    ["prefixed channels key", { channels: { "channel:general": {} } }],
    ["allowFrom", { allowFrom: ["ursula"] }],
    ["prefixed allowFrom", { allowFrom: ["slack:ursula"] }],
    ["group DM channel", { dm: { groupChannels: ["general"] } }],
    ["reaction allowlist", { reactionNotifications: "allowlist", reactionAllowlist: ["ursula"] }],
    ["channel users", { channels: { C01234567: { users: ["ursula"] } } }],
    ["toolsBySender", { channels: { C01234567: { toolsBySender: { "id:ursula": {} } } } }],
  ])("rejects lowercase mutable names in %s", (_label, config) => {
    expect(() =>
      assertEnterpriseSlackPolicyConfig({
        accountId: "org",
        config,
      }),
    ).toThrow(/stable Slack/);
  });

  it.each<[string, SlackAccountConfig]>([
    ["lowercase channel ID", { channels: { c01234567: {} } }],
    ["short channel ID", { channels: { C123: {} } }],
    ["lowercase user ID", { allowFrom: ["u01234567"] }],
    ["short user ID", { allowFrom: ["U123"] }],
  ])("rejects non-canonical IDs in %s", (_label, config) => {
    expect(() =>
      assertEnterpriseSlackPolicyConfig({
        accountId: "org",
        config,
      }),
    ).toThrow(/stable Slack/);
  });

  it.each(["id:U01234567", "channel:slack:U01234567"])(
    "rejects toolsBySender-only alias %s on Slack allowlists",
    (entry) => {
      expect(() =>
        assertEnterpriseSlackPolicyConfig({
          accountId: "org",
          config: { allowFrom: [entry] },
        }),
      ).toThrow(/stable Slack IDs.*allowFrom/);
    },
  );

  it.each(["slack:U01234567", "user:U01234567"])(
    "fails closed on unsupported toolsBySender alias %s before permissive wildcard fallback",
    (entry) => {
      expect(() =>
        assertEnterpriseSlackPolicyConfig({
          accountId: "org",
          config: {
            channels: {
              C01234567: {
                toolsBySender: {
                  [entry]: { deny: ["exec"] },
                  "*": { allow: ["exec"] },
                },
              },
            },
          },
        }),
      ).toThrow(/stable Slack IDs.*toolsBySender/);
    },
  );

  it.each(["slack:C01234567", "group:G01234567", "mpim:G01234567"])(
    "rejects unsupported channels key form %s",
    (channelKey) => {
      expect(() =>
        assertEnterpriseSlackPolicyConfig({
          accountId: "org",
          config: { channels: { [channelKey]: {} } },
        }),
      ).toThrow(/stable Slack channel IDs/);
    },
  );

  it.each(["slack:G01234567", "group:G01234567", "mpim:G01234567", "*"])(
    "rejects unsupported groupChannels form %s",
    (channelKey) => {
      expect(() =>
        assertEnterpriseSlackPolicyConfig({
          accountId: "org",
          config: { dm: { groupChannels: [channelKey] } },
        }),
      ).toThrow(/stable Slack IDs.*dm\.groupChannels/);
    },
  );

  it("rejects channel names", () => {
    expect(() =>
      assertEnterpriseSlackPolicyConfig({
        accountId: "org",
        config: { channels: { "#general": {} } },
      }),
    ).toThrow(/stable Slack channel IDs/);
  });
});

describe("assertEnterpriseSlackBindingsAreWorkspaceQualified", () => {
  it("canonicalizes binding account IDs the same way as runtime routing", () => {
    const cfg = {
      channels: { slack: { defaultAccount: "other", accounts: { work: {}, other: {} } } },
      bindings: [
        {
          match: {
            channel: "slack",
            accountId: "WORK",
            peer: { kind: "channel", id: "C01234567" },
          },
          agentId: "main",
        },
      ],
    } as never;

    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: "work" }),
    ).toThrow(/requires configured Slack binding peers/);
    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: "other" }),
    ).not.toThrow();
  });

  it("requires workspace scope only on bindings that apply to the Enterprise account", () => {
    const cfg = {
      channels: {
        slack: { defaultAccount: "workspace", accounts: { workspace: {}, enterprise: {} } },
      },
      bindings: [{ match: { channel: "slack" }, agentId: "main" }],
    } as never;

    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: "enterprise" }),
    ).not.toThrow();
    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: "workspace" }),
    ).toThrow(/requires match\.teamId/);
  });

  it("accepts team-scoped and workspace-qualified peer bindings", () => {
    const cfg = {
      channels: { slack: { defaultAccount: "org", accounts: { org: {} } } },
      bindings: [
        { match: { channel: "slack", teamId: "T01234567" }, agentId: "team" },
        {
          match: {
            channel: "slack",
            peer: { kind: "channel", id: "team:T01234567:channel:C01234567" },
          },
          agentId: "channel",
        },
      ],
    } as never;

    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: "org" }),
    ).not.toThrow();
  });

  it("rejects unqualified or conflicting Enterprise peer bindings", () => {
    const unqualified = {
      channels: { slack: { defaultAccount: "org", accounts: { org: {} } } },
      bindings: [
        {
          match: { channel: "slack", peer: { kind: "channel", id: "C01234567" } },
          agentId: "channel",
        },
      ],
    } as never;
    const conflicting = {
      channels: { slack: { defaultAccount: "org", accounts: { org: {} } } },
      bindings: [
        {
          match: {
            channel: "slack",
            teamId: "T99999999",
            peer: { kind: "channel", id: "team:T01234567:channel:C01234567" },
          },
          agentId: "channel",
        },
      ],
    } as never;

    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg: unqualified, accountId: "org" }),
    ).toThrow(/requires configured Slack binding peers/);
    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg: conflicting, accountId: "org" }),
    ).toThrow(/conflicting workspace IDs/);
  });

  it("retains the workspace boundary for configured ACP bindings", () => {
    const cfg = {
      channels: { slack: { defaultAccount: "org", accounts: { org: {} } } },
      bindings: [
        {
          type: "acp",
          match: {
            channel: "slack",
            peer: { kind: "channel", id: "team:T01234567:channel:C01234567" },
          },
          agentId: "channel",
        },
      ],
    } as never;

    expect(() =>
      assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: "org" }),
    ).toThrow(/cannot use configured ACP bindings/);
  });
});
