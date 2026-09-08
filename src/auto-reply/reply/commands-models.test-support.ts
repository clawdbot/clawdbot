import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const telegramModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
  }),
  commands: {
    buildModelsProviderChannelData: ({ providers }) => ({
      telegram: {
        buttons: providers.map((provider) => [
          {
            text: provider.id,
            callback_data: `models:${provider.id}`,
          },
        ]),
      },
    }),
  },
};

const menuOnlyModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "menuonly",
    label: "Menu Only",
    capabilities: {
      chatTypes: ["direct"],
      nativeCommands: true,
    },
  }),
  commands: {
    buildModelsMenuChannelData: ({ providers }) => ({
      menuonly: {
        providerIds: providers.map((provider) => provider.id),
        labels: providers.map((provider) => `${provider.id}:${provider.count}`),
      },
    }),
  },
};

const textSurfaceModelsTestPlugins = (["discord", "whatsapp"] as const).map((id) => ({
  pluginId: id,
  plugin: createChannelTestPluginBase({ id }),
  source: "test",
}));

export function createModelsTestRegistry() {
  const registry = createTestRegistry([
    ...textSurfaceModelsTestPlugins,
    {
      pluginId: "telegram",
      plugin: telegramModelsTestPlugin,
      source: "test",
    },
    {
      pluginId: "menuonly",
      plugin: menuOnlyModelsTestPlugin,
      source: "test",
    },
  ]);
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      backend: {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
      },
      source: "test",
    },
    {
      pluginId: "google",
      backend: {
        id: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
      },
      source: "test",
    },
  ];
  return registry;
}

export function setFastModelsCliBackendDeps(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
      {
        id: "google-gemini-cli",
        pluginId: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
        bundleMcp: false,
      },
    ],
  });
}
