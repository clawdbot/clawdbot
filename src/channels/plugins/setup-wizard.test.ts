import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSecretRef, type SecretInput } from "../../config/types.secrets.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "../../test-utils/plugin-setup-wizard.js";
import type { ChannelSetupPlugin, ChannelSetupWizard } from "./setup-wizard-types.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard.js";

type AccountConfig = {
  botId?: string;
  secret?: SecretInput;
  enabled?: boolean;
  marker?: { keep: string };
};

type ChannelConfig = AccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, AccountConfig>;
};

function getChannelConfig(cfg: OpenClawConfig): ChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.demo ?? {}) as ChannelConfig;
}

function resolveDefaultAccountId(cfg: OpenClawConfig): string {
  const channel = getChannelConfig(cfg);
  return normalizeAccountId(
    channel.defaultAccount ?? Object.keys(channel.accounts ?? {})[0] ?? DEFAULT_ACCOUNT_ID,
  );
}

function resolveLegacyAccount(cfg: OpenClawConfig): AccountConfig {
  const channel = getChannelConfig(cfg);
  return {
    ...channel,
    ...channel.accounts?.[resolveDefaultAccountId(cfg)],
  };
}

function setLegacyAccount(cfg: OpenClawConfig, patch: AccountConfig): OpenClawConfig {
  const channel = getChannelConfig(cfg);
  if (!channel.accounts) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        demo: { ...channel, ...patch },
      },
    } as OpenClawConfig;
  }
  const accountId = resolveDefaultAccountId(cfg);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      demo: {
        ...channel,
        accounts: {
          ...channel.accounts,
          [accountId]: {
            ...channel.accounts[accountId],
            ...patch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createLegacyPlugin(): ChannelSetupPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "demo",
      label: "Demo",
      config: {
        listAccountIds: (cfg) => {
          const ids = Object.keys(getChannelConfig(cfg).accounts ?? {});
          return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
        },
        defaultAccountId: resolveDefaultAccountId,
      },
    }),
    setup: {
      applyAccountConfig: ({ cfg, input }) =>
        setLegacyAccount(cfg, {
          botId: typeof input.token === "string" ? input.token : undefined,
          secret: typeof input.privateKey === "string" ? input.privateKey : undefined,
        }),
    },
  };
}

function createLegacyWizard(): ChannelSetupWizard {
  return {
    channel: "demo",
    status: {
      configuredLabel: "Configured",
      unconfiguredLabel: "Not configured",
      resolveConfigured: ({ cfg }) => Boolean(resolveLegacyAccount(cfg).botId),
    },
    supportsSharedCredentialInputMode: true,
    credentials: [
      {
        inputKey: "token",
        providerHint: "Demo",
        credentialLabel: "Bot ID",
        envPrompt: "Use Bot ID from environment?",
        keepPrompt: "Bot ID already configured. Keep it?",
        inputPrompt: "Bot ID",
        inspect: ({ cfg }) => {
          const botId = resolveLegacyAccount(cfg).botId;
          return {
            accountConfigured: Boolean(botId),
            hasConfiguredValue: Boolean(botId),
            resolvedValue: botId,
          };
        },
        applySet: ({ cfg, resolvedValue }) => setLegacyAccount(cfg, { botId: resolvedValue }),
      },
      {
        inputKey: "privateKey",
        providerHint: "Demo",
        credentialLabel: "Token",
        envPrompt: "Use token from environment?",
        keepPrompt: "Token already configured. Keep it?",
        inputPrompt: "Token",
        inspect: ({ cfg }) => {
          const secret = resolveLegacyAccount(cfg).secret;
          return {
            accountConfigured: Boolean(secret),
            hasConfiguredValue: Boolean(secret),
            resolvedValue: typeof secret === "string" ? secret : undefined,
          };
        },
        applySet: ({ cfg, value }) => {
          if (typeof value !== "string" && !isSecretRef(value)) {
            throw new Error("test invariant: expected credential input");
          }
          return setLegacyAccount(cfg, { secret: value });
        },
      },
    ],
  };
}

function createConfigure(wizard = createLegacyWizard()) {
  return buildChannelSetupWizardAdapterFromSetupWizard({
    plugin: createLegacyPlugin(),
    wizard,
  }).configure;
}

