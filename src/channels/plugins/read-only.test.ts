import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../../plugins/loader.test-fixtures.js";
import {
  listPluginLoaderModuleCandidateUrls,
  listReadOnlyChannelPluginsForConfig,
} from "./read-only.js";

const moduleLoaderParams = vi.hoisted(
  () =>
    [] as Array<{
      modulePath: string;
      tryNative?: boolean;
    }>,
);

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
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);

  type LoaderConfig = {
    plugins?: {
      load?: { paths?: unknown };
    };
  };
  type LoaderParams = {
    config?: LoaderConfig;
    onlyPluginIds?: readonly string[];
    workspaceDir?: string;
  };

  function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function listCandidatePluginDirs(params: LoaderParams): string[] {
    const paths = params.config?.plugins?.load?.paths;
    const explicitPaths = Array.isArray(paths)
      ? paths.filter((entry): entry is string => typeof entry === "string")
      : [];
    const workspaceExtensionsDir = params.workspaceDir
      ? path.join(params.workspaceDir, ".openclaw", "extensions")
      : undefined;
    if (!workspaceExtensionsDir || !fs.existsSync(workspaceExtensionsDir)) {
      return explicitPaths;
    }
    return explicitPaths.concat(
      fs
        .readdirSync(workspaceExtensionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(workspaceExtensionsDir, entry.name)),
    );
  }

  function loadOpenClawPlugins(params: LoaderParams) {
    const onlyPluginIds = new Set(params.onlyPluginIds ?? []);
    const channelSetups = listCandidatePluginDirs(params).flatMap((pluginDir) => {
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const packagePath = path.join(pluginDir, "package.json");
      if (!fs.existsSync(manifestPath) || !fs.existsSync(packagePath)) {
        return [];
      }
      const manifest = readJson(manifestPath);
      if (!isRecord(manifest) || typeof manifest.id !== "string") {
        return [];
      }
      if (onlyPluginIds.size > 0 && !onlyPluginIds.has(manifest.id)) {
        return [];
      }
      const packageJson = readJson(packagePath);
      const openclaw = isRecord(packageJson) ? packageJson.openclaw : undefined;
      const setupEntry = isRecord(openclaw) ? openclaw.setupEntry : undefined;
      if (typeof setupEntry !== "string") {
        return [];
      }
      const setupModule = require(path.join(pluginDir, setupEntry));
      const entry = setupModule.default ?? setupModule;
      const plugin = entry.plugin;
      return plugin ? [{ pluginId: manifest.id, plugin }] : [];
    });
    return { channelSetups };
  }

  return {
    ...actual,
    getCachedPluginModuleLoader: ((params) => {
      moduleLoaderParams.push({
        modulePath: params.modulePath,
        tryNative: params.tryNative,
      });
      const actualLoader = actual.getCachedPluginModuleLoader(params);
      return ((modulePath: string) => {
        if (
          modulePath.endsWith("/plugins/loader.js") ||
          modulePath.endsWith("/plugins/loader.ts")
        ) {
          return { loadOpenClawPlugins };
        }
        return actualLoader(modulePath);
      }) as ReturnType<typeof actual.getCachedPluginModuleLoader>;
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
  const pluginDir = options.pluginDir ?? makeTempDir();
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
        channelEnvVars: {
          [channelId]: ["EXTERNAL_CHAT_TOKEN"],
        },
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
  const bundledRoot = makeTempDir();
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
        channelEnvVars: {
          [channelId]: [envVar],
        },
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
  moduleLoaderParams.length = 0;
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("listReadOnlyChannelPluginsForConfig", () => {
  it("keeps built plugin loader candidates inside the installed package dist root", () => {
    const packageRoot = path.join(makeTempDir(), "node_modules", "openclaw");
    const importerPath = path.join(packageRoot, "dist", "read-only-B4EkEtUx.js");
    const candidates = listPluginLoaderModuleCandidateUrls(pathToFileURL(importerPath).href).map(
      (candidate) => fileURLToPath(candidate),
    );

    expect(candidates).toEqual([
      path.join(packageRoot, "dist", "plugins", "loader.js"),
      path.join(packageRoot, "dist", "plugins", "build-smoke-entry.js"),
    ]);
    expect(candidates).not.toContain(path.join(packageRoot, "..", "plugins", "loader.js"));
  });

  it("does not load setup-only channel plugin runtime by default", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    expect(plugins.some((entry) => entry.id === "external-chat")).toBe(false);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("loads configured external channel setup metadata without importing full runtime", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expectExternalChatSetupOnlyPluginLoaded({ plugins, setupMarker, fullMarker });
    expect(
      moduleLoaderParams.some(
        (entry) =>
          entry.tryNative === true &&
          (entry.modulePath.endsWith("/plugins/loader.js") ||
            entry.modulePath.endsWith("/plugins/loader.ts")),
      ),
    ).toBe(true);
  });

  it("matches setup-only plugins by manifest-owned channel ids when plugin id differs", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      setupChannelId: "external-chat-plugin",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
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
      {
        channels: {
          "alpha-chat": { token: "configured" },
          "beta-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
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
      } as never),
    ).toMatchObject({ token: "beta-token" });
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
      {
        channels: {
          "beta-chat": { token: "beta-token" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expect(plugins.some((entry) => entry.id === "alpha-chat")).toBe(false);
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
      } as never),
    ).toMatchObject({ token: "beta-token" });
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("keeps configured external channels visible when no setup entry exists", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      setupEntry: false,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin).toBeUndefined();
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
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      },
    );

    expect(plugins.find((entry) => entry.id === "external-chat")?.meta.blurb).toBe(
      "manifest config",
    );
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
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.label).toBe("External Chat Manifest");
    expect(plugin?.meta.blurb).toBe("manifest config");
    expect(plugin?.meta.preferOver).toEqual(["legacy-external-chat"]);
    expect(plugin?.configSchema?.schema).toMatchObject({
      properties: {
        token: { type: "string" },
      },
    });
    expect(plugin?.configSchema?.uiHints?.token).toMatchObject({
      label: "Token",
      sensitive: true,
    });
    expect(
      plugin?.config.listAccountIds({ channels: { "external-chat": { token: "t" } } } as never),
    ).toEqual(["default"]);
    expect(
      plugin?.config.resolveAccount({
        channels: { "external-chat": { token: "configured" } },
      } as never),
    ).toMatchObject({
      accountId: "default",
      config: { token: "configured" },
    });
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
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
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
      {
        channels: Object.fromEntries([[unsafeChannelId, { token: "configured" }]]),
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    expect(plugins.some((entry) => entry.id === unsafeChannelId)).toBe(false);
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
    const cfg = {
      channels: {
        "external-chat": {
          accounts: inheritedAccounts,
        },
      },
      plugins: {
        load: { paths: [pluginDir] },
        allow: ["external-chat-plugin"],
      },
    } as never;
    const plugin = listReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    }).find((entry) => entry.id === "external-chat");

    expect(plugin?.config.listAccountIds(cfg)).toEqual(["default", "named"]);
    expect(plugin?.config.resolveAccount(cfg, "__proto__")).toMatchObject({
      accountId: "default",
      config: { token: "default-token" },
    });
    expect(plugin?.config.resolveAccount(cfg, "inherited")).not.toMatchObject({
      config: { token: "prototype-token" },
    });
  });

  it("keeps setup-entry precedence when channel config descriptors are not runtime cutoffs", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
      manifestChannelConfig: true,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
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

  it("uses external channel env vars as read-only configuration triggers", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
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
      {
        channels: {
          "external-chat": { enabled: false },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env, EXTERNAL_CHAT_TOKEN: "configured" },
        includePersistedAuthState: false,
      },
    );

    expect(plugins.some((entry) => entry.id === "external-chat")).toBe(false);
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

    expect(plugins.some((entry) => entry.id === channelId)).toBe(false);
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

    expect(plugins.some((entry) => entry.id === channelId)).toBe(false);
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
      {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
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
    const workspaceDir = makeTempDir();
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
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includeSetupFallbackPlugins: true,
      },
    );

    expect(plugins.some((entry) => entry.id === "spoofed-chat")).toBe(false);
    expect(plugins.some((entry) => entry.id === "external-chat")).toBe(false);
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });
});
