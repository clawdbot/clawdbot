import { describe, expect, it, vi } from "vitest";
import { normalizeModelRef } from "./agents/model-selection-normalize.js";
import { isStaticallyChannelConfigured } from "./config/channel-configured-shared.js";
import { parseBrowserMajorVersion } from "./plugin-sdk/browser-host-inspection.js";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() =>
  vi.fn((params: { artifactBasename: string }) => {
    if (params.artifactBasename === "browser-host-inspection.js") {
      return {
        parseBrowserMajorVersion: (raw: string | null | undefined) => {
          const match = raw?.match(/\b(\d+)\./u);
          return match?.[1] ? Number(match[1]) : null;
        },
        readBrowserVersion: () => null,
        resolveGoogleChromeExecutableForPlatform: () => null,
      };
    }
    throw new Error(`unexpected public surface load: ${params.artifactBasename}`);
  }),
);

const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    diagnostics: [],
    plugins: [
      {
        id: "test-channel-fixture",
        channels: ["discord", "irc", "slack", "telegram"],
        providers: [],
        cliBackends: [],
        channelEnvVars: {
          discord: ["DISCORD_BOT_TOKEN"],
          irc: ["IRC_HOST", "IRC_NICK"],
          slack: ["SLACK_BOT_TOKEN"],
          telegram: ["TELEGRAM_BOT_TOKEN"],
        },
        modelIdNormalization: {
          providers: {
            google: {
              aliases: {
                "gemini-3.1-pro": "gemini-3.1-pro-preview",
              },
            },
            xai: {
              aliases: {
                "grok-4-fast-reasoning": "grok-4-fast",
              },
            },
          },
        },
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
  loadBundledPluginPublicSurfaceModuleSync,
  loadFacadeModuleAtLocationSync: vi.fn(),
  resetFacadeLoaderStateForTest: vi.fn(),
}));

vi.mock("./plugin-sdk/facade-runtime.js", () => ({
  ...facadeMockHelpers,
  __testing: {},
  canLoadActivatedBundledPluginPublicSurface: () => true,
  listImportedBundledPluginFacadeIds: () => [],
  loadActivatedBundledPluginPublicSurfaceModuleSync: loadBundledPluginPublicSurfaceModuleSync,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest: vi.fn(),
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync: loadBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin activation boundary", () => {
  it("keeps generic boundaries cold and loads only narrow browser helper surfaces on use", () => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();

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
    const staticNormalize = { allowPluginNormalization: false };
    expect(normalizeModelRef("google", "gemini-3.1-pro", staticNormalize)).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeModelRef("xai", "grok-4-fast-reasoning", staticNormalize)).toEqual({
      provider: "xai",
      model: "grok-4-fast",
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();

    expect(parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
    expect(
      loadBundledPluginPublicSurfaceModuleSync.mock.calls.map(
        ([params]) => params.artifactBasename,
      ),
    ).toEqual(["browser-host-inspection.js"]);
  });
});
