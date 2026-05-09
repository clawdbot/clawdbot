import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

function writeBundledPluginFixture(id: string) {
  const pluginRoot = makeTempDir();
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
  const pluginRoot = makeTempDir();
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

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./plugin-module-loader-cache.js");
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = makeTempDir();

    const registry = loadOpenClawPlugins({
      cache: false,
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
});
