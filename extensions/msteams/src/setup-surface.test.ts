// Msteams tests cover setup surface plugin behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./setup-core.js";

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

import { msteamsSetupWizard as delegatedMsteamsSetupWizard } from "./setup-surface.js";

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

  it("always resolves to the default account", () => {
    expect(msteamsSetupAdapter.resolveAccountId?.({ accountId: "work" } as never)).toBe(
      DEFAULT_ACCOUNT_ID,
    );
  });

  it("enables the msteams channel without dropping existing config", () => {
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
          appId: "existing-app",
          enabled: true,
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

    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: { existing: true } } },
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        text: vi.fn(),
      },
    } as never);

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
            appId: "app-id",
            appPassword: "app-password",
            tenantId: "tenant-id",
          },
        },
      },
    });
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
    expect(saveDelegatedTokens).toHaveBeenCalledWith(tokens);
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
});
