import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
  reloadChannelSetupPluginRegistry,
} from "../commands/channel-setup/plugin-install.js";
import { getChannelSetupWizardAdapter } from "../commands/channel-setup/registry.js";
import type { ChannelSetupWizardAdapter } from "../commands/channel-setup/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn(),
}));

const manifestRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(() => ({ plugins: [], diagnostics: [] })),
}));

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(
    {
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      ...overrides,
    },
    { defaultSelect: "__done__" },
  );
}

function createUnexpectedPromptGuards() {
  return {
    multiselect: vi.fn(async () => {
      throw new Error("unexpected multiselect");
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    }) as unknown as WizardPrompter["text"],
  };
}

type SetupChannels = typeof import("./onboard-channels.js").setupChannels;
let setupChannels: SetupChannels;

type SetupChannelsOptions = Parameters<SetupChannels>[3];

function runSetupChannels(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
) {
  return setupChannels(cfg, createExitThrowingRuntime(), prompter, {
    skipConfirm: true,
    ...options,
  });
}

function createQuickstartTelegramSelect(options?: {
  configuredAction?: "skip";
  strictUnexpected?: boolean;
}) {
  return vi.fn(async ({ message }: { message: string }) => {
    if (message === "Select channel (QuickStart)") {
      return "telegram";
    }
    if (options?.configuredAction && message.includes("already configured")) {
      return options.configuredAction;
    }
    if (options?.strictUnexpected) {
      throw new Error(`unexpected select prompt: ${message}`);
    }
    return "__done__";
  });
}

function createUnexpectedQuickstartPrompter(select: WizardPrompter["select"]) {
  const { multiselect, text } = createUnexpectedPromptGuards();
  return {
    prompter: createPrompter({ select, multiselect, text }),
    multiselect,
    text,
  };
}

function createTelegramCfg(botToken: string, enabled?: boolean): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken,
        ...(typeof enabled === "boolean" ? { enabled } : {}),
      },
    },
  } as OpenClawConfig;
}

function createMSTeamsCatalogEntry(): ChannelPluginCatalogEntry {
  return {
    id: "external-chat",
    pluginId: "@openclaw/external-chat-plugin",
    meta: {
      id: "external-chat",
      label: "External Chat",
      selectionLabel: "External Chat",
      docsPath: "/channels/external-chat",
      blurb: "external chat channel",
    },
    install: {
      npmSpec: "@openclaw/external-chat",
    },
  };
}

function setMinimalOnboardingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          setup: {
            applyAccountConfig: ({
              cfg,
              input,
            }: {
              cfg: OpenClawConfig;
              input: { token?: string };
            }) =>
              ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  telegram: {
                    ...(cfg.channels?.telegram as Record<string, unknown> | undefined),
                    ...(input.token ? { botToken: input.token } : {}),
                  },
                },
              }) as OpenClawConfig,
          },
          setupWizard: {
            channel: "telegram",
            status: {
              configuredLabel: "configured",
              unconfiguredLabel: "not configured",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean(cfg.channels?.telegram?.botToken),
            },
            credentials: [
              {
                inputKey: "token",
                providerHint: "BotFather",
                credentialLabel: "Telegram bot token",
                envPrompt: "Use TELEGRAM_BOT_TOKEN from env?",
                keepPrompt: "Keep current Telegram bot token?",
                inputPrompt: "Enter Telegram bot token",
                inspect: ({ cfg }: { cfg: OpenClawConfig }) => ({
                  accountConfigured: Boolean(cfg.channels?.telegram?.botToken),
                  hasConfiguredValue: Boolean(cfg.channels?.telegram?.botToken),
                }),
              },
            ],
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "whatsapp",
            label: "WhatsApp",
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          setup: {
            applyAccountConfig: ({
              cfg,
              input,
            }: {
              cfg: OpenClawConfig;
              input: { account?: string; name?: string };
            }) =>
              ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  whatsapp: {
                    ...(cfg.channels?.whatsapp as Record<string, unknown> | undefined),
                    ...(input.account ? { account: input.account } : {}),
                    ...(input.name ? { name: input.name } : {}),
                    linked: false,
                  },
                },
              }) as OpenClawConfig,
          },
          setupWizard: {
            channel: "whatsapp",
            status: {
              configuredLabel: "configured",
              unconfiguredLabel: "not linked",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean((cfg.channels?.whatsapp as { account?: string } | undefined)?.account),
              resolveSelectionHint: async ({ cfg }: { cfg: OpenClawConfig }) =>
                (cfg.channels?.whatsapp as { account?: string } | undefined)?.account
                  ? "configured"
                  : "not linked",
            },
            credentials: [],
            textInputs: [
              {
                inputKey: "account",
                message: "Your personal WhatsApp number",
                required: true,
                applySet: ({ cfg, value }: { cfg: OpenClawConfig; value: string }) =>
                  ({
                    ...cfg,
                    channels: {
                      ...cfg.channels,
                      whatsapp: {
                        ...(cfg.channels?.whatsapp as Record<string, unknown> | undefined),
                        account: value,
                      },
                    },
                  }) as OpenClawConfig,
              },
            ],
          },
        },
      },
    ]),
  );
}

