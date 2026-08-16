// ClickClack tests cover guided setup prompts and nonfatal live validation.
import fs from "node:fs";
import path from "node:path";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  me: vi.fn(),
  resolveWorkspaceId: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    mocks.createClient(options);
    return {
      me: mocks.me,
      workspaces: mocks.workspaces,
    };
  },
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: mocks.resolveWorkspaceId,
}));

import { clickClackSetupPlugin } from "./channel.setup.js";
import { clickClackSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const configuredAccount = {
  channels: {
    clickclack: {
      baseUrl: "https://clickclack.example",
      token: "ccb_test",
      workspace: "default",
    },
  },
} satisfies CoreConfig;

function tokenCredential() {
  const credential = clickClackSetupWizard.credentials[0];
  if (!credential) {
    throw new Error("expected ClickClack token credential");
  }
  return credential;
}

describe("ClickClack setup wizard", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    mocks.me.mockReset();
    mocks.resolveWorkspaceId.mockReset();
    mocks.workspaces.mockReset();
    mocks.me.mockResolvedValue({ id: "usr_bot", handle: "openclaw" });
    mocks.resolveWorkspaceId.mockResolvedValue("wsp_default");
    mocks.workspaces.mockResolvedValue([
      { id: "wsp_default", name: "Default", slug: "default", created_at: "2026-01-01" },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects configured accounts and inspects plain, env, and file credentials", async () => {
    expect(await clickClackSetupWizard.status.resolveConfigured({ cfg: configuredAccount })).toBe(
      true,
    );

    const credential = tokenCredential();
    expect(
      credential.inspect({
        cfg: configuredAccount,
        accountId: "default",
      }),
    ).toMatchObject({
      accountConfigured: true,
      hasConfiguredValue: true,
      resolvedValue: "ccb_test",
    });

    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "ccb_env");
    expect(
      credential.inspect({
        cfg: {
          channels: {
            clickclack: {
              baseUrl: "https://clickclack.example",
              workspace: "default",
            },
          },
        } as CoreConfig,
        accountId: "default",
      }),
    ).toMatchObject({
      accountConfigured: true,
      hasConfiguredValue: false,
      resolvedValue: "ccb_env",
      envValue: "ccb_env",
    });

    await withTempDir("clickclack-setup-token-", async (tempDir) => {
      const tokenFile = path.join(tempDir, "token");
      fs.writeFileSync(tokenFile, "ccb_file\n", "utf8");
      expect(
        credential.inspect({
          cfg: {
            channels: {
              clickclack: {
                baseUrl: "https://clickclack.example",
                tokenFile,
                workspace: "default",
              },
            },
          } as CoreConfig,
          accountId: "default",
        }),
      ).toMatchObject({
        accountConfigured: true,
        hasConfiguredValue: true,
        resolvedValue: "ccb_file",
      });
    });

    const secretRefAccount = {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          token: { source: "file", provider: "vault", id: "/clickclack/token" },
          workspace: "default",
        },
      },
    } satisfies CoreConfig;
    expect(await clickClackSetupWizard.status.resolveConfigured({ cfg: secretRefAccount })).toBe(
      true,
    );
    expect(
      credential.inspect({
        cfg: secretRefAccount,
        accountId: "default",
      }),
    ).toMatchObject({
      accountConfigured: true,
      hasConfiguredValue: true,
      resolvedValue: undefined,
    });
    expect(
      clickClackSetupWizard.introNote?.shouldShow?.({
        cfg: secretRefAccount,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe(false);
  });

  it("switches the default account to env auth before URL and workspace prompts", async () => {
    const credential = tokenCredential();
    const next = await credential.applyUseEnv?.({
      cfg: {
        channels: {
          clickclack: {
            baseUrl: "https://clickclack.example",
            token: "ccb_stale",
            tokenFile: "/run/secrets/stale",
            workspace: "default",
          },
        },
      } as CoreConfig,
      accountId: "default",
    });

    expect(next?.channels?.clickclack).not.toHaveProperty("token");
    expect(next?.channels?.clickclack).not.toHaveProperty("tokenFile");
    expect(next?.channels?.clickclack).toMatchObject({
      baseUrl: "https://clickclack.example",
      workspace: "default",
    });
  });

  it("saves URL, token, and workspace through the guided flow", async () => {
    const queued = createQueuedWizardPrompter({
      textValues: ["ccb_guided", "https://clickclack.example/", "default"],
    });

    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(clickClackSetupPlugin),
      cfg: {} as CoreConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.clickclack).toMatchObject({
      enabled: true,
      token: "ccb_guided",
      baseUrl: "https://clickclack.example",
      workspace: "default",
    });
    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(mocks.resolveWorkspaceId).toHaveBeenCalledTimes(1);
  });

  it("reports the resolved bot and workspace after live validation", async () => {
    const note = vi.fn(async () => undefined);

    await runSetupWizardFinalize({
      finalize: clickClackSetupWizard.finalize,
      cfg: configuredAccount,
      prompter: createTestWizardPrompter({ note }),
    });

    expect(mocks.me.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveWorkspaceId.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(note).toHaveBeenCalledWith(
      "Connected as @openclaw — workspace Default resolved.",
      "ClickClack connection",
    );
  });

  it("uses the resolved setup credential for live validation", async () => {
    await runSetupWizardFinalize({
      finalize: clickClackSetupWizard.finalize,
      cfg: {
        channels: {
          clickclack: {
            baseUrl: "https://clickclack.example",
            token: { source: "file", provider: "vault", id: "/clickclack/token" },
            workspace: "default",
          },
        },
      } satisfies CoreConfig,
      credentialValues: { token: "ccb_resolved" },
    });

    expect(mocks.createClient).toHaveBeenCalledWith({
      baseUrl: "https://clickclack.example",
      token: "ccb_resolved",
    });
  });

  it("keeps setup saved when the token is rejected", async () => {
    mocks.me.mockRejectedValue({ status: 401 });
    const note = vi.fn(async () => undefined);

    await expect(
      runSetupWizardFinalize({
        finalize: clickClackSetupWizard.finalize,
        cfg: configuredAccount,
        prompter: createTestWizardPrompter({ note }),
      }),
    ).resolves.toBeUndefined();
    expect(note).toHaveBeenCalledWith(
      "ClickClack rejected the bot token (401). Copy a current token and rerun setup.",
      "ClickClack connection check",
    );
  });

  it("keeps setup saved when workspace resolution fails", async () => {
    mocks.resolveWorkspaceId.mockResolvedValue("wsp_missing");
    mocks.workspaces.mockResolvedValue([]);
    const note = vi.fn(async () => undefined);

    await expect(
      runSetupWizardFinalize({
        finalize: clickClackSetupWizard.finalize,
        cfg: {
          channels: {
            clickclack: {
              ...configuredAccount.channels.clickclack,
              workspace: "wsp_missing",
            },
          },
        },
        prompter: createTestWizardPrompter({ note }),
      }),
    ).resolves.toBeUndefined();
    expect(note).toHaveBeenCalledWith(
      'Workspace "wsp_missing" was not found. Check the id, slug, or name, list available workspaces, and rerun setup.',
      "ClickClack connection check",
    );
  });

  it("keeps setup saved when the server is unreachable", async () => {
    mocks.me.mockRejectedValue(new Error("network unavailable"));
    const note = vi.fn(async () => undefined);

    await expect(
      runSetupWizardFinalize({
        finalize: clickClackSetupWizard.finalize,
        cfg: configuredAccount,
        prompter: createTestWizardPrompter({ note }),
      }),
    ).resolves.toBeUndefined();
    expect(note).toHaveBeenCalledWith(
      "Connection check failed: network unavailable. Setup was saved; fix the connection and rerun setup.",
      "ClickClack connection check",
    );
  });
});
