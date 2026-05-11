import { describe, expect, it, vi } from "vitest";
import { matrixOnboardingAdapter } from "./onboarding.js";
import {
  createConfiguredMatrixDefaultAccountConfig,
  createConfiguredMatrixTopLevelConfig,
  createMatrixEnvShortcutAddAccountPrompter,
  createMatrixNamedAccountsConfig,
  createLegacyMatrixTopLevelConfig,
  installMatrixScopedEnvShortcut,
  createMatrixTokenAddAccountPrompter,
  createMatrixUpdateKeepCredentialsPrompter,
  installMatrixOnboardingEnvRestoreHooks,
  createMatrixWizardPrompter,
  runMatrixAddAccountAllowlistConfigure,
  runMatrixInteractiveConfigure,
} from "./onboarding.test-harness.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

vi.mock("./matrix/deps.js", () => ({
  ensureMatrixSdkInstalled: vi.fn(async () => {}),
  isMatrixSdkAvailable: vi.fn(() => true),
}));

describe("matrix onboarding", () => {
  installMatrixOnboardingEnvRestoreHooks();

  it("offers env shortcut for non-default account when scoped env vars are present", async () => {
    installMatrixTestRuntime();
    installMatrixScopedEnvShortcut();

    const confirmMessages: string[] = [];
    const prompter = createMatrixEnvShortcutAddAccountPrompter({
      onConfirm: (message) => {
        confirmMessages.push(message);
        return message.startsWith("Matrix env vars detected");
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: createConfiguredMatrixDefaultAccountConfig(),
      prompter,
      shouldPromptAccountIds: true,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result !== "skip") {
      const opsAccount = result.cfg.channels?.["matrix"]?.accounts?.ops as
        | {
            enabled?: boolean;
            homeserver?: string;
            accessToken?: string;
          }
        | undefined;
      expect(result.accountId).toBe("ops");
      expect(opsAccount?.enabled).toBe(true);
      expect(opsAccount?.homeserver).toBeUndefined();
      expect(opsAccount?.accessToken).toBeUndefined();
    }
    expect(
      confirmMessages.some((message) =>
        message.startsWith(
          "Matrix env vars detected (MATRIX_OPS_HOMESERVER (+ auth vars)). Use env values?",
        ),
      ),
    ).toBe(true);
  });

  it("routes env-shortcut add-account flow through Matrix invite auto-join setup", async () => {
    installMatrixTestRuntime();
    installMatrixScopedEnvShortcut();

    const notes: string[] = [];
    const prompter = createMatrixEnvShortcutAddAccountPrompter({
      notes,
      select: {
        "Matrix rooms access": "allowlist",
        "Matrix invite auto-join": "allowlist",
      },
      text: {
        "Matrix rooms allowlist (comma-separated)": "!ops-room:example.org",
        "Matrix invite auto-join allowlist (comma-separated)": "#ops-invites:example.org",
      },
      confirm: {
        "Configure Matrix rooms access?": true,
        "Configure Matrix invite auto-join?": true,
      },
      onConfirm: (message) => message.startsWith("Matrix env vars detected"),
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: createConfiguredMatrixDefaultAccountConfig(),
      prompter,
      shouldPromptAccountIds: true,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.accountId).toBe("ops");
    const opsAccount = result.cfg.channels?.matrix?.accounts?.ops;
    expect(opsAccount?.enabled).toBe(true);
    expect(opsAccount?.groupPolicy).toBe("allowlist");
    expect(opsAccount?.groups?.["!ops-room:example.org"]?.enabled).toBe(true);
    expect(opsAccount?.autoJoin).toBe("allowlist");
    expect(opsAccount?.autoJoinAllowlist).toEqual(["#ops-invites:example.org"]);
    expect(notes.join("\n")).toContain("WARNING: Matrix invite auto-join defaults to off.");
  });

  it("promotes legacy top-level Matrix config before adding a named account", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixTokenAddAccountPrompter();

    const result = await runMatrixInteractiveConfigure({
      cfg: createLegacyMatrixTopLevelConfig(),
      prompter,
      shouldPromptAccountIds: true,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.homeserver).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accessToken).toBeUndefined();
    expect(result.cfg.channels?.matrix?.avatarUrl).toBeUndefined();
    const defaultAccount = result.cfg.channels?.matrix?.accounts?.default;
    expect(defaultAccount?.homeserver).toBe("https://matrix.main.example.org");
    expect(defaultAccount?.userId).toBe("@main:example.org");
    expect(defaultAccount?.accessToken).toBe("main-token");
    expect(defaultAccount?.avatarUrl).toBe("mxc://matrix.main.example.org/main-avatar");
    const opsAccount = result.cfg.channels?.matrix?.accounts?.ops;
    expect(opsAccount?.name).toBe("ops");
    expect(opsAccount?.homeserver).toBe("https://matrix.ops.example.org");
    expect(opsAccount?.accessToken).toBe("ops-token");
  });

  it("reuses an existing raw default-like key during onboarding promotion when defaultAccount is unset", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixTokenAddAccountPrompter();

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        ...createLegacyMatrixTopLevelConfig(),
        channels: {
          matrix: {
            ...createLegacyMatrixTopLevelConfig().channels?.matrix,
            accounts: {
              Default: {
                enabled: true,
                deviceName: "Legacy raw key",
              },
              support: {
                homeserver: "https://matrix.support.example.org",
                accessToken: "support-token",
              },
            },
          },
        },
      } as CoreConfig,
      prompter,
      shouldPromptAccountIds: true,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    const defaultAccount = result.cfg.channels?.matrix?.accounts?.Default;
    expect(defaultAccount?.enabled).toBe(true);
    expect(defaultAccount?.deviceName).toBe("Legacy raw key");
    expect(defaultAccount?.homeserver).toBe("https://matrix.main.example.org");
    expect(defaultAccount?.userId).toBe("@main:example.org");
    expect(defaultAccount?.accessToken).toBe("main-token");
    expect(defaultAccount?.avatarUrl).toBe("mxc://matrix.main.example.org/main-avatar");
    expect(result.cfg.channels?.matrix?.accounts?.default).toBeUndefined();
    const supportAccount = result.cfg.channels?.matrix?.accounts?.support;
    expect(supportAccount?.homeserver).toBe("https://matrix.support.example.org");
    expect(supportAccount?.accessToken).toBe("support-token");
    const opsAccount = result.cfg.channels?.matrix?.accounts?.ops;
    expect(opsAccount?.name).toBe("ops");
    expect(opsAccount?.homeserver).toBe("https://matrix.ops.example.org");
    expect(opsAccount?.accessToken).toBe("ops-token");
  });

  it("includes device env var names in auth help text", async () => {
    installMatrixTestRuntime();

    const notes: string[] = [];
    const prompter = createMatrixWizardPrompter({
      notes,
      onText: async () => {
        throw new Error("stop-after-help");
      },
      onConfirm: async () => false,
      onSelect: async () => "token",
    });

    await expect(
      runMatrixInteractiveConfigure({
        cfg: { channels: {} } as CoreConfig,
        prompter,
      }),
    ).rejects.toThrow("stop-after-help");

    const noteText = notes.join("\n");
    expect(noteText).toContain("MATRIX_DEVICE_ID");
    expect(noteText).toContain("MATRIX_DEVICE_NAME");
    expect(noteText).toContain("MATRIX_<ACCOUNT_ID>_DEVICE_ID");
    expect(noteText).toContain("MATRIX_<ACCOUNT_ID>_DEVICE_NAME");
  });

  it("prompts for private-network access when onboarding an internal http homeserver", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixWizardPrompter({
      select: {
        "Matrix auth method": "token",
      },
      text: {
        "Matrix homeserver URL": "http://localhost.localdomain:8008",
        "Matrix access token": "ops-token",
        "Matrix device name (optional)": "",
      },
      confirm: {
        "Allow private/internal Matrix homeserver traffic for this account?": true,
        "Enable end-to-end encryption (E2EE)?": false,
      },
      onConfirm: async () => false,
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {} as CoreConfig,
      prompter,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    const matrixConfig = result.cfg.channels?.matrix;
    expect(matrixConfig?.homeserver).toBe("http://localhost.localdomain:8008");
    expect(matrixConfig?.network?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(matrixConfig?.accessToken).toBe("ops-token");
  });

  it("preserves SecretRef access tokens when keeping existing credentials", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_ACCESS_TOKEN = "env-token";

    const prompter = createMatrixUpdateKeepCredentialsPrompter();

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        ...createConfiguredMatrixTopLevelConfig({
          accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
        }),
        secrets: {
          defaults: {
            env: "default",
          },
        },
      } as CoreConfig,
      prompter,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.accessToken).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_ACCESS_TOKEN",
    });
  });

  it("resolves status using the overridden Matrix account", async () => {
    const status = await matrixOnboardingAdapter.getStatus({
      cfg: createMatrixNamedAccountsConfig({
        defaultAccount: "default",
        accounts: {
          default: {
            homeserver: "https://matrix.default.example.org",
          },
          ops: {
            homeserver: "https://matrix.ops.example.org",
            accessToken: "ops-token",
          },
        },
      }),
      options: undefined,
      accountOverrides: {
        matrix: "ops",
      },
    });

    expect(status.configured).toBe(true);
    expect(status.selectionHint).toBe("configured");
    expect(status.statusLines).toEqual(["Matrix: configured"]);
  });

  it("writes allowlists and room access to the selected Matrix account", async () => {
    installMatrixTestRuntime();
    const notes: string[] = [];

    const result = await runMatrixAddAccountAllowlistConfigure({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.main.example.org",
                accessToken: "main-token",
              },
            },
          },
        },
      } as CoreConfig,
      allowFromInput: "@alice:example.org",
      roomsAllowlistInput: "!ops-room:example.org",
      autoJoinAllowlistInput: "#ops-invites:example.org",
      deviceName: "Ops Gateway",
      notes,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.accountId).toBe("ops");
    const opsAccount = result.cfg.channels?.["matrix"]?.accounts?.ops;
    expect(opsAccount?.homeserver).toBe("https://matrix.ops.example.org");
    expect(opsAccount?.accessToken).toBe("ops-token");
    expect(opsAccount?.deviceName).toBe("Ops Gateway");
    expect(opsAccount?.dm?.policy).toBe("allowlist");
    expect(opsAccount?.dm?.allowFrom).toEqual(["@alice:example.org"]);
    expect(opsAccount?.groupPolicy).toBe("allowlist");
    expect(opsAccount?.autoJoin).toBe("allowlist");
    expect(opsAccount?.autoJoinAllowlist).toEqual(["#ops-invites:example.org"]);
    expect(opsAccount?.groups?.["!ops-room:example.org"]?.enabled).toBe(true);
    expect(result.cfg.channels?.["matrix"]?.dm).toBeUndefined();
    expect(result.cfg.channels?.["matrix"]?.groups).toBeUndefined();
    expect(notes.join("\n")).toContain("WARNING: Matrix invite auto-join defaults to off.");
  });

  it("clears Matrix invite auto-join allowlists when switching auto-join off", async () => {
    installMatrixTestRuntime();
    const notes: string[] = [];

    const prompter = createMatrixUpdateKeepCredentialsPrompter({
      notes,
      inviteAutoJoin: "off",
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: createConfiguredMatrixTopLevelConfig({
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#ops:example.org"],
      }),
      prompter,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.autoJoin).toBe("off");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toBeUndefined();
    expect(notes.join("\n")).toContain("Matrix invite auto-join remains off.");
    expect(notes.join("\n")).toContain(
      "Agents will not join invited rooms or fresh DM-style invites until you change autoJoin.",
    );
  });

  it("re-prompts Matrix invite auto-join allowlists until entries are stable invite targets", async () => {
    installMatrixTestRuntime();
    const notes: string[] = [];
    let inviteAllowlistPrompts = 0;

    const prompter = createMatrixUpdateKeepCredentialsPrompter({
      notes,
      inviteAutoJoin: "allowlist",
      onText: async (message) => {
        if (message === "Matrix invite auto-join allowlist (comma-separated)") {
          inviteAllowlistPrompts += 1;
          return inviteAllowlistPrompts === 1 ? "Project Room" : "#ops:example.org";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: createConfiguredMatrixTopLevelConfig(),
      prompter,
      configured: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(inviteAllowlistPrompts).toBe(2);
    expect(result.cfg.channels?.matrix?.autoJoin).toBe("allowlist");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toEqual(["#ops:example.org"]);
    expect(notes.join("\n")).toContain(
      "Use only stable Matrix invite targets for auto-join: !roomId:server, #alias:server, or *.",
    );
    expect(notes.join("\n")).toContain("Invalid: Project Room");
  });

  it("reports account-scoped DM config keys for named accounts", () => {
    const resolveConfigKeys = matrixOnboardingAdapter.dmPolicy?.resolveConfigKeys;
    if (resolveConfigKeys === undefined) {
      throw new Error("expected matrix DM policy config-key resolver");
    }

    expect(
      resolveConfigKeys(
        createMatrixNamedAccountsConfig({
          accounts: {
            default: {
              homeserver: "https://matrix.main.example.org",
            },
            ops: {
              homeserver: "https://matrix.ops.example.org",
            },
          },
        }),
        "ops",
      ),
    ).toEqual({
      policyKey: "channels.matrix.accounts.ops.dm.policy",
      allowFromKey: "channels.matrix.accounts.ops.dm.allowFrom",
    });
  });

  it("reports configured when only the effective default Matrix account is configured", async () => {
    installMatrixTestRuntime();

    const status = await matrixOnboardingAdapter.getStatus({
      cfg: createMatrixNamedAccountsConfig({
        defaultAccount: "ops",
        accounts: {
          ops: {
            homeserver: "https://matrix.ops.example.org",
            accessToken: "ops-token",
          },
        },
      }),
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toContain("Matrix: configured");
    expect(status.selectionHint).toBe("configured");
  });

  it("asks for defaultAccount when multiple named Matrix accounts exist", async () => {
    installMatrixTestRuntime();

    const status = await matrixOnboardingAdapter.getStatus({
      cfg: createMatrixNamedAccountsConfig({
        accounts: {
          assistant: {
            homeserver: "https://matrix.assistant.example.org",
            accessToken: "assistant-token",
          },
          ops: {
            homeserver: "https://matrix.ops.example.org",
            accessToken: "ops-token",
          },
        },
      }),
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual([
      'Matrix: set "channels.matrix.defaultAccount" to select a named account',
    ]);
    expect(status.selectionHint).toBe("set defaultAccount");
  });
});
