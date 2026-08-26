// Read-only channel tests cover read-only plugin registration and runtime behavior.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  listReadOnlyChannelPluginsForConfig,
  resolveReadOnlyChannelPluginsForConfig,
} from "./read-only.js";

const moduleLoaderParams = vi.hoisted(
  () =>
    [] as Array<{
      modulePath: string;
      tryNative?: boolean;
    }>,
);

function pluginIds(plugins: ReturnType<typeof listReadOnlyChannelPluginsForConfig>): string[] {
  return plugins.map((entry) => entry.id);
}

function createExternalChannelTestConfig(params: {
  pluginDir: string;
  pluginId?: string;
  channels?: Record<string, Record<string, unknown>> | null;
}): Parameters<typeof listReadOnlyChannelPluginsForConfig>[0] {
  return {
    ...(params.channels === null
      ? {}
      : {
          channels: params.channels ?? {
            "external-chat": { token: "configured" },
          },
        }),
    plugins: {
      load: { paths: [params.pluginDir] },
      allow: [params.pluginId ?? "external-chat"],
    },
  };
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

vi.mock("../../plugins/plugin-module-loader-cache.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/plugin-module-loader-cache.js")>();
  return {
    ...actual,
    getCachedPluginModuleLoader: ((params) => {
      moduleLoaderParams.push({
        modulePath: params.modulePath,
        tryNative: params.tryNative,
      });
      return actual.getCachedPluginModuleLoader(params);
    }) satisfies typeof actual.getCachedPluginModuleLoader,
  };
});

function writeExternalSetupChannelPlugin(
  options: {
    setupEntry?: boolean;
    pluginDir?: string;
    pluginId?: string;
    channelId?: string;
    manifestChannelIds?: string[];
    manifestChannelConfig?: boolean;
    manifestChannelDescription?: string;
    manifestChannelLabel?: string;
    setupRequiresRuntime?: boolean;
    setupChannelId?: string;
  } = {},
) {
  useNoBundledPlugins();
  const pluginDir = options.pluginDir ?? makePluginLoaderTempDir();
  const pluginId = options.pluginId ?? "external-chat";
  const channelId = options.channelId ?? "external-chat";
  const manifestChannelIds = options.manifestChannelIds ?? [channelId];
  const setupChannelId = options.setupChannelId ?? channelId;
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const setupEntry = options.setupEntry !== false;

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: `@example/openclaw-${pluginId}`,
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.cjs"],
          ...(setupEntry ? { setupEntry: "./setup-entry.cjs" } : {}),
          channel: {
            id: channelId,
            configuredState: { env: { anyOf: ["EXTERNAL_CHAT_TOKEN"] } },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        channels: manifestChannelIds,
        ...(typeof options.setupRequiresRuntime === "boolean"
          ? { setup: { requiresRuntime: options.setupRequiresRuntime } }
          : {}),
        ...(options.manifestChannelConfig
          ? {
              channelConfigs: Object.fromEntries(
                manifestChannelIds.map((id) => [
                  id,
                  {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        token: { type: "string" },
                      },
                    },
                    uiHints: {
                      token: {
                        label: "Token",
                        sensitive: true,
                      },
                    },
                    label: options.manifestChannelLabel ?? "External Chat Manifest",
                    description: options.manifestChannelDescription ?? "manifest config",
                    preferOver: ["legacy-external-chat"],
                  },
                ]),
              ),
            }
          : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(channelId)},
        meta: {
          id: ${JSON.stringify(channelId)},
          label: "External Chat",
          selectionLabel: "External Chat",
          docsPath: ${JSON.stringify(`/channels/${channelId}`)},
          blurb: "full entry",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (cfg) => ({
            accountId: "default",
            token: cfg.channels?.[${JSON.stringify(channelId)}]?.token ?? "configured",
          }),
        },
        outbound: { deliveryMode: "direct" },
        secrets: {
          secretTargetRegistryEntries: [
            {
              id: ${JSON.stringify(`channels.${channelId}.token`)},
              targetType: "channel",
              configFile: "openclaw.json",
              pathPattern: ${JSON.stringify(`channels.${channelId}.token`)},
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
        },
      },
    });
  },
};`,
    "utf-8",
  );
  if (setupEntry) {
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: ${JSON.stringify(setupChannelId)},
    meta: {
      id: ${JSON.stringify(setupChannelId)},
      label: "External Chat",
      selectionLabel: "External Chat",
      docsPath: ${JSON.stringify(`/channels/${setupChannelId}`)},
      blurb: "setup entry",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => ({
        accountId: "default",
        token: cfg.channels?.[${JSON.stringify(setupChannelId)}]?.token ?? "configured",
      }),
    },
    outbound: { deliveryMode: "direct" },
    secrets: {
      secretTargetRegistryEntries: [
            {
              id: ${JSON.stringify(`channels.${setupChannelId}.token`)},
              targetType: "channel",
              configFile: "openclaw.json",
              pathPattern: ${JSON.stringify(`channels.${setupChannelId}.token`)},
          secretShape: "secret_input",
          expectedResolvedValue: "string",
          includeInPlan: true,
          includeInConfigure: true,
          includeInAudit: true,
        },
      ],
    },
  },
};`,
      "utf-8",
    );
  }

  return { pluginDir, fullMarker, setupMarker };
}

