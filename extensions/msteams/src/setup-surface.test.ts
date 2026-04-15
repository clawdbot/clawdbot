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
}));

describe("msteams setup surface", () => {
  const msteamsSetupWizard = createMSTeamsSetupWizardBase();

  beforeEach(() => {
    resolveMSTeamsUserAllowlist.mockReset();
    resolveMSTeamsChannelAllowlist.mockReset();
    normalizeSecretInputString.mockClear();
    hasConfiguredMSTeamsCredentials.mockReset();
    resolveMSTeamsCredentials.mockReset();
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

  it("reports configured status from resolved credentials", async () => {
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
});
