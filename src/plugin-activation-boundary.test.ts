import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() =>
  vi.fn((params: { artifactBasename: string }) => {
    if (params.artifactBasename === "browser-control-auth.js") {
      return {
        ensureBrowserControlAuth: async () => ({ auth: {} }),
        resolveBrowserControlAuth: () => ({ token: undefined, password: undefined }),
        shouldAutoGenerateBrowserAuth: () => false,
      };
    }
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
    if (params.artifactBasename === "browser-profiles.js") {
      return {
        resolveBrowserConfig: () => ({
          attachOnly: false,
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeEnd: 9420,
          cdpPortRangeStart: 9222,
          cdpProtocol: "http",
          color: "#FF4500",
          controlPort: 9223,
          defaultProfile: "openclaw",
          enabled: true,
          evaluateEnabled: true,
          extraArgs: [],
          headless: true,
          noSandbox: false,
          profiles: {
            openclaw: {
              color: "#FF4500",
              driver: "openclaw",
              name: "openclaw",
            },
          },
          remoteCdpHandshakeTimeoutMs: 3000,
          remoteCdpTimeoutMs: 1500,
        }),
        resolveProfile: () => ({
          attachOnly: false,
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPort: 9222,
          cdpUrl: "http://127.0.0.1:9222",
          color: "#FF4500",
          driver: "openclaw",
          name: "openclaw",
        }),
      };
    }
    throw new Error(`unexpected public surface load: ${params.artifactBasename}`);
  }),
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
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  let ambientImportsPromise: Promise<void> | undefined;
  let configHelpersPromise:
    | Promise<{
        isStaticallyChannelConfigured: typeof import("./config/channel-configured-shared.js").isStaticallyChannelConfigured;
        resolveEnvApiKey: typeof import("./agents/model-auth-env.js").resolveEnvApiKey;
      }>
    | undefined;
  let modelSelectionPromise:
    | Promise<{
        normalizeModelRef: typeof import("./agents/model-selection-normalize.js").normalizeModelRef;
      }>
    | undefined;
  let browserHelpersPromise:
    | Promise<{
        DEFAULT_AI_SNAPSHOT_MAX_CHARS: typeof import("./plugin-sdk/browser-config.js").DEFAULT_AI_SNAPSHOT_MAX_CHARS;
        DEFAULT_BROWSER_EVALUATE_ENABLED: typeof import("./plugin-sdk/browser-config.js").DEFAULT_BROWSER_EVALUATE_ENABLED;
        DEFAULT_OPENCLAW_BROWSER_COLOR: typeof import("./plugin-sdk/browser-config.js").DEFAULT_OPENCLAW_BROWSER_COLOR;
        DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: typeof import("./plugin-sdk/browser-config.js").DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME;
        DEFAULT_UPLOAD_DIR: typeof import("./plugin-sdk/browser-config.js").DEFAULT_UPLOAD_DIR;
        closeTrackedBrowserTabsForSessions: typeof import("./plugin-sdk/browser-maintenance.js").closeTrackedBrowserTabsForSessions;
        parseBrowserMajorVersion: typeof import("./plugin-sdk/browser-host-inspection.js").parseBrowserMajorVersion;
        redactCdpUrl: typeof import("./plugin-sdk/browser-config.js").redactCdpUrl;
        readBrowserVersion: typeof import("./plugin-sdk/browser-host-inspection.js").readBrowserVersion;
        resolveBrowserConfig: typeof import("./plugin-sdk/browser-config.js").resolveBrowserConfig;
        resolveBrowserControlAuth: typeof import("./plugin-sdk/browser-config.js").resolveBrowserControlAuth;
        resolveGoogleChromeExecutableForPlatform: typeof import("./plugin-sdk/browser-host-inspection.js").resolveGoogleChromeExecutableForPlatform;
        resolveProfile: typeof import("./plugin-sdk/browser-config.js").resolveProfile;
      }>
    | undefined;
  let browserAmbientImportsPromise: Promise<void> | undefined;
  function importAmbientModules() {
    ambientImportsPromise ??= Promise.all([
      import("./commands/onboard-custom.js"),
      import("./plugins/provider-model-defaults.js"),
      import("./plugins/provider-model-primary.js"),
    ]).then(() => undefined);
    return ambientImportsPromise;
  }

  function importConfigHelpers() {
    configHelpersPromise ??= Promise.all([
      import("./config/channel-configured-shared.js"),
      import("./agents/model-auth-env.js"),
    ]).then(([channelConfigured, modelAuthEnv]) => ({
      isStaticallyChannelConfigured: channelConfigured.isStaticallyChannelConfigured,
      resolveEnvApiKey: modelAuthEnv.resolveEnvApiKey,
    }));
    return configHelpersPromise;
  }

  function importModelSelection() {
    modelSelectionPromise ??= import("./agents/model-selection-normalize.js").then((module) => ({
      normalizeModelRef: module.normalizeModelRef,
    }));
    return modelSelectionPromise;
  }

  function importBrowserHelpers() {
    browserHelpersPromise ??= Promise.all([
      import("./plugin-sdk/browser-config.js"),
      import("./plugin-sdk/browser-host-inspection.js"),
      import("./plugin-sdk/browser-maintenance.js"),
    ]).then(([config, inspection, maintenance]) => ({
      DEFAULT_AI_SNAPSHOT_MAX_CHARS: config.DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      DEFAULT_BROWSER_EVALUATE_ENABLED: config.DEFAULT_BROWSER_EVALUATE_ENABLED,
      DEFAULT_OPENCLAW_BROWSER_COLOR: config.DEFAULT_OPENCLAW_BROWSER_COLOR,
      DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: config.DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
      DEFAULT_UPLOAD_DIR: config.DEFAULT_UPLOAD_DIR,
      closeTrackedBrowserTabsForSessions: maintenance.closeTrackedBrowserTabsForSessions,
      parseBrowserMajorVersion: inspection.parseBrowserMajorVersion,
      redactCdpUrl: config.redactCdpUrl,
      readBrowserVersion: inspection.readBrowserVersion,
      resolveBrowserConfig: config.resolveBrowserConfig,
      resolveBrowserControlAuth: config.resolveBrowserControlAuth,
      resolveGoogleChromeExecutableForPlatform: inspection.resolveGoogleChromeExecutableForPlatform,
      resolveProfile: config.resolveProfile,
    }));
    return browserHelpersPromise;
  }

  function importBrowserAmbientModules() {
    browserAmbientImportsPromise ??= Promise.all([
      import("./agents/sandbox/browser.js"),
      import("./agents/sandbox/context.js"),
      import("./commands/doctor-browser.js"),
      import("./node-host/runner.js"),
      import("./security/audit.js"),
      import("./security/audit-extra.sync.js"),
    ]).then(() => undefined);
    return browserAmbientImportsPromise;
  }

  it("does not load bundled provider plugins on ambient command imports", async () => {
    await importAmbientModules();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load bundled plugins for config and env detection helpers", async () => {
    const { isStaticallyChannelConfigured, resolveEnvApiKey } = await importConfigHelpers();

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
    expect(
      resolveEnvApiKey("anthropic-vertex", {
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
      }),
    ).toEqual({
      apiKey: "gcp-vertex-credentials",
      source: "gcloud adc",
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load provider plugins for static model id normalization", async () => {
    const { normalizeModelRef } = await importModelSelection();

    expect(normalizeModelRef("google", "gemini-3.1-pro")).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeModelRef("xai", "grok-4-fast-reasoning")).toEqual({
      provider: "xai",
      model: "grok-4-fast",
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("keeps browser helper imports cold and loads only narrow browser helper surfaces on use", async () => {
    const browser = await importBrowserHelpers();

    expect(browser.DEFAULT_AI_SNAPSHOT_MAX_CHARS).toBe(80_000);
    expect(browser.DEFAULT_BROWSER_EVALUATE_ENABLED).toBe(true);
    expect(browser.DEFAULT_OPENCLAW_BROWSER_COLOR).toBe("#FF4500");
    expect(browser.DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME).toBe("openclaw");
    expect(browser.DEFAULT_UPLOAD_DIR).toContain("uploads");
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(browser.parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
    expect(browser.resolveBrowserControlAuth({}, {} as NodeJS.ProcessEnv)).toEqual({
      token: undefined,
      password: undefined,
    });
    const resolved = browser.resolveBrowserConfig(undefined, {});
    expect(browser.resolveProfile(resolved, "openclaw")).toEqual(
      expect.objectContaining({
        name: "openclaw",
        cdpHost: "127.0.0.1",
      }),
    );
    expect(
      browser.redactCdpUrl("wss://user:secret@example.com/devtools/browser/123"),
    ).not.toContain("secret");
    expect(browser.readBrowserVersion("/path/that/does/not/exist")).toBeNull();
    expect(browser.resolveGoogleChromeExecutableForPlatform("aix")).toBeNull();
    expect(
      loadBundledPluginPublicSurfaceModuleSync.mock.calls.map(
        ([params]) => params.artifactBasename,
      ),
    ).toEqual([
      "browser-host-inspection.js",
      "browser-control-auth.js",
      "browser-profiles.js",
      "browser-profiles.js",
      "browser-host-inspection.js",
      "browser-host-inspection.js",
    ]);
  });

  it("keeps browser cleanup helpers cold when browser is disabled", async () => {
    const browser = await importBrowserHelpers();

    await expect(browser.closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("keeps generic session-binding cleanup helpers cold when plugins are disabled", async () => {
    const { getSessionBindingService } =
      await import("./infra/outbound/session-binding-service.js");

    await expect(
      getSessionBindingService().unbind({
        targetSessionKey: "agent:main:test",
        reason: "session-reset",
      }),
    ).resolves.toEqual([]);
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("keeps audited browser ambient imports cold", async () => {
    await importBrowserAmbientModules();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });
});