type ChannelSetupWizardAdapterPatch = Partial<
  Pick<
    ChannelSetupWizardAdapter,
    | "afterConfigWritten"
    | "configure"
    | "configureInteractive"
    | "configureWhenConfigured"
    | "getStatus"
  >
>;

type PatchedSetupAdapterFields = {
  afterConfigWritten?: ChannelSetupWizardAdapter["afterConfigWritten"];
  configure?: ChannelSetupWizardAdapter["configure"];
  configureInteractive?: ChannelSetupWizardAdapter["configureInteractive"];
  configureWhenConfigured?: ChannelSetupWizardAdapter["configureWhenConfigured"];
  getStatus?: ChannelSetupWizardAdapter["getStatus"];
};

function createMSTeamsPluginRegistryEntry(params?: { includeSetupWizard?: boolean }) {
  return {
    pluginId: "@openclaw/external-chat-plugin",
    source: "test",
    plugin: {
      id: "external-chat",
      meta: createMSTeamsCatalogEntry().meta,
      capabilities: { chatTypes: ["direct"] as const },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      ...(params?.includeSetupWizard
        ? {
            setupWizard: {
              channel: "external-chat",
              status: {
                configuredLabel: "configured",
                unconfiguredLabel: "installed",
                resolveConfigured: () => false,
                resolveStatusLines: async () => [],
                resolveSelectionHint: async () => "installed",
              },
              credentials: [],
            },
          }
        : {}),
      outbound: { deliveryMode: "direct" as const },
    },
  };
}

function mockMSTeamsRegistrySnapshot(params?: { includeSetupWizard?: boolean }) {
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockImplementation(
    ({ channel }: { channel: string }) => {
      const registry = createEmptyPluginRegistry();
      if (channel === "external-chat") {
        if (params?.includeSetupWizard) {
          registry.channelSetups.push(createMSTeamsPluginRegistryEntry(params) as never);
        } else {
          registry.channels.push(createMSTeamsPluginRegistryEntry(params) as never);
        }
      }
      return registry;
    },
  );
}

function patchTelegramAdapter(overrides: ChannelSetupWizardAdapterPatch) {
  const adapter = getChannelSetupWizardAdapter("telegram");
  if (!adapter) {
    throw new Error("missing setup adapter for telegram");
  }

  const patch = {
    ...overrides,
    getStatus:
      overrides.getStatus ??
      vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
  };
  const previous: PatchedSetupAdapterFields = {};

  if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
    previous.getStatus = adapter.getStatus;
    adapter.getStatus = patch.getStatus ?? adapter.getStatus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "afterConfigWritten")) {
    previous.afterConfigWritten = adapter.afterConfigWritten;
    adapter.afterConfigWritten = patch.afterConfigWritten;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
    previous.configure = adapter.configure;
    adapter.configure = patch.configure ?? adapter.configure;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
    previous.configureInteractive = adapter.configureInteractive;
    adapter.configureInteractive = patch.configureInteractive;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
    previous.configureWhenConfigured = adapter.configureWhenConfigured;
    adapter.configureWhenConfigured = patch.configureWhenConfigured;
  }

  return () => {
    if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
      adapter.getStatus = previous.getStatus!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "afterConfigWritten")) {
      adapter.afterConfigWritten = previous.afterConfigWritten;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
      adapter.configure = previous.configure!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
      adapter.configureInteractive = previous.configureInteractive;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
      adapter.configureWhenConfigured = previous.configureWhenConfigured;
    }
  };
}

