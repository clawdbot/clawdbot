import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  assertEnterpriseSlackDmPolicy,
  assertNoEnterpriseSlackBindings,
  assertEnterpriseSlackPolicyConfig,
  resolveSlackInstallationIdentity,
} from "./enterprise-install.js";

describe("resolveSlackInstallationIdentity", () => {
  it("validates an explicitly configured org-wide installation", () => {
    expect(
      resolveSlackInstallationIdentity({
        enterpriseOrgInstall: true,
        auth: {
          app_id: "A123",
          enterprise_id: "E123",
          team_id: "T_INSTALLER",
          is_enterprise_install: true,
        },
      }),
    ).toEqual({ kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" });
  });

  it("fails closed when an org token is used without explicit configuration", () => {
    expect(() =>
      resolveSlackInstallationIdentity({
        enterpriseOrgInstall: false,
        auth: {
          app_id: "A123",
          enterprise_id: "E123",
          is_enterprise_install: true,
        },
      }),
    ).toThrow(/set enterpriseOrgInstall=true/);
  });

  it("preserves degraded workspace startup after auth.test failure", () => {
    expect(
      resolveSlackInstallationIdentity({
        enterpriseOrgInstall: false,
        authError: new Error("timeout"),
      }),
    ).toEqual({ kind: "degraded", reason: "auth_test_failed" });
  });

  it("preserves workspace startup when auth.test omits app_id", () => {
    expect(
      resolveSlackInstallationIdentity({
        enterpriseOrgInstall: false,
        auth: {
          team_id: "T123",
          is_enterprise_install: false,
        },
      }),
    ).toEqual({ kind: "workspace", teamId: "T123" });
  });

  it("accepts an org-wide auth.test response without app_id", () => {
    expect(
      resolveSlackInstallationIdentity({
        enterpriseOrgInstall: true,
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
        enterpriseOrgInstall: true,
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
        enterpriseOrgInstall: true,
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

describe("assertEnterpriseSlackDmPolicy", () => {
  it("allows disabled DMs or explicitly open DMs", () => {
    expect(() =>
      assertEnterpriseSlackDmPolicy({
        accountId: "org",
        dmEnabled: false,
        dmPolicy: "pairing",
        allowFrom: ["U123"],
      }),
    ).not.toThrow();
    expect(() =>
      assertEnterpriseSlackDmPolicy({
        accountId: "org",
        dmEnabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
    ).not.toThrow();
    expect(() =>
      assertEnterpriseSlackDmPolicy({
        accountId: "org",
        dmEnabled: true,
        dmPolicy: "disabled",
        allowFrom: ["U123"],
      }),
    ).not.toThrow();
  });

  it.each([undefined, [], ["U123"], ["slack:U123"]])(
    "rejects open DMs without a literal wildcard in effective allowFrom: %j",
    (allowFrom) => {
      expect(() =>
        assertEnterpriseSlackDmPolicy({
          accountId: "org",
          dmEnabled: true,
          dmPolicy: "open",
          allowFrom,
        }),
      ).toThrow(/effective allowFrom containing "\*"/);
    },
  );

  it("accepts an inherited effective wildcard allowlist", () => {
    expect(() =>
      assertEnterpriseSlackDmPolicy({
        accountId: "org",
        dmEnabled: true,
        dmPolicy: "open",
        allowFrom: ["U123", "*"],
      }),
    ).not.toThrow();
  });

  it.each(["pairing", "allowlist", "future-per-user"])(
    "rejects account-wide per-user DM authorization mode %s",
    (dmPolicy) => {
      expect(() =>
        assertEnterpriseSlackDmPolicy({
          accountId: "org",
          dmEnabled: true,
          dmPolicy,
          allowFrom: ["*"],
        }),
      ).toThrow(/supports DMs only with dm\.enabled=false.*dmPolicy="open"/);
    },
  );
});

describe("assertEnterpriseSlackPolicyConfig", () => {
  it("accepts only runtime-supported stable channel forms", () => {
    expect(() =>
      assertEnterpriseSlackPolicyConfig({
        accountId: "org",
        config: {
          allowFrom: ["U01234567", "slack:W01234567", "user:U12345678"],
          dm: { groupChannels: ["G01234567", "channel:G12345678"] },
          mentionPatterns: { mode: "allow" },
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
    "rejects workspace-scoped mention pattern policy %s",
    (field) => {
      expect(() =>
        assertEnterpriseSlackPolicyConfig({
          accountId: "org",
          config: { mentionPatterns: { [field]: ["C123"] } },
        }),
      ).toThrow(/cannot use mentionPatterns\.allowIn or mentionPatterns\.denyIn/);
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

describe("assertNoEnterpriseSlackBindings", () => {
  it("rejects omitted accounts only when the enterprise account is default", () => {
    const cfg = {
      channels: {
        slack: { defaultAccount: "workspace", accounts: { workspace: {}, enterprise: {} } },
      },
      bindings: [{ match: { channel: "slack" }, agentId: "main" }],
    } as never;

    expect(() => assertNoEnterpriseSlackBindings({ cfg, accountId: "enterprise" })).not.toThrow();
    expect(() => assertNoEnterpriseSlackBindings({ cfg, accountId: "workspace" })).toThrow(
      /cannot use configured Slack bindings/,
    );
  });
});