describe("channel setup wizard credential input", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("chooses one secret input mode for all credentials in the setup run", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["plaintext"],
      textValues: ["test-bot-id", "test-private-key"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {} as OpenClawConfig,
      prompter: queued.prompter,
    });

    expect(getChannelConfig(result.cfg)).toMatchObject({
      botId: "test-bot-id",
      secret: "test-private-key",
    });
    expect(queued.select).toHaveBeenCalledTimes(1);
    expect(queued.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "How do you want to provide these credentials?" }),
    );
  });

  it("allows each credential to override the shared input mode", async () => {
    vi.stubEnv("DEMO_PRIVATE_KEY", "test-private-key");
    const queued = createQueuedWizardPrompter({
      selectValues: ["per-credential", "plaintext", "ref", "env"],
      textValues: ["test-bot-id", "DEMO_PRIVATE_KEY"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {} as OpenClawConfig,
      prompter: queued.prompter,
    });

    expect(getChannelConfig(result.cfg)).toMatchObject({
      botId: "test-bot-id",
      secret: { source: "env", provider: "default", id: "DEMO_PRIVATE_KEY" },
    });
    expect(
      queued.select.mock.calls.map(([params]) => (params as { message: string }).message),
    ).toEqual([
      "How do you want to provide these credentials?",
      "How do you want to provide this Bot ID?",
      "How do you want to provide this Token?",
      "Where is this Token stored?",
    ]);
  });

  it("keeps a single active credential on its ordinary input-mode prompt", async () => {
    const wizard = createLegacyWizard();
    wizard.supportsSharedCredentialInputMode = false;
    const conditionalCredential = wizard.credentials[1];
    if (!conditionalCredential) {
      throw new Error("test invariant: expected a second credential");
    }
    conditionalCredential.shouldPrompt = () => false;
    const queued = createQueuedWizardPrompter({
      selectValues: ["plaintext"],
      textValues: ["test-bot-id"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(wizard),
      cfg: {} as OpenClawConfig,
      prompter: queued.prompter,
    });

    expect(getChannelConfig(result.cfg)).toMatchObject({ botId: "test-bot-id" });
    expect(getChannelConfig(result.cfg).secret).toBeUndefined();
    expect(queued.select).toHaveBeenCalledOnce();
    expect(queued.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "How do you want to provide this Bot ID?" }),
    );
  });
});

