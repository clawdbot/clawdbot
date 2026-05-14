import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetFacadeRuntimeStateForTest } from "../plugin-sdk/facade-runtime.js";
import { setBundledPluginsDirOverrideForTest } from "../plugins/bundled-dir.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExternalAnthropicVertexPlugin(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/anthropic-vertex-provider",
      version: "0.0.0",
      type: "module",
      openclaw: {
        extensions: ["./index.js", "./api.js"],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "anthropic-vertex",
      providers: ["anthropic-vertex"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "api.js"),
    [
      "export function createAnthropicVertexStreamFnForModel(model, env) {",
      "  return async () => ({ marker: 'external-vertex', baseUrl: model.baseUrl, envMarker: env.OPENCLAW_TEST_MARKER });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "index.js"), "export default {};\n", "utf8");
}

afterEach(() => {
  vi.resetModules();
  clearRuntimeConfigSnapshot();
  resetFacadeRuntimeStateForTest();
  setBundledPluginsDirOverrideForTest(undefined);
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("anthropic-vertex stream facade", () => {
  it("loads the stream facade from an installed external provider when bundled surfaces are absent", async () => {
    const bundledDir = makeTempDir("openclaw-empty-bundled-vertex-");
    const stateDir = makeTempDir("openclaw-state-vertex-");
    const pluginRoot = makeTempDir("openclaw-external-vertex-");
    writeExternalAnthropicVertexPlugin(pluginRoot);
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "anthropic-vertex": {
          source: "npm",
          spec: "@openclaw/anthropic-vertex-provider",
          installPath: pluginRoot,
          resolvedName: "@openclaw/anthropic-vertex-provider",
          resolvedVersion: "0.0.0",
        },
      },
      { stateDir },
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setBundledPluginsDirOverrideForTest(bundledDir);
    setRuntimeConfigSnapshot({});

    const { createAnthropicVertexStreamFnForModel } = await import("./anthropic-vertex-stream.js");
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://us-central1-aiplatform.googleapis.com" },
      { OPENCLAW_TEST_MARKER: "registry" },
    );

    await expect(streamFn({} as never, {} as never, {} as never)).resolves.toEqual({
      marker: "external-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      envMarker: "registry",
    });
  });
});
