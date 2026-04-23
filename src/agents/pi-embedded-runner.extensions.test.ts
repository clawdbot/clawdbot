import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { listEmbeddedExtensionFactories } from "../plugins/embedded-extension-factory.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { buildEmbeddedExtensionFactories } from "./pi-embedded-runner/extensions.js";
import {
  cleanupTempPluginTestEnvironment,
  createTempPluginDir,
  resetActivePluginRegistryForTest,
  writeTempPlugin,
} from "./test-helpers/temp-plugin-extension-fixtures.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const tempDirs: string[] = [];

function createTempDir(): string {
  return createTempPluginDir(tempDirs, "openclaw-embedded-ext-");
}

afterEach(() => {
  cleanupTempPluginTestEnvironment(tempDirs, originalBundledPluginsDir);
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

    resetActivePluginRegistryForTest();
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