describe("channel setup wizard account scoping", () => {
  it("does not prefill or overwrite the existing account when adding a new account", async () => {
    const main = {
      botId: "test-main-bot-id",
      secret: "test-secret",
      enabled: false,
      marker: { keep: "byte-identical" },
    };
    const before = JSON.stringify(main);
    const queued = createQueuedWizardPrompter({
      selectValues: ["__new__"],
      textValues: ["alerts", "test-alerts-bot-id", "example-secret"],
      confirmValues: [false, false],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {
        channels: {
          demo: {
            enabled: true,
            defaultAccount: "main",
            accounts: { main },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      shouldPromptAccountIds: true,
      options: { secretInputMode: "plaintext" as const },
    });

    const channel = getChannelConfig(result.cfg);
    expect(result.accountId).toBe("alerts");
    expect(channel.defaultAccount).toBe("main");
    expect(JSON.stringify(channel.accounts?.main)).toBe(before);
    expect(channel.accounts?.alerts).toEqual({
      botId: "test-alerts-bot-id",
      secret: "example-secret",
    });
    expect(queued.confirm).not.toHaveBeenCalled();
  });

  it("promotes mixed root credentials before adding another named account", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["__new__"],
      textValues: ["alerts", "test-alerts-bot-id", "example-secret"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {
        channels: {
          demo: {
            defaultAccount: "main",
            botId: "test-main-bot-id",
            secret: "test-secret",
            accounts: { main: { marker: { keep: "mixed-shape" } } },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      shouldPromptAccountIds: true,
      options: { secretInputMode: "plaintext" as const },
    });

    const channel = getChannelConfig(result.cfg);
    expect(channel).not.toHaveProperty("botId");
    expect(channel).not.toHaveProperty("secret");
    expect(channel.defaultAccount).toBe("main");
    expect(channel.accounts).toEqual({
      main: {
        marker: { keep: "mixed-shape" },
        botId: "test-main-bot-id",
        secret: "test-secret",
      },
      alerts: { botId: "test-alerts-bot-id", secret: "example-secret" },
    });
    expect(queued.confirm).not.toHaveBeenCalled();
  });

  it("migrates stale root credentials when only an empty accounts map exists", async () => {
    const queued = createQueuedWizardPrompter({
      confirmValues: [false, false],
      textValues: ["test-new-bot-id", "mock-secret"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {
        channels: {
          demo: { botId: "test-stale-bot-id", secret: "fixture-secret", accounts: {} },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    const accountId = result.accountId;
    if (!accountId) {
      throw new Error("expected the wizard to resolve an account id");
    }
    const channel = getChannelConfig(result.cfg);
    expect(channel).not.toHaveProperty("botId");
    expect(channel).not.toHaveProperty("secret");
    expect(channel.accounts?.[accountId]).toEqual({
      botId: "test-new-bot-id",
      secret: "mock-secret",
    });
    expect(Object.keys(channel.accounts ?? {})).toEqual([accountId]);
  });

  it("replaces credentials only in the selected existing account after rejecting keep", async () => {
    const main = { botId: "test-main-bot-id", secret: "test-secret" };
    const before = JSON.stringify(main);
    const queued = createQueuedWizardPrompter({
      confirmValues: [false, false],
      textValues: ["test-new-bot-id", "mock-secret"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {
        channels: {
          demo: {
            defaultAccount: "main",
            accounts: {
              main,
              alerts: { botId: "test-old-bot-id", secret: "fixture-secret" },
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      accountOverrides: { demo: "alerts" },
      options: { secretInputMode: "plaintext" as const },
    });

    const channel = getChannelConfig(result.cfg);
    expect(channel.defaultAccount).toBe("main");
    expect(JSON.stringify(channel.accounts?.main)).toBe(before);
    expect(channel.accounts?.alerts).toEqual({
      botId: "test-new-bot-id",
      secret: "mock-secret",
    });
    expect(queued.confirm).toHaveBeenCalledTimes(2);
  });

  it("scopes a named default account when another account is the channel default", async () => {
    const main = { botId: "test-main-bot-id", secret: "test-secret" };
    const before = JSON.stringify(main);
    const queued = createQueuedWizardPrompter({
      confirmValues: [false, false],
      textValues: ["test-new-bot-id", "mock-secret"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {
        channels: {
          demo: {
            defaultAccount: "main",
            accounts: {
              default: { botId: "test-old-bot-id", secret: "fixture-secret" },
              main,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      accountOverrides: { demo: DEFAULT_ACCOUNT_ID },
      options: { secretInputMode: "plaintext" as const },
    });

    const channel = getChannelConfig(result.cfg);
    expect(channel.defaultAccount).toBe("main");
    expect(JSON.stringify(channel.accounts?.main)).toBe(before);
    expect(channel.accounts?.default).toEqual({
      botId: "test-new-bot-id",
      secret: "mock-secret",
    });
    expect(queued.confirm).toHaveBeenCalledTimes(2);
  });

  it("promotes root credentials before adding the first named account", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["__new__"],
      textValues: ["alerts", "test-alerts-bot-id", "example-secret"],
    });

    const result = await runSetupWizardConfigure({
      configure: createConfigure(),
      cfg: {
        channels: {
          demo: {
            enabled: true,
            botId: "test-main-bot-id",
            secret: "test-secret",
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      shouldPromptAccountIds: true,
      options: { secretInputMode: "plaintext" as const },
    });

    const channel = getChannelConfig(result.cfg);
    expect(channel).not.toHaveProperty("botId");
    expect(channel).not.toHaveProperty("secret");
    expect(channel).not.toHaveProperty("defaultAccount");
    expect(channel.accounts).toEqual({
      default: { botId: "test-main-bot-id", secret: "test-secret" },
      alerts: { botId: "test-alerts-bot-id", secret: "example-secret" },
    });
    expect(queued.confirm).not.toHaveBeenCalled();
  });
});
