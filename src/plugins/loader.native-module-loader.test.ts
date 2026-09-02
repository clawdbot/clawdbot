/** Verifies plugin loader behavior for native module loading and resolver hooks. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resetPluginCache } from "./plugin-cache.js";
import { getPluginModuleLoaderStats } from "./plugin-module-loader-cache.js";

const tempDirs = createTempDirTracker();

function writeJavaScriptPluginFixture(id: string) {
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
  const pluginRoot = writeJavaScriptPluginFixture(id);
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
  // Covers both alias classes on purpose: runtime-doctor is private-local-only,
  // the channel subpaths are public. A source checkout has no dist/, so every
  // subpath listed here is evaluated through jiti — keep them light.
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
  resetPluginCache();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("createPluginModuleLoader", () => {
  it("loads bundled JavaScript natively without source transformation", () => {
    const pluginRoot = writeJavaScriptPluginFixture("demo");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", pluginRoot);

    const before = getPluginModuleLoaderStats();
    const registry = loadOpenClawPlugins({
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

    const after = getPluginModuleLoaderStats();
    expect(registry.plugins.find((plugin) => plugin.id === "demo")).toMatchObject({
      status: "loaded",
      origin: "bundled",
    });
    expect(after.nativeHits).toBeGreaterThan(before.nativeHits);
    expect(after.sourceTransformForced).toBe(before.sourceTransformForced);
    expect(after.sourceTransformFallbacks).toBe(before.sourceTransformFallbacks);
  });

  it("loads packaged JavaScript natively without source transformation", () => {
    const pluginRoot = writePackagedPluginFixture("npm-demo");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", tempDirs.make("openclaw-plugin-loader-"));

    const before = getPluginModuleLoaderStats();
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

    const after = getPluginModuleLoaderStats();
    expect(registry.plugins.find((plugin) => plugin.id === "npm-demo")?.status).toBe("loaded");
    expect(after.nativeHits).toBeGreaterThan(before.nativeHits);
    expect(after.sourceTransformForced).toBe(before.sourceTransformForced);
    expect(after.sourceTransformFallbacks).toBe(before.sourceTransformFallbacks);
  });

  it("loads published pre-split SDK bridge imports (doctor repair, WhatsApp ack, Slack render)", () => {
    const pluginRoot = writePreSplitSdkBridgeConsumerFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", tempDirs.make("openclaw-plugin-loader-"));

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