function createUnexpectedConfigureCall(message: string) {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

async function runConfiguredTelegramSetup(params: {
  strictUnexpected?: boolean;
  configureWhenConfigured: NonNullable<
    Parameters<typeof patchTelegramAdapter>[0]["configureWhenConfigured"]
  >;
  configureErrorMessage: string;
}) {
  const select = createQuickstartTelegramSelect({ strictUnexpected: params.strictUnexpected });
  const selection = vi.fn();
  const onAccountId = vi.fn();
  const configure = createUnexpectedConfigureCall(params.configureErrorMessage);
  const restore = patchTelegramAdapter({
    configureInteractive: undefined,
    configureWhenConfigured: params.configureWhenConfigured,
    configure,
  });
  const { prompter } = createUnexpectedQuickstartPrompter(
    select as unknown as WizardPrompter["select"],
  );

  try {
    const cfg = await runSetupChannels(createTelegramCfg("old-token"), prompter, {
      quickstartDefaults: true,
      onSelection: selection,
      onAccountId,
    });
    return { cfg, selection, onAccountId, configure };
  } finally {
    restore();
  }
}

async function runQuickstartTelegramSetupWithInteractive(params: {
  configureInteractive: NonNullable<
    Parameters<typeof patchTelegramAdapter>[0]["configureInteractive"]
  >;
  configure?: NonNullable<Parameters<typeof patchTelegramAdapter>[0]["configure"]>;
}) {
  const select = createQuickstartTelegramSelect();
  const selection = vi.fn();
  const onAccountId = vi.fn();
  const restore = patchTelegramAdapter({
    configureInteractive: params.configureInteractive,
    ...(params.configure ? { configure: params.configure } : {}),
  });
  const { prompter } = createUnexpectedQuickstartPrompter(
    select as unknown as WizardPrompter["select"],
  );

  try {
    const cfg = await runSetupChannels({} as OpenClawConfig, prompter, {
      quickstartDefaults: true,
      onSelection: selection,
      onAccountId,
    });
    return { cfg, selection, onAccountId };
  } finally {
    restore();
  }
}

vi.mock("node:fs/promises", () => ({
  default: {
    access: vi.fn(async () => {
      throw new Error("ENOENT");
    }),
  },
}));

vi.mock("../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/catalog.js")>(
    "../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    listChannelPluginCatalogEntries: ((...args) => {
      const implementation = catalogMocks.listChannelPluginCatalogEntries.getMockImplementation();
      if (implementation) {
        return catalogMocks.listChannelPluginCatalogEntries(...args);
      }
      return actual.listChannelPluginCatalogEntries(...args);
    }) as typeof actual.listChannelPluginCatalogEntries,
  };
});

vi.mock("../plugins/manifest-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/manifest-registry.js")>(
    "../plugins/manifest-registry.js",
  );
  return {
    ...actual,
    loadPluginManifestRegistry: manifestRegistryMocks.loadPluginManifestRegistry,
  };
});

vi.mock("../plugin-sdk/matrix-deps.js", () => ({
  ensureMatrixSdkInstalled: vi.fn(async () => {}),
  isMatrixSdkAvailable: vi.fn(() => true),
}));

