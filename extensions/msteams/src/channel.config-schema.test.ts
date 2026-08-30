import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";
import { msteamsPlugin } from "./channel.js";

describe("msteams config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    const res = MSTeamsConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit", () => {
    const res = MSTeamsConfigSchema.safeParse({ historyLimit: 4 });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(4);
    }
  });

  it("accepts the opt-in Graph media fallback", () => {
    const res = MSTeamsConfigSchema.safeParse({ graphMediaFallback: true });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.graphMediaFallback).toBe(true);
    }
  });

  it("accepts replyStyle at global/team/channel levels", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "top-level",
      teams: {
        team123: {
          replyStyle: "thread",
          channels: {
            chan456: { replyStyle: "top-level" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.replyStyle).toBe("top-level");
      expect(res.data.teams?.team123?.replyStyle).toBe("thread");
      expect(res.data.teams?.team123?.channels?.chan456?.replyStyle).toBe("top-level");
    }
  });

  it("accepts Teams SDK cloud and serviceUrl configuration", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://smba.infra.dod.teams.microsoft.us/teams",
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.cloud).toBe("USGovDoD");
      expect(res.data.serviceUrl).toBe("https://smba.infra.dod.teams.microsoft.us/teams");
    }
  });

  it("rejects unsupported Teams serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://dod.example.mil/teams",
    });

    expect(res.success).toBe(false);
  });

  it("accepts China cloud without a configured global serviceUrl", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
    });

    expect(res.success).toBe(true);
  });

  it("accepts Azure China Bot Framework serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-China serviceUrl hosts when China cloud is configured", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://smba.trafficmanager.net/teams",
    });

    expect(res.success).toBe(false);
  });

  it("rejects Azure China Bot Framework serviceUrl hosts without China cloud", () => {
    const res = MSTeamsConfigSchema.safeParse({
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(false);
  });

  it("requires serviceUrl with non-public Teams clouds", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGov",
    });

    expect(res.success).toBe(false);
  });

  it("rejects invalid replyStyle", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "nope",
    });

    expect(res.success).toBe(false);
  });

  it("accepts named Teams bot accounts with explicit identities and ports", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
      defaultAccount: "default",
    });

    expect(res.success).toBe(true);
  });

  it("validates named SSO after merging root and account settings", () => {
    const inheritedConnection = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      sso: { connectionName: "graph" },
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
          sso: { enabled: true },
        },
      },
    });
    const invalidOverride = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      sso: { enabled: true, connectionName: "graph" },
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
          sso: { connectionName: "" },
        },
      },
    });

    expect(inheritedConnection.success).toBe(true);
    expect(invalidOverride.success).toBe(false);
  });

  it("validates shared root settings only after merging named account overrides", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      dmPolicy: "open",
      sso: { enabled: true },
      cloud: "USGov",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
          allowFrom: ["*"],
          sso: { connectionName: "graph" },
          serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams",
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("validates the effective default account allowlist", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      dmPolicy: "open",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
          allowFrom: ["*"],
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("ignores runtime refinements for disabled named accounts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      dmPolicy: "open",
      sso: { enabled: true },
      cloud: "USGov",
      accounts: {
        retired: { enabled: false },
      },
    });

    expect(res.success).toBe(true);
  });

  it("does not reserve a partial environment default app ID", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "support-app-id");
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });
    vi.unstubAllEnvs();

    expect(res.success).toBe(true);
  });

  it("honors a managed identity opt-out when detecting an environment default", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "support-app-id");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant-id");
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_USE_MANAGED_IDENTITY", "true");
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      useManagedIdentity: false,
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3978 },
        },
      },
    });
    vi.unstubAllEnvs();

    expect(res.success).toBe(true);
  });

  it("reserves an environment default completed by accounts.default auth settings", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "shared-app-id");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant-id");
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          authType: "federated",
          useManagedIdentity: true,
        },
        support: {
          appId: "shared-app-id",
          appPassword: "support-secret",
          webhook: { port: 3978 },
        },
      },
    });
    vi.unstubAllEnvs();

    expect(res.success).toBe(false);
  });

  it.each([
    {
      name: "root",
      config: { webhook: { port: 65536 } },
      path: ["webhook", "port"],
    },
    {
      name: "named account",
      config: {
        tenantId: "tenant-id",
        accounts: {
          support: {
            appId: "support-app-id",
            appPassword: "support-secret",
            webhook: { port: 65536 },
          },
        },
      },
      path: ["accounts", "support", "webhook", "port"],
    },
  ])("rejects $name webhook ports above the TCP range", ({ config, path }) => {
    const res = MSTeamsConfigSchema.safeParse(config);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    }
  });

  it("accepts the highest TCP port for a named account", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 65535 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects named Teams bot accounts with duplicate canonical account ids", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
      accounts: {
        "Support Bot": {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
        "support-bot": {
          appId: "support-shadow-app-id",
          appPassword: "support-shadow-secret",
          webhook: { port: 3980 },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["accounts", "support-bot"],
            message: expect.stringContaining('duplicate canonical account id "support-bot"'),
          }),
        ]),
      );
    }
  });

  it("rejects named accounts that would inherit identity or port from root", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      webhook: { port: 3978, path: "/api/messages" },
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects enabled named accounts without an effective tenant ID", () => {
    const res = MSTeamsConfigSchema.safeParse({
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects simultaneous root and accounts.default identity definitions", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "root-app-id",
      appPassword: "root-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "default-app-id",
          appPassword: "default-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects simultaneous root and canonical default account alias identity definitions", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "root-app-id",
      appPassword: "root-secret",
      tenantId: "tenant-id",
      accounts: {
        Default: {
          appId: "default-app-id",
          appPassword: "default-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["accounts", "Default"],
            message: expect.stringContaining("default Teams identity"),
          }),
        ]),
      );
    }
  });

  it("treats canonical default account aliases as default account config", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        Default: {
          appId: "default-app-id",
          appPassword: "default-secret",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects duplicate enabled account webhook ports", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with accounts.default implicit webhook port", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with the implicit default webhook port", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with an environment-backed default listener", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-default-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-default-password");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant-id");
    try {
      const res = MSTeamsConfigSchema.safeParse({
        tenantId: "shared-tenant-id",
        accounts: {
          secondary: {
            appId: "secondary-app-id",
            appPassword: "secondary-secret",
            webhook: { port: 3978 },
          },
        },
      });
      const duplicateAppId = MSTeamsConfigSchema.safeParse({
        tenantId: "shared-tenant-id",
        webhook: { port: 3980 },
        accounts: {
          secondary: {
            appId: "env-default-app",
            appPassword: "secondary-secret",
            webhook: { port: 3979 },
          },
        },
      });

      expect(res.success).toBe(false);
      expect(duplicateAppId.success).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects named accounts that collide with a metadata-only default account implicit port", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          name: "Primary",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("allows metadata-only default account when named accounts use different ports", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          name: "Primary",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects whitespace-only passwords for enabled named secret accounts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "   ",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("deletes the default account identity without leaving a root webhook port", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: {
            port: 3978,
            path: "/api/messages",
          },
          accounts: {
            default: {
              name: "Primary",
            },
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = msteamsPlugin.config?.deleteAccount?.({
      cfg,
      accountId: "default",
    });

    expect(next?.channels?.msteams).toEqual({
      tenantId: "tenant-id",
      webhook: {
        path: "/api/messages",
      },
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });
  });

  it("allows duplicate webhook ports when one account is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          enabled: false,
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects duplicate enabled account app IDs", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "shared-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          appId: "SHARED-APP-ID",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("allows duplicate app IDs when one account is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "shared-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          enabled: false,
          appId: "shared-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("allows a named account to reuse the root app ID when accounts.default is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "shared-app-id",
      appPassword: "legacy-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          enabled: false,
        },
        support: {
          appId: "shared-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects enabled named federated accounts without a certificate or managed identity", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        secondary: {
          authType: "federated",
          appId: "secondary-app-id",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts enabled named federated accounts with inherited certificate config", () => {
    const res = MSTeamsConfigSchema.safeParse({
      authType: "federated",
      tenantId: "tenant-id",
      certificatePath: "/secure/secondary.pem",
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });
});
