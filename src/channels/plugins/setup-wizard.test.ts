import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  secret?: string;
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
            resolvedValue: secret,
          };
        },
        applySet: ({ cfg, resolvedValue: secret }) => setLegacyAccount(cfg, { secret }),
      },
    ],
  };
}

function createConfigure() {
  return buildChannelSetupWizardAdapterFromSetupWizard({
    plugin: createLegacyPlugin(),
    wizard: createLegacyWizard(),
  }).configure;
}

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
