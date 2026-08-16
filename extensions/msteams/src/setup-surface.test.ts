// Msteams tests cover setup surface plugin behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./setup-core.js";
import {
  msteamsSetupWizard as delegatedMsteamsSetupWizard,
  msteamsSetupWizard as exportedMSTeamsSetupWizard,
} from "./setup-surface.js";

const resolveMSTeamsUserAllowlist = vi.hoisted(() => vi.fn());
const resolveMSTeamsChannelAllowlist = vi.hoisted(() => vi.fn());
const normalizeSecretInputString = vi.hoisted(() =>
  vi.fn((value: unknown) => (typeof value === "string" ? value.trim() || undefined : undefined)),
);
const hasConfiguredMSTeamsCredentials = vi.hoisted(() => vi.fn());
const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());
const saveDelegatedTokens = vi.hoisted(() => vi.fn());
const loginMSTeamsDelegated = vi.hoisted(() => vi.fn());
const oauthModuleState = vi.hoisted(() => ({ loaded: false }));

vi.mock("./resolve-allowlist.js", () => ({
  parseMSTeamsTeamEntry: vi.fn(),
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
}));

vi.mock("./secret-input.js", () => ({
  normalizeSecretInputString,
}));

vi.mock("./token.js", () => ({
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
  saveDelegatedTokens,
}));

vi.mock("./oauth.js", () => {
  oauthModuleState.loaded = true;
  return { loginMSTeamsDelegated };
});