vi.mock("../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: (channel: string) =>
    channel === "telegram"
      ? {
          id: "telegram",
          meta: {
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
            docsPath: "/channels/telegram",
            blurb: "test stub.",
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
          setup: {
            applyAccountConfig: ({
              cfg,
              input,
            }: {
              cfg: OpenClawConfig;
              input: { token?: string };
            }) =>
              ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  telegram: {
                    ...(cfg.channels?.telegram as Record<string, unknown> | undefined),
                    ...(input.token ? { botToken: input.token } : {}),
                  },
                },
              }) as OpenClawConfig,
          },
          setupWizard: {
            channel: "telegram",
            status: {
              configuredLabel: "configured",
              unconfiguredLabel: "not configured",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean(cfg.channels?.telegram?.botToken),
            },
            credentials: [
              {
                inputKey: "token",
                providerHint: "BotFather",
                credentialLabel: "Telegram bot token",
                envPrompt: "Use TELEGRAM_BOT_TOKEN from env?",
                keepPrompt: "Keep current Telegram bot token?",
                inputPrompt: "Enter Telegram bot token",
                inspect: ({ cfg }: { cfg: OpenClawConfig }) => ({
                  accountConfigured: Boolean(cfg.channels?.telegram?.botToken),
                  hasConfiguredValue: Boolean(cfg.channels?.telegram?.botToken),
                }),
              },
            ],
          },
        }
      : undefined,
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary: vi.fn(async () => false),
}));

vi.mock("../commands/channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual("../commands/channel-setup/plugin-install.js");
  return {
    ...(actual as Record<string, unknown>),
    ensureChannelSetupPluginInstalled: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      installed: true,
    })),
    // Allow tests to simulate an empty plugin registry during setup.
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(() => createEmptyPluginRegistry()),
    reloadChannelSetupPluginRegistry: vi.fn(() => {}),
  };
});

