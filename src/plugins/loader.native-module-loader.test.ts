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
});