describe("msteams setup surface", () => {
  const msteamsSetupWizard = createMSTeamsSetupWizardBase();

  beforeEach(() => {
    resolveMSTeamsUserAllowlist.mockReset();
    resolveMSTeamsChannelAllowlist.mockReset();
    normalizeSecretInputString.mockClear();
    hasConfiguredMSTeamsCredentials.mockReset();
    resolveMSTeamsCredentials.mockReset();
    saveDelegatedTokens.mockReset();
    loginMSTeamsDelegated.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the requested account id", () => {
    expect(msteamsSetupAdapter.resolveAccountId?.({ accountId: "work" } as never)).toBe("work");
  });

  it("enables the msteams channel and promotes existing default identity", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              appId: "existing-app",
            },
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {},
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
              appId: "existing-app",
            },
          },
        },
      },
    });
  });

  it("applies named account config without moving shared root defaults", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              tenantId: "shared-tenant",
              dmPolicy: "allowlist",
              allowFrom: ["user-1"],
            },
          },
        },
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          tenantId: "shared-tenant",
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          enabled: true,
          accounts: {
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    });
  });

  it("updates an existing display-style account key in place", () => {
    const result = msteamsSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              "Support Bot": {
                name: "Support Bot",
                enabled: false,
                appId: "old-app",
                appPassword: "old-secret",
                tenantId: "old-tenant",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
      accountId: "support-bot",
      input: {
        appId: "support-app",
        appPassword: "support-secret",
        tenantId: "tenant-id",
      },
    } as never);

    expect(result).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            "Support Bot": {
              name: "Support Bot",
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
              webhook: { port: 3979 },
            },
          },
        },
      },
    });
    expect(result?.channels?.msteams?.accounts).not.toHaveProperty("support-bot");
  });

  it("promotes root identity when adding a named account", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              appId: "default-app",
              appPassword: "default-secret",
              tenantId: "shared-tenant",
              webhook: { port: 3978, path: "/api/messages" },
            },
          },
        },
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          tenantId: "shared-tenant",
          webhook: { path: "/api/messages" },
          enabled: true,
          accounts: {
            default: {
              appId: "default-app",
              appPassword: "default-secret",
              webhook: { port: 3978 },
            },
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    });
  });

  it("rejects env credentials for named accounts", () => {
    expect(
      msteamsSetupAdapter.validateInput?.({
        accountId: "support",
        input: { useEnv: true },
      } as never),
    ).toBe("MSTEAMS_* environment variables can only be used for the default account.");
  });

  it("re-enables a disabled named account when setup configures it", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              accounts: {
                support: {
                  enabled: false,
                  appId: "old-app",
                },
              },
            },
          },
        },
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    });
  });

  it("reports configured status from resolved credentials", () => {
    resolveMSTeamsCredentials.mockReturnValue({
      appId: "app",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);

    expect(
      msteamsSetupWizard.status.resolveConfigured({
        cfg: { channels: { msteams: {} } },
      } as never),
    ).toBe(true);
  });

  it("reports configured status from configured credentials and renders status lines", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);

    expect(
      msteamsSetupWizard.status.resolveConfigured({
        cfg: { channels: { msteams: {} } },
      } as never),
    ).toBe(true);

    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    expect(msteamsSetupWizard.status.resolveStatusLines).toBeTypeOf("function");
    await expect(
      msteamsSetupWizard.status.resolveStatusLines?.({
        cfg: { channels: { msteams: {} } },
      } as never),
    ).resolves.toEqual(["MS Teams: needs app credentials"]);
  });

  it("finalize keeps env credentials when available and accepted", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-secret");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant");
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const confirm = vi.fn(async () => true);

    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: { existing: true } } },
      prompter: {
        confirm,
        note: vi.fn(async () => {}),
        text: vi.fn(),
      },
    } as never);

    expect(confirm).toHaveBeenCalledWith({
      message: "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
      initialValue: true,
    });
    expect(result).toEqual({
      accountId: "default",
      cfg: {
        channels: {
          msteams: {
            existing: true,
            enabled: true,
          },
        },
      },
    });
  });

  it.each([
    {
      label: "federated managed-identity env",
      env: {
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_APP_ID: "env-app",
        MSTEAMS_TENANT_ID: "env-tenant",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
      credentials: {
        type: "federated",
        appId: "env-app",
        tenantId: "env-tenant",
        useManagedIdentity: true,
      },
      msteams: {},
    },
    {
      label: "federated certificate env",
      env: {
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_APP_ID: "env-app",
        MSTEAMS_TENANT_ID: "env-tenant",
        MSTEAMS_CERTIFICATE_PATH: "/tmp/msteams-certificate.pem",
      },
      credentials: {
        type: "federated",
        appId: "env-app",
        tenantId: "env-tenant",
        certificatePath: "/tmp/msteams-certificate.pem",
      },
      msteams: {},
    },
    {
      label: "persisted secret",
      env: {},
      credentials: {
        type: "secret",
        appId: "stored-app",
        appPassword: "stored-password",
        tenantId: "stored-tenant",
      },
      msteams: {
        enabled: false,
        appId: "stored-app",
        appPassword: "stored-password",
        tenantId: "stored-tenant",
      },
    },
  ])(
    "finalize enables accepted $label credentials without rewriting them",
    async ({ env, credentials, msteams }) => {
      for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
      }
      resolveMSTeamsCredentials.mockReturnValue(credentials);
      hasConfiguredMSTeamsCredentials.mockReturnValue(true);
      const confirm = vi.fn(async () => true);
      const text = vi.fn();

      const result = await msteamsSetupWizard.finalize?.({
        cfg: { channels: { msteams } },
        prompter: { confirm, note: vi.fn(async () => {}), text },
      } as never);

      expect(confirm).toHaveBeenCalledWith({
        message: "MS Teams credentials already configured. Keep them?",
        initialValue: true,
      });
      expect(text).not.toHaveBeenCalled();
      expect(result).toEqual({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: { channels: { msteams: { ...msteams, enabled: true } } },
      });
    },
  );

  it("finalize prompts for manual credentials when env/config creds are unavailable", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Enter MS Teams App ID") {
        return "app-id";
      }
      if (message === "Enter MS Teams App Password") {
        return "app-password";
      }
      if (message === "Enter MS Teams Tenant ID") {
        return "tenant-id";
      }
      throw new Error(`Unexpected prompt: ${message}`);
    });

    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: {} } },
      prompter: {
        confirm,
        note,
        text,
      },
    } as never);

    expect(note).toHaveBeenCalled();
    expect(result).toEqual({
      accountId: "default",
      cfg: {
        channels: {
          msteams: {
            enabled: true,
            accounts: {
              default: {
                enabled: true,
                appId: "app-id",
                appPassword: "app-password",
                tenantId: "tenant-id",
              },
            },
          },
        },
      },
    });
  });

  it("finalize configures named accounts with credentials and webhook port", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Enter MS Teams App ID") {
        return "support-app";
      }
      if (message === "Enter MS Teams App Password") {
        return "support-password";
      }
      if (message === "Enter MS Teams Tenant ID") {
        return "tenant-id";
      }
      if (message === "Enter MS Teams webhook port") {
        return "3979";
      }
      throw new Error(`Unexpected prompt: ${message}`);
    });

    const result = await msteamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            tenantId: "shared-tenant",
            webhook: { path: "/api/messages" },
            dmPolicy: "allowlist",
            allowFrom: ["user-1"],
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm,
        note,
        text,
      },
    } as never);

    expect(result).toEqual({
      accountId: "support",
      cfg: {
        channels: {
          msteams: {
            tenantId: "shared-tenant",
            webhook: { path: "/api/messages" },
            dmPolicy: "allowlist",
            allowFrom: ["user-1"],
            enabled: true,
            accounts: {
              support: {
                enabled: true,
                appId: "support-app",
                appPassword: "support-password",
                tenantId: "tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
    });
  });

  it("finalize keeps existing federated named account credentials", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "support-app",
      tenantId: "tenant-id",
      certificatePath: "/secure/support.pem",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const confirm = vi.fn(async () => true);
    const text = vi.fn();

    const result = await msteamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: {
                authType: "federated",
                appId: "support-app",
                tenantId: "tenant-id",
                certificatePath: "/secure/support.pem",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm,
        note: vi.fn(async () => {}),
        text,
      },
    } as never);

    expect(result).toEqual({
      accountId: "support",
      cfg: {
        channels: {
          msteams: {
            enabled: true,
            accounts: {
              support: {
                authType: "federated",
                appId: "support-app",
                tenantId: "tenant-id",
                certificatePath: "/secure/support.pem",
                webhook: { port: 3979 },
                enabled: true,
              },
            },
          },
        },
      },
    });
    expect(confirm).toHaveBeenCalledWith({
      message: "MS Teams credentials already configured. Keep them?",
      initialValue: true,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("revalidates before delegated OAuth and immediately before saving tokens", async () => {
    const tokens = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      scopes: ["User.Read"],
    };
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue(tokens);
    expect(oauthModuleState.loaded).toBe(false);
    const beforePersistentEffect = vi.fn(async () => {
      expect(oauthModuleState.loaded).toBe(true);
    });
    const progress = { update: vi.fn(), stop: vi.fn() };

    await delegatedMsteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: {} } },
      prompter: {
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => progress),
        text: vi.fn(),
      },
      options: { beforePersistentEffect },
    } as never);

    expect(beforePersistentEffect).toHaveBeenCalledTimes(2);
    expect(loginMSTeamsDelegated).toHaveBeenCalledTimes(1);
    expect(saveDelegatedTokens).toHaveBeenCalledWith(tokens, { accountId: DEFAULT_ACCOUNT_ID });
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      loginMSTeamsDelegated.mock.invocationCallOrder[0]!,
    );
    expect(loginMSTeamsDelegated.mock.invocationCallOrder[0]).toBeLessThan(
      beforePersistentEffect.mock.invocationCallOrder[1]!,
    );
    expect(beforePersistentEffect.mock.invocationCallOrder[1]).toBeLessThan(
      saveDelegatedTokens.mock.invocationCallOrder[0]!,
    );
  });

  it("propagates a stale inference guard instead of treating it as an OAuth failure", async () => {
    const guardError = new Error("verified inference changed");
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      scopes: ["User.Read"],
    });
    const beforePersistentEffect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(guardError);
    const note = vi.fn(async () => {});
    const progress = { update: vi.fn(), stop: vi.fn() };

    await expect(
      delegatedMsteamsSetupWizard.finalize?.({
        cfg: { channels: { msteams: {} } },
        prompter: {
          confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
          note,
          progress: vi.fn(() => progress),
          text: vi.fn(),
        },
        options: { beforePersistentEffect },
      } as never),
    ).rejects.toBe(guardError);

    expect(loginMSTeamsDelegated).toHaveBeenCalledTimes(1);
    expect(saveDelegatedTokens).not.toHaveBeenCalled();
    expect(progress.stop).toHaveBeenCalledWith();
    expect(note).not.toHaveBeenCalledWith(
      expect.stringContaining("Delegated auth setup failed"),
      expect.anything(),
    );
  });

  it("finalize stores delegated auth under the resolved named account", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "support-app",
      appPassword: "support-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
      scopes: ["ChatMessage.Send"],
    });
    const progress = { update: vi.fn(), stop: vi.fn() };

    const result = await exportedMSTeamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: {
                appId: "support-app",
                appPassword: "support-password",
                tenantId: "tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => progress),
        text: vi.fn(),
      },
    } as never);

    expect(result?.cfg?.channels?.msteams?.accounts?.support).toEqual({
      appId: "support-app",
      appPassword: "support-password",
      tenantId: "tenant-id",
      webhook: { port: 3979 },
      delegatedAuth: { enabled: true },
      enabled: true,
    });
    expect(saveDelegatedTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
      { accountId: "support" },
    );
    expect(progress.stop).toHaveBeenCalled();
  });
});
