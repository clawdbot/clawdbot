import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { listEmbeddedExtensionFactories } from "../plugins/embedded-extension-factory.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../plugins/loader.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { buildEmbeddedExtensionFactories } from "./pi-embedded-runner/extensions.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-embedded-ext-"));
  tempDirs.push(dir);
  return dir;
}

function writeTempPlugin(params: {
  dir: string;
  id: string;
  body: string;
  manifest?: Record<string, unknown>;
  filename?: string;
}): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, params.filename ?? `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        ...params.manifest,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearPluginLoaderCache();
  setActivePluginRegistry(createEmptyPluginRegistry());
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("buildEmbeddedExtensionFactories", () => {
  it("includes plugin-registered embedded extension factories and restores them from cache", async () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "embedded-ext",
      filename: "index.mjs",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["pi"],
        },
      },
      body: `export default { id: "embedded-ext", register(api) {
  api.registerEmbeddedExtensionFactory((pi) => {
    pi.on("session_start", () => undefined);
  });
} };`,
    });

    const options = {
      config: {
        plugins: {
          entries: {
            "embedded-ext": {
              enabled: true,
            },
          },
        },
      },
    };

    loadOpenClawPlugins(options);

    const firstFactories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    expect(firstFactories).toHaveLength(1);
    expect(listEmbeddedExtensionFactories()).toHaveLength(1);

    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(listEmbeddedExtensionFactories()).toHaveLength(0);

    loadOpenClawPlugins(options);

    const cachedFactories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    expect(cachedFactories).toHaveLength(1);

    const handlers = new Map<string, Function>();
    await cachedFactories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    expect(handlers.has("session_start")).toBe(true);
  });

  it("rejects embedded extension factories from non-bundled plugins even when they declare the Pi manifest contract", () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "embedded-ext",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["pi"],
        },
      },
      body: `export default { id: "embedded-ext", register(api) {
  api.registerEmbeddedExtensionFactory((pi) => {
    pi.on("session_start", () => undefined);
  });
} };`,
    });

    const registry = loadOpenClawPlugins({
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginFile] },
          allow: ["embedded-ext"],
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "embedded-ext",
        message: "only bundled plugins can register Pi embedded extension factories",
      }),
    );
    expect(listEmbeddedExtensionFactories()).toHaveLength(0);
    expect(
      buildEmbeddedExtensionFactories({
        cfg: undefined,
        sessionManager: SessionManager.inMemory(),
        provider: "openai",
        modelId: "gpt-5.4",
        model: undefined,
      }),
    ).toHaveLength(0);
  });

  it("rejects bundled plugins that omit the Pi embedded extension manifest contract", () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "embedded-ext",
      filename: "index.mjs",
      body: `export default { id: "embedded-ext", register(api) {
  api.registerEmbeddedExtensionFactory((pi) => {
    pi.on("session_start", () => undefined);
  });
} };`,
    });

    const registry = loadOpenClawPlugins({
      config: {
        plugins: {
          entries: {
            "embedded-ext": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "embedded-ext",
        message:
          'plugin must declare contracts.embeddedExtensionFactories: ["pi"] to register Pi embedded extension factories',
      }),
    );
    expect(listEmbeddedExtensionFactories()).toHaveLength(0);
  });

  it("rejects non-function embedded extension factories from bundled plugins", () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "embedded-ext",
      filename: "index.mjs",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["pi"],
        },
      },
      body: `export default { id: "embedded-ext", register(api) {
  api.registerEmbeddedExtensionFactory("not-a-function");
} };`,
    });

    const registry = loadOpenClawPlugins({
      config: {
        plugins: {
          entries: {
            "embedded-ext": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "embedded-ext",
        message: "embedded extension factory must be a function",
      }),
    );
    expect(listEmbeddedExtensionFactories()).toHaveLength(0);
  });

  it("contains embedded extension factory failures so one bad plugin cannot crash setup", async () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "embedded-ext",
      filename: "index.mjs",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["pi"],
        },
      },
      body: `export default { id: "embedded-ext", register(api) {
  api.registerEmbeddedExtensionFactory(() => {
    throw new Error("boom");
  });
} };`,
    });

    loadOpenClawPlugins({
      config: {
        plugins: {
          entries: {
            "embedded-ext": {
              enabled: true,
            },
          },
        },
      },
    });

    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    expect(factories).toHaveLength(1);

    await expect(
      factories[0]?.({
        on() {},
      } as never),
    ).resolves.toBeUndefined();
  });
});