function writeBundledSetupChannelPlugin(
  options: {
    pluginId?: string;
    channelId?: string;
    envVar?: string;
  } = {},
) {
  const bundledRoot = makePluginLoaderTempDir();
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  const pluginId = options.pluginId ?? "bundled-chat";
  const channelId = options.channelId ?? pluginId;
  const envVar = options.envVar ?? "BUNDLED_CHAT_TOKEN";
  const pluginDir = path.join(bundledRoot, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: `@openclaw/${pluginId}`,
        version: "1.0.0",
        type: "commonjs",
        openclaw: {
          extensions: ["./index.cjs"],
          setupEntry: "./setup-entry.cjs",
          channel: {
            id: channelId,
            label: "Bundled Chat",
            selectionLabel: "Bundled Chat",
            docsPath: `/channels/${channelId}`,
            blurb: "bundled setup entry",
            configuredState: { env: { anyOf: [envVar] } },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        channels: [channelId],
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  kind: "bundled-channel-entry",
  id: ${JSON.stringify(pluginId)},
  name: "Bundled Chat",
  description: "full entry",
  register() {},
  loadChannelPlugin() {
    return {
      id: ${JSON.stringify(channelId)},
      meta: { id: ${JSON.stringify(channelId)}, label: "Bundled Chat" },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ accountId: "default", token: "configured" }),
      },
      outbound: { deliveryMode: "direct" },
    };
  },
};`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "setup-entry.cjs"),
    `module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() {
    require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
    return {
      id: ${JSON.stringify(channelId)},
      meta: {
        id: ${JSON.stringify(channelId)},
        label: "Bundled Chat",
        selectionLabel: "Bundled Chat",
        docsPath: ${JSON.stringify(`/channels/${channelId}`)},
        blurb: "bundled setup entry",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ accountId: "default", token: "configured" }),
      },
      outbound: { deliveryMode: "direct" },
    };
  },
};`,
    "utf-8",
  );

  return { bundledRoot, pluginDir, fullMarker, setupMarker, pluginId, channelId, envVar };
}

function expectExternalChatSetupOnlyPluginLoaded(params: {
  plugins: ReturnType<typeof listReadOnlyChannelPluginsForConfig>;
  setupMarker: string;
  fullMarker: string;
}) {
  const plugin = params.plugins.find((entry) => entry.id === "external-chat");
  expect(plugin?.meta.blurb).toBe("setup entry");
  expect(
    plugin?.secrets?.secretTargetRegistryEntries?.some(
      (entry) => entry.id === "channels.external-chat.token",
    ),
  ).toBe(true);
  expect(fs.existsSync(params.setupMarker)).toBe(true);
  expect(fs.existsSync(params.fullMarker)).toBe(false);
}

afterEach(() => {
  vi.unstubAllEnvs();
  moduleLoaderParams.length = 0;
  resetPluginLoaderTestStateForTest();
  resetPluginRuntimeStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("listReadOnlyChannelPluginsForConfig", () => {
  it("uses package channel metadata without loading setup or full runtime", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    expect(pluginIds(plugins)).toContain("external-chat");
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("loads configured external channel setup metadata without importing full runtime", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
    expect(moduleLoaderParams).toContainEqual({
      modulePath: fs.realpathSync(path.join(pluginDir, "setup-entry.cjs")),
      tryNative: true,
    });
  });

  it("uses activation source config to discover channel setup metadata after secret stripping", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        channels: { "external-chat": {} },
      }),
      {
        activationSourceConfig: createExternalChannelTestConfig({ pluginDir }),
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
  });

  it("reuses default read-only channel plugin resolution for the same config", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const cfg = createExternalChannelTestConfig({ pluginDir });

    const first = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });
    const loaderCallCount = moduleLoaderParams.length;
    expect(fs.existsSync(setupMarker)).toBe(true);
    fs.rmSync(setupMarker, { force: true });

    const second = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });

    expect(pluginIds(first)).toContain("external-chat");
    expect(pluginIds(second)).toContain("external-chat");
    expect(moduleLoaderParams).toHaveLength(loaderCallCount);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("refreshes cached read-only channel plugins when the active channel registry changes", () => {
    const cfg = { channels: { "external-chat": { token: "configured" } } } as never;
    const createRegistryPlugin = (blurb: string) => {
      const base = createChannelTestPluginBase({ id: "external-chat" as never });
      return {
        ...base,
        meta: {
          ...base.meta,
          blurb,
        },
      };
    };

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "first-plugin", plugin: createRegistryPlugin("first"), source: "test" },
      ]),
    );
    const first = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: true,
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "second-plugin", plugin: createRegistryPlugin("second"), source: "test" },
      ]),
    );
    const second = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: true,
    });

    expect(first.find((plugin) => plugin.id === "external-chat")?.meta.blurb).toBe("first");
    expect(second.find((plugin) => plugin.id === "external-chat")?.meta.blurb).toBe("second");
  });

  it("refreshes cached read-only channel plugins when ambient env changes", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      manifestChannelConfig: true,
    });
    const cfg = createExternalChannelTestConfig({ pluginDir, channels: null });

    const first = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });

    vi.stubEnv("EXTERNAL_CHAT_TOKEN", "token-from-env");
    const second = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });

    expect(pluginIds(first)).not.toContain("external-chat");
    expectExternalChatSetupOnlyPluginLoaded({ plugins: second, setupMarker, fullMarker });
  });

  it("clears cached read-only channel plugin resolution with plugin metadata lifecycle caches", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const cfg = createExternalChannelTestConfig({ pluginDir });

    const first = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });
    expect(pluginIds(first)).toContain("external-chat");
    expect(fs.existsSync(setupMarker)).toBe(true);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.channels = ["other-chat"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    clearPluginMetadataLifecycleCaches();
    const second = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });

    expect(pluginIds(second)).not.toContain("external-chat");
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("reloads replaced installed channel setup modules and their dependencies", () => {
    const { pluginDir } = writeExternalSetupChannelPlugin();
    const setupPath = path.join(pluginDir, "setup-entry.cjs");
    const dependencyPath = path.join(pluginDir, "setup-dependency.cjs");
    const initialSource = fs
      .readFileSync(setupPath, "utf8")
      .replace('blurb: "setup entry",', 'blurb: require("./setup-dependency.cjs"),');
    fs.writeFileSync(dependencyPath, 'module.exports = "before";\n', "utf8");
    fs.writeFileSync(setupPath, initialSource, "utf8");
    const cfg = createExternalChannelTestConfig({ pluginDir });
    const options = {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    };

    const first = listReadOnlyChannelPluginsForConfig(cfg, options);
    expect(first.find((plugin) => plugin.id === "external-chat")?.meta.blurb).toBe("before");

    fs.writeFileSync(dependencyPath, 'module.exports = "after";\n', "utf8");
    fs.writeFileSync(
      setupPath,
      initialSource.replace(
        'blurb: require("./setup-dependency.cjs"),',
        'blurb: "updated:" + require("./setup-dependency.cjs"),',
      ),
      "utf8",
    );
    clearPluginMetadataLifecycleCaches();

    const second = listReadOnlyChannelPluginsForConfig(cfg, options);
    expect(second.find((plugin) => plugin.id === "external-chat")?.meta.blurb).toBe(
      "updated:after",
    );
  });

  it("matches setup-only plugins by manifest-owned channel ids when plugin id differs", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      setupChannelId: "external-chat-plugin",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir, pluginId: "external-chat-plugin" }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.id).toBe("external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("clones setup-only plugins for every configured owned channel when setup id matches one channel", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "alpha-chat",
      manifestChannelIds: ["alpha-chat", "beta-chat"],
      setupChannelId: "alpha-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        pluginId: "external-chat-plugin",
        channels: {
          "alpha-chat": { token: "configured" },
          "beta-chat": { token: "configured" },
        },
      }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const alphaPlugin = plugins.find((entry) => entry.id === "alpha-chat");
    const betaPlugin = plugins.find((entry) => entry.id === "beta-chat");
    expect(alphaPlugin?.meta.id).toBe("alpha-chat");
    expect(betaPlugin?.meta.id).toBe("beta-chat");
    expect(alphaPlugin?.meta.blurb).toBe("setup entry");
    expect(betaPlugin?.meta.blurb).toBe("setup entry");
    expect(
      betaPlugin?.secrets?.secretTargetRegistryEntries?.some(
        (entry) => entry.id === "channels.beta-chat.token",
      ),
    ).toBe(true);
    expect(
      betaPlugin?.config.resolveAccount({
        channels: {
          "alpha-chat": { token: "alpha-token" },
          "beta-chat": { token: "beta-token" },
        },
      } as never).token,
    ).toBe("beta-token");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("clones setup-only plugins when only another owned channel is configured", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "alpha-chat",
      manifestChannelIds: ["alpha-chat", "beta-chat"],
      setupChannelId: "alpha-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        pluginId: "external-chat-plugin",
        channels: { "beta-chat": { token: "beta-token" } },
      }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expect(pluginIds(plugins)).not.toContain("alpha-chat");
    const betaPlugin = plugins.find((entry) => entry.id === "beta-chat");
    expect(betaPlugin?.meta.id).toBe("beta-chat");
    expect(
      betaPlugin?.secrets?.secretTargetRegistryEntries?.some(
        (entry) => entry.id === "channels.beta-chat.token",
      ),
    ).toBe(true);
    expect(
      betaPlugin?.config.resolveAccount({
        channels: {
          "beta-chat": { token: "beta-token" },
        },
      } as never).token,
    ).toBe("beta-token");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("keeps configured external channels visible when no setup entry exists", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      setupEntry: false,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.label).toBe("@example/openclaw-external-chat");
    expect(plugin?.meta.blurb).toBe("");
    expect(plugin?.configSchema).toBeUndefined();
    expect(
      plugin?.config.listAccountIds({
        channels: {
          "external-chat": { token: "configured" },
        },
      } as never),
    ).toEqual(["default"]);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("uses manifest channel configs when no setup entry exists", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
    });
    const cfg = createExternalChannelTestConfig({
      pluginDir,
      pluginId: "external-chat-plugin",
      channels: {
        "external-chat": {
          defaultAccount: "Ops Team",
          accounts: {
            "Ops Team": { token: "configured" },
            chat: { token: "chat-token" },
          },
        },
      },
    });
    const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("manifest config");
    expect(plugin?.config.defaultAccountId?.(cfg)).toBe("ops-team");
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("uses manifest channel configs before setup-only plugin loading", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
      setupRequiresRuntime: false,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir, pluginId: "external-chat-plugin" }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.label).toBe("External Chat Manifest");
    expect(plugin?.meta.blurb).toBe("manifest config");
    expect(plugin?.meta.preferOver).toEqual(["legacy-external-chat"]);
    const schema = plugin?.configSchema?.schema as
      | { properties?: Record<string, { type?: string }> }
      | undefined;
    expect(schema?.properties?.token?.type).toBe("string");
    expectRecordFields(plugin?.configSchema?.uiHints?.token, {
      label: "Token",
      sensitive: true,
    });
    expect(
      plugin?.config.listAccountIds({ channels: { "external-chat": { token: "t" } } } as never),
    ).toEqual(["default"]);
    const account = plugin?.config.resolveAccount({
      channels: { "external-chat": { token: "configured" } },
    } as never);
    const accountFields = expectRecordFields(account, {
      accountId: "default",
    });
    expectRecordFields(accountFields.config, { token: "configured" });
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("sanitizes terminal control sequences from manifest channel metadata", () => {
    const { pluginDir } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
      manifestChannelLabel: "External\u001b[31m Chat\u001b[0m",
      manifestChannelDescription: "manifest\u001b[2K config",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir, pluginId: "external-chat-plugin" }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.label).toBe("External Chat");
    expect(plugin?.meta.selectionLabel).toBe("External Chat");
    expect(plugin?.meta.blurb).toBe("manifest config");
  });

  it("ignores manifest channel configs with unsafe channel ids", () => {
    const unsafeChannelId = "__proto__";
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      pluginId: "external-chat-plugin",
      channelId: unsafeChannelId,
      manifestChannelIds: [unsafeChannelId],
      manifestChannelConfig: true,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        pluginId: "external-chat-plugin",
        channels: Object.fromEntries([[unsafeChannelId, { token: "configured" }]]),
      }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    expect(pluginIds(plugins)).not.toContain(unsafeChannelId);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("uses own normalized account ids for manifest channel account config", () => {
    const { pluginDir } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
    });
    const inheritedAccounts = Object.create({
      inherited: { token: "prototype-token" },
    }) as Record<string, unknown>;
    inheritedAccounts.default = { token: "default-token" };
    inheritedAccounts.named = { token: "named-token" };
    const cfg = createExternalChannelTestConfig({
      pluginDir,
      pluginId: "external-chat-plugin",
      channels: { "external-chat": { accounts: inheritedAccounts } },
    });
    const plugin = listReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    }).find((entry) => entry.id === "external-chat");

    expect(plugin?.config.listAccountIds(cfg)).toEqual(["default", "named"]);
    const defaultAccount = plugin?.config.resolveAccount(cfg, "__proto__");
    const defaultFields = expectRecordFields(defaultAccount, {
      accountId: "default",
    });
    expectRecordFields(defaultFields.config, { token: "default-token" });
    const inheritedAccount = plugin?.config.resolveAccount(cfg, "inherited") as
      | { config?: { token?: string } }
      | undefined;
    expect(inheritedAccount?.config?.token).not.toBe("prototype-token");
  });

  it("ignores manifest account keys that normalize to blocked object keys", () => {
    const { pluginDir } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
    });
    const cfg = createExternalChannelTestConfig({
      pluginDir,
      pluginId: "external-chat-plugin",
      channels: {
        "external-chat": {
          accounts: { "constructor ": { token: "blocked-token" } },
        },
      },
    });
    const plugin = listReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    }).find((entry) => entry.id === "external-chat");

    expect(plugin?.config.listAccountIds(cfg)).toEqual([]);
    const account = plugin?.config.resolveAccount(cfg, "default");
    const accountFields = expectRecordFields(account, {
      accountId: "default",
    });
    const configFields = expectRecordFields(accountFields.config, {});
    expect(configFields.token).toBeUndefined();
  });

  it("resolves manifest channel account config from raw account keys with opaque provider ids", () => {
    const { pluginDir } = writeExternalSetupChannelPlugin({
      setupEntry: false,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
    });
    const cfg = createExternalChannelTestConfig({
      pluginDir,
      pluginId: "external-chat-plugin",
      channels: {
        "external-chat": {
          accounts: {
            "59000514e8ad@im.bot": {
              enabled: true,
              baseUrl: "https://ilinkai.weixin.qq.com",
            },
          },
        },
      },
    });
    const plugin = listReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    }).find((entry) => entry.id === "external-chat");

    expect(plugin?.config.listAccountIds(cfg)).toEqual(["59000514e8ad-im-bot"]);
    const account = plugin?.config.resolveAccount(cfg, "59000514e8ad-im-bot");
    const fields = expectRecordFields(account, {
      accountId: "59000514e8ad-im-bot",
    });
    expectRecordFields(fields.config, {
      enabled: true,
      baseUrl: "https://ilinkai.weixin.qq.com",
    });
  });

  it("keeps setup-entry precedence when channel config descriptors are not runtime cutoffs", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir, pluginId: "external-chat-plugin" }),
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("uses external channel env vars as read-only configuration triggers", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        pluginId: "external-chat-plugin",
        channels: null,
      }),
      {
        env: { ...process.env, EXTERNAL_CHAT_TOKEN: "configured" },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
  });

  it("does not promote disabled external channels from manifest env", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        pluginId: "external-chat-plugin",
        channels: { "external-chat": { enabled: false } },
      }),
      {
        env: { ...process.env, EXTERNAL_CHAT_TOKEN: "configured" },
        includePersistedAuthState: false,
      },
    );

    expect(pluginIds(plugins)).not.toContain("external-chat");
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("does not promote disabled bundled channels from ambient env", () => {
    const { channelId, envVar, fullMarker, setupMarker } = writeBundledSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        plugins: {
          allow: ["memory-core"],
        },
      } as never,
      {
        env: { ...process.env, [envVar]: "configured" },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expect(pluginIds(plugins)).not.toContain(channelId);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("does not promote explicitly disabled bundled channels from ambient env", () => {
    const { channelId, envVar, fullMarker, pluginId, setupMarker } =
      writeBundledSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          [channelId]: { enabled: false },
        },
        plugins: {
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as never,
      {
        env: { ...process.env, [envVar]: "configured" },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expect(pluginIds(plugins)).not.toContain(channelId);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("keeps explicitly enabled bundled channels visible from env configuration", () => {
    const { channelId, envVar, fullMarker, pluginId, setupMarker } =
      writeBundledSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        plugins: {
          allow: [pluginId],
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as never,
      {
        env: { ...process.env, [envVar]: "configured" },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === channelId);
    expect(plugin?.meta.blurb).toBe("bundled setup entry");
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("loads bundled setup runtime only when explicitly requested", () => {
    const { channelId, envVar, fullMarker, pluginId, setupMarker } =
      writeBundledSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        plugins: {
          allow: [pluginId],
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as never,
      {
        env: { ...process.env, [envVar]: "configured" },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === channelId);
    expect(plugin?.meta.blurb).toBe("bundled setup entry");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("accepts option-like env keys through the explicit env option", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({
        pluginDir,
        pluginId: "external-chat-plugin",
        channels: null,
      }),
      {
        env: {
          ...process.env,
          cache: "true",
          env: "prod",
          EXTERNAL_CHAT_TOKEN: "configured",
          workspaceDir: "workspace-env-value",
        },
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("discovers trusted external channel plugins from the default agent workspace", () => {
    const workspaceDir = makePluginLoaderTempDir();
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "external-chat-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    const { fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginDir,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("ignores external setup plugins that export an unrequested channel id", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelIds: ["external-chat"],
      setupChannelId: "spoofed-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir, pluginId: "external-chat-plugin" }),
      {
        env: { ...process.env },
        includeSetupFallbackPlugins: true,
      },
    );

    expect(pluginIds(plugins)).not.toContain("spoofed-chat");
    expect(pluginIds(plugins)).toContain("external-chat");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("falls back to manifest metadata and reports setup-entry load failures", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `throw new Error("Cannot find module 'ansi-escapes'");`,
      "utf-8",
    );

    const result = resolveReadOnlyChannelPluginsForConfig(
      createExternalChannelTestConfig({ pluginDir, pluginId: "external-chat-plugin" }),
      {
        env: { ...process.env },
        includeSetupFallbackPlugins: true,
      },
    );

    expect(pluginIds(result.plugins)).toContain("external-chat");
    expect(result.missingConfiguredChannelIds).not.toContain("external-chat");
    expect(result.loadFailures).toEqual([
      expect.objectContaining({
        channelId: "external-chat",
        pluginId: "external-chat-plugin",
        message: expect.stringContaining("Cannot find module"),
      }),
    ]);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