describe("setupChannels", () => {
  beforeEach(async () => {
    ({ setupChannels } = await import("./onboard-channels.js"));
    setMinimalOnboardingRegistryForTests();
    catalogMocks.listChannelPluginCatalogEntries.mockReset();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    manifestRegistryMocks.loadPluginManifestRegistry.mockReset();
    manifestRegistryMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(reloadChannelSetupPluginRegistry).mockClear();
  });
  it("continues Telegram setup when the plugin registry is empty", async () => {
    // Simulate missing registry entries (the scenario reported in #25545).
    setActivePluginRegistry(createEmptyPluginRegistry());
    // Avoid accidental env-token configuration changing the prompt path.
    process.env.TELEGRAM_BOT_TOKEN = "";

    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      return "__done__";
    });
    const text = vi.fn(async () => "123:token");

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      text: text as unknown as WizardPrompter["text"],
    });

    const cfg = await runSetupChannels({} as OpenClawConfig, prompter, {
      quickstartDefaults: true,
    });

    // The new flow should not stop setup with a hard "plugin not available" note.
    const sawHardStop = note.mock.calls.some((call) => {
      const message = call[0];
      const title = call[1];
      return (
        title === "Channel setup" && String(message).trim() === "telegram plugin not available."
      );
    });
    expect(sawHardStop).toBe(false);
    expect(cfg.channels?.telegram?.botToken).toBe("123:token");
    expect(reloadChannelSetupPluginRegistry).not.toHaveBeenCalled();
  });

  it("shows explicit dmScope config command in channel primer", async () => {
    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const select = vi.fn(async () => "__done__");
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    const sawPrimer = note.mock.calls.some(
      ([message, title]) =>
        title === "How channels work" &&
        String(message).includes('config set session.dmScope "per-channel-peer"'),
    );
    expect(sawPrimer).toBe(true);
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("does not render undefined primer lines for malformed external setup plugins", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "external-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "external-chat",
              label: "External Chat",
              docsPath: "/channels/external-chat",
            }),
            meta: {
              id: "external-chat",
            },
          },
        },
      ]),
    );

    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const select = vi.fn(async () => "__done__");
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    const primerMessage =
      note.mock.calls.find(([, title]) => title === "How channels work")?.[0] ?? "";
    expect(primerMessage).toContain("external-chat:");
    expect(primerMessage).not.toContain("undefined: undefined");
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("keeps malformed external setup plugins selectable without undefined labels", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "external-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "external-chat",
              label: "External Chat",
              docsPath: "/channels/external-chat",
            }),
            meta: {
              id: "external-chat",
            },
          },
        },
      ]),
    );

    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const { multiselect, text } = createUnexpectedPromptGuards();
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        const external = (options as Array<{ value: string; label?: string; hint?: string }>).find(
          (entry) => entry.value === "external-chat",
        );
        expect(external?.label).toBe("external-chat");
        expect(external?.hint ?? "").not.toContain("undefined");
        return "__done__";
      }
      return "__done__";
    });

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("keeps the channel picker usable when the active registry contains broken sibling diagnostics", async () => {
    const registry = createTestRegistry([
      {
        pluginId: "healthy-channel",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "external-chat",
            label: "Healthy Chat",
            docsPath: "/channels/external-chat",
          }),
        },
      },
    ]);
    registry.diagnostics.push({
      level: "error",
      pluginId: "broken-channel",
      source: "/tmp/broken-channel/setup-entry.cjs",
      message: "failed to load setup entry: boom: setup plugin missing",
    });
    setActivePluginRegistry(registry);

    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const { multiselect, text } = createUnexpectedPromptGuards();
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        const entries = options as Array<{ value: string; label?: string }>;
        expect(entries.find((entry) => entry.value === "external-chat")?.label).toBe(
          "Healthy Chat",
        );
        expect(entries.some((entry) => entry.value === "broken-channel")).toBe(false);
        return "__done__";
      }
      return "__done__";
    });

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(
      note.mock.calls.some((call) =>
        (call[0] ?? "").includes("broken-channel plugin not available"),
      ),
    ).toBe(false);
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("keeps configured external plugin channels visible when the active registry starts empty", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([createMSTeamsCatalogEntry()]);
    mockMSTeamsRegistrySnapshot();
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        const entries = options as Array<{ value: string; hint?: string }>;
        const msteams = entries.find((entry) => entry.value === "external-chat");
        expect(msteams).toBeDefined();
        expect(msteams?.hint ?? "").not.toContain("plugin");
        expect(msteams?.hint ?? "").not.toContain("install");
        return "__done__";
      }
      return "__done__";
    });
    const { multiselect, text } = createUnexpectedPromptGuards();
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels(
      {
        channels: {
          "external-chat": {
            tenantId: "tenant-1",
          },
        },
        plugins: {
          entries: {
            "@openclaw/external-chat-plugin": { enabled: true },
          },
        },
      } as OpenClawConfig,
      prompter,
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "external-chat",
        pluginId: "@openclaw/external-chat-plugin",
      }),
    );
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("hides channels marked hidden from setup in the picker", async () => {
    const qaChannelBase = createChannelTestPluginBase({
      id: "qa-channel",
      label: "QA Channel",
      docsPath: "/channels/qa-channel",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "qa-channel",
          source: "test",
          plugin: {
            ...qaChannelBase,
            meta: {
              ...qaChannelBase.meta,
              showInSetup: false,
            },
          },
        },
      ]),
    );

    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        expect(
          (options as Array<{ label?: string }>).some((option) =>
            option.label?.includes("QA Channel"),
          ),
        ).toBe(false);
      }
      return "__done__";
    });
    const { multiselect, text } = createUnexpectedPromptGuards();
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("treats installed external plugin channels as installed without reinstall prompts", async () => {
    setActivePluginRegistry(
      createTestRegistry([createMSTeamsPluginRegistryEntry({ includeSetupWizard: true }) as never]),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([createMSTeamsCatalogEntry()]);

    let channelSelectionCount = 0;
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select a channel") {
        channelSelectionCount += 1;
        return channelSelectionCount === 1 ? "external-chat" : "__done__";
      }
      return "__done__";
    });
    const { multiselect, text } = createUnexpectedPromptGuards();
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("uses scoped plugin accounts when disabling a configured external channel", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const setAccountEnabled = vi.fn(
      ({
        cfg,
        accountId,
        enabled,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        enabled: boolean;
      }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          "external-chat": {
            ...(cfg.channels?.["external-chat"] as Record<string, unknown> | undefined),
            accounts: {
              ...(
                cfg.channels?.["external-chat"] as
                  | { accounts?: Record<string, unknown> }
                  | undefined
              )?.accounts,
              [accountId]: {
                ...(
                  cfg.channels?.["external-chat"] as
                    | {
                        accounts?: Record<string, Record<string, unknown>>;
                      }
                    | undefined
                )?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      }),
    );
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockImplementation(
      ({ channel }: { channel: string }) => {
        const registry = createEmptyPluginRegistry();
        if (channel === "external-chat") {
          registry.channels.push({
            pluginId: "external-chat",
            source: "test",
            plugin: {
              id: "external-chat",
              meta: {
                id: "external-chat",
                label: "External Chat",
                selectionLabel: "External Chat",
                docsPath: "/channels/external-chat",
                blurb: "external chat channel",
              },
              capabilities: { chatTypes: ["direct"] },
              config: {
                listAccountIds: (cfg: OpenClawConfig) =>
                  Object.keys(
                    (
                      cfg.channels?.["external-chat"] as
                        | { accounts?: Record<string, unknown> }
                        | undefined
                    )?.accounts ?? {},
                  ),
                resolveAccount: (cfg: OpenClawConfig, accountId: string) =>
                  (
                    cfg.channels?.["external-chat"] as
                      | {
                          accounts?: Record<string, Record<string, unknown>>;
                        }
                      | undefined
                  )?.accounts?.[accountId] ?? { accountId },
                setAccountEnabled,
              },
              setupWizard: {
                channel: "external-chat",
                status: {
                  configuredLabel: "configured",
                  unconfiguredLabel: "needs setup",
                  resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                    Boolean(
                      (cfg.channels?.["external-chat"] as { tenantId?: string } | undefined)
                        ?.tenantId,
                    ),
                  resolveStatusLines: async () => [],
                  resolveSelectionHint: async () => "configured",
                },
                credentials: [],
              },
              outbound: { deliveryMode: "direct" },
            },
          } as never);
        }
        return registry;
      },
    );

    let channelSelectionCount = 0;
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        channelSelectionCount += 1;
        return channelSelectionCount === 1 ? "external-chat" : "__done__";
      }
      if (message.includes("already configured")) {
        return "disable";
      }
      if (message === "External Chat account") {
        const accountOptions = options as Array<{ value: string; label: string }>;
        expect(accountOptions.map((option) => option.value)).toEqual(["default", "work"]);
        return "work";
      }
      return "__done__";
    });
    const { multiselect, text } = createUnexpectedPromptGuards();
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const next = await runSetupChannels(
      {
        channels: {
          "external-chat": {
            tenantId: "tenant-1",
            accounts: {
              default: { enabled: true },
              work: { enabled: true },
            },
          },
        },
        plugins: {
          entries: {
            "external-chat": { enabled: true },
          },
        },
      } as OpenClawConfig,
      prompter,
      { allowDisable: true },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "external-chat" }),
    );
    expect(setAccountEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "work", enabled: false }),
    );
    expect(
      (
        next.channels?.["external-chat"] as
          | {
              accounts?: Record<string, { enabled?: boolean }>;
            }
          | undefined
      )?.accounts?.work?.enabled,
    ).toBe(false);
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("prompts for configured channel action and skips configuration when told to skip", async () => {
    const select = createQuickstartTelegramSelect({
      configuredAction: "skip",
      strictUnexpected: true,
    });
    const { prompter, multiselect, text } = createUnexpectedQuickstartPrompter(
      select as unknown as WizardPrompter["select"],
    );

    await runSetupChannels(createTelegramCfg("token"), prompter, {
      quickstartDefaults: true,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("already configured") }),
    );
    expect(multiselect).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("adds disabled hint to channel selection when a channel is disabled", async () => {
    let selectionCount = 0;
    const select = vi.fn(async ({ message }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        selectionCount += 1;
        return selectionCount === 1 ? "telegram" : "__done__";
      }
      if (message.includes("already configured")) {
        return "skip";
      }
      return "__done__";
    });
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text: vi.fn(async () => "") as unknown as WizardPrompter["text"],
    });

    await runSetupChannels(createTelegramCfg("token", false), prompter);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    const channelSelectCall = select.mock.calls.find(
      ([params]) => (params as { message?: string }).message === "Select a channel",
    );
    const telegramOption = (
      channelSelectCall?.[0] as { options?: Array<{ value: string; hint?: string }> } | undefined
    )?.options?.find((opt) => opt.value === "telegram");
    expect(telegramOption?.hint).toContain("disabled");
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("uses configureInteractive skip without mutating selection/account state", async () => {
    const configureInteractive = vi.fn(async () => "skip" as const);
    const { cfg, selection, onAccountId } = await runQuickstartTelegramSetupWithInteractive({
      configureInteractive,
    });

    expect(configureInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ configured: false, label: expect.any(String) }),
    );
    expect(selection).toHaveBeenCalledWith([]);
    expect(onAccountId).not.toHaveBeenCalled();
    expect(cfg.channels?.telegram?.botToken).toBeUndefined();
  });

  it("applies configureInteractive result cfg/account updates", async () => {
    const configureInteractive = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: { ...cfg.channels?.telegram, botToken: "new-token" },
        },
      } as OpenClawConfig,
      accountId: "acct-1",
    }));
    const configure = createUnexpectedConfigureCall(
      "configure should not be called when configureInteractive is present",
    );
    const { cfg, selection, onAccountId } = await runQuickstartTelegramSetupWithInteractive({
      configureInteractive,
      configure,
    });

    expect(configureInteractive).toHaveBeenCalledTimes(1);
    expect(configure).not.toHaveBeenCalled();
    expect(selection).toHaveBeenCalledWith(["telegram"]);
    expect(onAccountId).toHaveBeenCalledWith("telegram", "acct-1");
    expect(cfg.channels?.telegram?.botToken).toBe("new-token");
  });

  it("uses configureWhenConfigured when channel is already configured", async () => {
    const configureWhenConfigured = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: { ...cfg.channels?.telegram, botToken: "updated-token" },
        },
      } as OpenClawConfig,
      accountId: "acct-2",
    }));
    const { cfg, selection, onAccountId, configure } = await runConfiguredTelegramSetup({
      configureWhenConfigured,
      configureErrorMessage:
        "configure should not be called when configureWhenConfigured handles updates",
    });

    expect(configureWhenConfigured).toHaveBeenCalledTimes(1);
    expect(configureWhenConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ configured: true, label: expect.any(String) }),
    );
    expect(configure).not.toHaveBeenCalled();
    expect(selection).toHaveBeenCalledWith(["telegram"]);
    expect(onAccountId).toHaveBeenCalledWith("telegram", "acct-2");
    expect(cfg.channels?.telegram?.botToken).toBe("updated-token");
  });

  it("respects configureWhenConfigured skip without mutating selection or account state", async () => {
    const configureWhenConfigured = vi.fn(async () => "skip" as const);
    const { cfg, selection, onAccountId, configure } = await runConfiguredTelegramSetup({
      strictUnexpected: true,
      configureWhenConfigured,
      configureErrorMessage: "configure should not run when configureWhenConfigured handles skip",
    });

    expect(configureWhenConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ configured: true, label: expect.any(String) }),
    );
    expect(configure).not.toHaveBeenCalled();
    expect(selection).toHaveBeenCalledWith([]);
    expect(onAccountId).not.toHaveBeenCalled();
    expect(cfg.channels?.telegram?.botToken).toBe("old-token");
  });

  it("prefers configureInteractive over configureWhenConfigured when both hooks exist", async () => {
    const select = createQuickstartTelegramSelect({ strictUnexpected: true });
    const selection = vi.fn();
    const onAccountId = vi.fn();
    const configureInteractive = vi.fn(async () => "skip" as const);
    const configureWhenConfigured = vi.fn(async () => {
      throw new Error("configureWhenConfigured should not run when configureInteractive exists");
    });
    const restore = patchTelegramAdapter({
      configureInteractive,
      configureWhenConfigured,
    });
    const { prompter } = createUnexpectedQuickstartPrompter(
      select as unknown as WizardPrompter["select"],
    );

    try {
      await runSetupChannels(createTelegramCfg("old-token"), prompter, {
        quickstartDefaults: true,
        onSelection: selection,
        onAccountId,
      });

      expect(configureInteractive).toHaveBeenCalledWith(
        expect.objectContaining({ configured: true, label: expect.any(String) }),
      );
      expect(configureWhenConfigured).not.toHaveBeenCalled();
      expect(selection).toHaveBeenCalledWith([]);
      expect(onAccountId).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
