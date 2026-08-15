/** Verifies plugin loader behavior for native module loading and resolver hooks. */
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = createTempDirTracker();

function writeBundledPluginFixture(id: string) {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
    "utf-8",
  );
  return pluginRoot;
}

function writePackagedPluginFixture(id: string) {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: id,
        type: "commonjs",
        openclaw: {
          extensions: ["./index.cjs"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
    "utf-8",
  );
  return pluginRoot;
}

function writePreManagedLlamaCppProviderFixture() {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  fs.mkdirSync(path.join(pluginRoot, "dist"));
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/llama-cpp-provider",
        version: "2026.7.2-beta.7",
        type: "module",
        openclaw: {
          extensions: ["./dist/index.js"],
          runtimeExtensions: ["./dist/index.js"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "llama-cpp",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "dist", "index.js"),
    [
      'import { createLocalEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";',
      'export default { id: "llama-cpp", register() {',
      '  if (typeof createLocalEmbeddingProvider !== "function") throw new Error("missing bridge");',
      "} };",
    ].join("\n"),
    "utf-8",
  );
  return pluginRoot;
}

function writePreSplitSdkBridgeConsumerFixture() {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  fs.mkdirSync(path.join(pluginRoot, "dist"));
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/sdk-bridge-consumer",
        version: "2026.7.2-beta.7",
        type: "module",
        openclaw: {
          extensions: ["./dist/index.js"],
          runtimeExtensions: ["./dist/index.js"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "sdk-bridge-consumer",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  // Import shapes copied from published 2026.7.2-beta.7 artifacts:
  // voice-call/matrix doctor contracts (runtime-doctor), whatsapp ack policy
  // (channel-feedback), slack progress-draft render (channel-outbound).
  fs.writeFileSync(
    path.join(pluginRoot, "dist", "index.js"),
    [
      'import { archiveLegacyStateSource, detectOpenClawStateDatabaseSchemaMigrations, repairOpenClawStateDatabaseSchema, detectPluginInstallPathIssue, formatPluginInstallPathIssue, removePluginFromConfig, createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";',
      'import { shouldAckReactionForWhatsApp } from "openclaw/plugin-sdk/channel-feedback";',
      'import { resolveChannelProgressDraftRender } from "openclaw/plugin-sdk/channel-outbound";',
      'export default { id: "sdk-bridge-consumer", register() {',
      "  const bridged = [",
      "    archiveLegacyStateSource,",
      "    detectOpenClawStateDatabaseSchemaMigrations,",
      "    repairOpenClawStateDatabaseSchema,",
      "    detectPluginInstallPathIssue,",
      "    formatPluginInstallPathIssue,",
      "    removePluginFromConfig,",
      "    createPluginStateSyncKeyedStore,",
      "    shouldAckReactionForWhatsApp,",
      "    resolveChannelProgressDraftRender,",
      "  ];",
      '  if (bridged.some((entry) => typeof entry !== "function")) throw new Error("missing bridge");',
      "} };",
    ].join("\n"),
    "utf-8",
  );
  return pluginRoot;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./plugin-module-loader-cache.js");
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  tempDirs.cleanup();
});

function mockSourceLoaderCalls() {
  const sourceLoaderCalls: Array<{ modulePath: string; loaderFilename?: string }> = [];
  vi.doMock("./plugin-module-loader-cache.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./plugin-module-loader-cache.js")>();
    return {
      ...actual,
      getCachedPluginSourceModuleLoader: vi.fn((params) => {
        sourceLoaderCalls.push({
          modulePath: params.modulePath,
          loaderFilename: params.loaderFilename,
        });
        return vi.fn(() => ({
          default: {
            id: "source-fallback",
            register() {},
          },
        }));
      }),
    };
  });
  return sourceLoaderCalls;
}

describe("createPluginModuleLoader", () => {
  it("loads bundled JavaScript without creating a module loader", async () => {
    const sourceLoaderCalls = mockSourceLoaderCalls();

    const { loadOpenClawPlugins } = await importFreshModule<typeof import("./loader.js")>(
      import.meta.url,
      "./loader.js?scope=native-module-loader",
    );

    const pluginRoot = writeBundledPluginFixture("demo");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = pluginRoot;

    loadOpenClawPlugins({
      cache: false,
      installRecords: {},
      workspaceDir: pluginRoot,
      onlyPluginIds: ["demo"],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: true,
            },
          },
        },
      },
    });

    expect(sourceLoaderCalls).toStrictEqual([]);
  });

  it("loads packaged JavaScript without creating a module loader", async () => {
    const sourceLoaderCalls = mockSourceLoaderCalls();

    const { loadOpenClawPlugins } = await importFreshModule<typeof import("./loader.js")>(
      import.meta.url,
      "./loader.js?scope=packaged-native-module-loader",
    );

    const pluginRoot = writePackagedPluginFixture("npm-demo");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tempDirs.make("openclaw-plugin-loader-");

    const registry = loadOpenClawPlugins({
      cache: false,
      installRecords: {},
      onlyPluginIds: ["npm-demo"],
      config: {
        plugins: {
          enabled: true,
          load: {
            paths: [pluginRoot],
          },
          allow: ["npm-demo"],
          entries: {
            "npm-demo": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((plugin) => plugin.id === "npm-demo")?.status).toBe("loaded");
    expect(sourceLoaderCalls).toStrictEqual([]);
  });

  it("loads the released pre-managed llama.cpp provider import through the SDK alias", async () => {
    const { loadOpenClawPlugins } = await importFreshModule<typeof import("./loader.js")>(
      import.meta.url,
      "./loader.js?scope=llama-cpp-upgrade-compat",
    );
    const pluginRoot = writePreManagedLlamaCppProviderFixture();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tempDirs.make("openclaw-plugin-loader-");

    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["llama-cpp"],
      config: {
        plugins: {
          enabled: true,
          load: { paths: [pluginRoot] },
          allow: ["llama-cpp"],
          entries: { "llama-cpp": { enabled: true } },
        },
      },
    });

    expect(registry.plugins.find((plugin) => plugin.id === "llama-cpp")?.status).toBe("loaded");
  });

  it("loads published pre-split SDK bridge imports (doctor repair, WhatsApp ack, Slack render)", async () => {
    const { loadOpenClawPlugins } = await importFreshModule<typeof import("./loader.js")>(
      import.meta.url,
      "./loader.js?scope=sdk-bridge-upgrade-compat",
    );
    const pluginRoot = writePreSplitSdkBridgeConsumerFixture();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tempDirs.make("openclaw-plugin-loader-");

    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["sdk-bridge-consumer"],
      config: {
        plugins: {
          enabled: true,
          load: { paths: [pluginRoot] },
          allow: ["sdk-bridge-consumer"],
          entries: { "sdk-bridge-consumer": { enabled: true } },
        },
      },
    });

    const entry = registry.plugins.find((plugin) => plugin.id === "sdk-bridge-consumer");
    expect(entry?.error ?? null).toBeNull();
    expect(entry?.status).toBe("loaded");
  });
});
