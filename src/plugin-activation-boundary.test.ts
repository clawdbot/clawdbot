// Tests plugin activation boundaries during root package startup.
import { describe, expect, it, vi } from "vitest";
import { normalizeModelRef } from "./agents/model-ref-shared.js";
import { isStaticallyChannelConfigured } from "./config/channel-configured-shared.js";

const testModelIdNormalization = {
  providers: {
    google: {
      aliases: {
        "gemini-3.1-pro": "gemini-3.1-pro-preview",
        "gemini-3-pro-preview": "gemini-3.1-pro-preview",
      },
    },
    xai: {
      aliases: {
        "grok-4-fast-reasoning": "grok-4-fast",
      },
    },
  },
};

const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());

const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    diagnostics: [],
    plugins: [
      {
        id: "test-channel-fixture",
        channels: ["discord", "irc", "slack", "telegram"],
        providers: [],
        cliBackends: [],
        packageChannel: {
          id: "discord",
          configuredState: { env: { anyOf: ["DISCORD_BOT_TOKEN"] } },
        },
        modelIdNormalization: testModelIdNormalization,
        skills: [],
        hooks: [],
        origin: "bundled",
        rootDir: "/tmp/openclaw-test-channel-fixture",
        source: "bundled",
        manifestPath: "/tmp/openclaw-test-channel-fixture/openclaw.plugin.json",
      },
    ],
  })),
);

const facadeMockHelpers = vi.hoisted(() => {
  const createLazyFacadeObjectValue = <T extends object>(load: () => T): T =>
    new Proxy(
      {},
      {
        get(_target, property, receiver) {
          return Reflect.get(load(), property, receiver);
        },
      },
    ) as T;
  const createLazyFacadeArrayValue = <T extends readonly unknown[]>(load: () => T): T =>
    new Proxy([], {
      get(_target, property, receiver) {
        return Reflect.get(load(), property, receiver);
      },
    }) as unknown as T;
  return { createLazyFacadeArrayValue, createLazyFacadeObjectValue };
});

vi.mock("./plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshotWithMetadata: () => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  }),
}));

vi.mock("./secrets/channel-env-vars.js", () => ({
  getChannelEnvVars: (channelId: string) => {
    const varsByChannel: Record<string, string[]> = {
      discord: ["DISCORD_BOT_TOKEN"],
      irc: ["IRC_HOST", "IRC_NICK"],
      slack: ["SLACK_BOT_TOKEN"],
      telegram: ["TELEGRAM_BOT_TOKEN"],
    };
    return varsByChannel[channelId] ?? [];
  },
}));

vi.mock("./plugin-sdk/facade-loader.js", () => ({
  ...facadeMockHelpers,
  listImportedBundledPluginFacadeIds: () => [],
  loadBundledPluginPublicSurfaceModuleSyncCore,
  loadFacadeModuleAtLocationSync: vi.fn(),
  resetFacadeLoaderStateForTest: vi.fn(),
}));

vi.mock("./plugin-sdk/facade-runtime.js", () => ({
  ...facadeMockHelpers,
  testing: {},
  canLoadActivatedBundledPluginPublicSurface: () => true,
  listImportedBundledPluginFacadeIds: () => [],
  loadActivatedBundledPluginPublicSurfaceModuleSync: loadBundledPluginPublicSurfaceModuleSyncCore,
  loadBundledPluginPublicSurfaceModuleSyncCore,
  resetFacadeRuntimeStateForTest: vi.fn(),
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync:
    loadBundledPluginPublicSurfaceModuleSyncCore,
}));

describe("plugin activation boundary", () => {
  it("keeps generic channel and model-normalization boundaries cold", () => {
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReset();

    expect(isStaticallyChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(
      true,
    );
    expect(isStaticallyChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
    expect(isStaticallyChannelConfigured({}, "slack", { SLACK_BOT_TOKEN: "xoxb-test" })).toBe(true);
    expect(
      isStaticallyChannelConfigured({}, "irc", {
        IRC_HOST: "irc.example.com",
        IRC_NICK: "openclaw",
      }),
    ).toBe(true);
    expect(isStaticallyChannelConfigured({}, "whatsapp", {})).toBe(false);
    const staticNormalize = {
      allowPluginNormalization: false,
      manifestPlugins: [{ modelIdNormalization: testModelIdNormalization }],
    };
    expect(normalizeModelRef("google", "gemini-3.1-pro", staticNormalize)).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeModelRef("google", "gemini-3-pro-preview", staticNormalize)).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeModelRef("xai", "grok-4-fast-reasoning", staticNormalize)).toEqual({
      provider: "xai",
      model: "grok-4-fast",
    });
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
  });
});
