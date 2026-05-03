import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
} from "../plugin-sdk/agent-harness.js";
import { listAgentToolResultMiddlewares } from "../plugins/agent-tool-result-middleware.js";
import { listCodexAppServerExtensionFactories } from "../plugins/codex-app-server-extension-factory.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  cleanupTempPluginTestEnvironment,
  createTempPluginDir,
  resetActivePluginRegistryForTest,
  writeTempPlugin,
} from "./test-helpers/temp-plugin-extension-fixtures.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const tempDirs: string[] = [];

function createTempDir(): string {
  return createTempPluginDir(tempDirs, "openclaw-codex-ext-");
}

function createBundledTempDir(): string {
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  return createTempPluginDir(tempDirs, "openclaw-codex-ext-", {
    parentDir: path.join(process.cwd(), "dist-runtime", "extensions"),
  });
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  cleanupTempPluginTestEnvironment(
    tempDirs,
    originalBundledPluginsDir,
    originalDisableBundledPlugins,
  );
});

describe("agent tool result middleware", () => {
  it("includes plugin-registered middleware and restores it from cache", async () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
      filename: "index.mjs",
      manifest: {
        contracts: {
          agentToolResultMiddleware: ["codex"],
        },
      },
      body: `export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " compacted" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    const options = {
      config: {
        plugins: {
          entries: {
            "tool-result-middleware": {
              enabled: true,
            },
          },
        },
      },
      onlyPluginIds: ["tool-result-middleware"],
    };

    loadOpenClawPlugins(options);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
    expect(listAgentToolResultMiddlewares("pi")).toHaveLength(0);

    resetActivePluginRegistryForTest();
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);

    loadOpenClawPlugins(options);
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "exec compacted" }]);
  });

  it("rejects middleware when the manifest omits the runtime contract", () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
      filename: "index.mjs",
      manifest: {
        contracts: {
          agentToolResultMiddleware: ["pi"],
        },
      },
      body: `export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(() => undefined, { runtimes: ["codex"] });
} };`,
    });

    const registry = loadOpenClawPlugins({
      onlyPluginIds: ["tool-result-middleware"],
      config: {
        plugins: {
          entries: {
            "tool-result-middleware": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "tool-result-middleware",
        message: "plugin must declare contracts.agentToolResultMiddleware for: codex",
      }),
    );
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("rejects middleware from non-bundled plugins even when they declare the contract", () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
      manifest: {
        contracts: {
          agentToolResultMiddleware: ["codex"],
        },
      },
      body: `export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(() => undefined, { runtimes: ["codex"] });
} };`,
    });

    const registry = loadOpenClawPlugins({
      workspaceDir: tmp,
      onlyPluginIds: ["tool-result-middleware"],
      config: {
        plugins: {
          load: { paths: [pluginFile] },
          allow: ["tool-result-middleware"],
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "tool-result-middleware",
        message: "only bundled plugins can register agent tool result middleware",
      }),
    );
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("merges runtimes when a plugin registers the same middleware function twice", () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
      filename: "index.mjs",
      manifest: {
        contracts: {
          agentToolResultMiddleware: ["pi", "codex"],
        },
      },
      body: `const middleware = () => undefined;
export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(middleware, { runtimes: ["pi"] });
  api.registerAgentToolResultMiddleware(middleware, { runtimes: ["codex"] });
} };`,
    });

    loadOpenClawPlugins({
      onlyPluginIds: ["tool-result-middleware"],
      config: {
        plugins: {
          entries: {
            "tool-result-middleware": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(listAgentToolResultMiddlewares("pi")).toHaveLength(1);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
  });

  it("lazily loads bundled middleware owners from manifest contracts", async () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
      filename: "index.mjs",
      manifest: {
        activation: {
          onStartup: false,
        },
        contracts: {
          agentToolResultMiddleware: ["codex"],
        },
      },
      body: `export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " lazily compacted" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          "tool-result-middleware": {
            enabled: true,
          },
        },
      },
    });
    resetActivePluginRegistryForTest();

    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "exec lazily compacted" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });
});

describe("Codex app-server extension factories", () => {
  it("includes plugin-registered Codex app-server extension factories and restores them from cache", async () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "codex-ext",
      filename: "index.mjs",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["codex-app-server"],
        },
      },
      body: `export default { id: "codex-ext", register(api) {
  api.registerCodexAppServerExtensionFactory((codex) => {
    codex.on("tool_result", async (event) => ({
      result: { ...event.result, content: [{ type: "text", text: "compacted" }] }
    }));
  });
} };`,
    });

    const options = {
      config: {
        plugins: {
          entries: {
            "codex-ext": {
              enabled: true,
            },
          },
        },
      },
      onlyPluginIds: ["codex-ext"],
    };

    loadOpenClawPlugins(options);
    expect(listCodexAppServerExtensionFactories()).toHaveLength(1);

    resetActivePluginRegistryForTest();
    expect(listCodexAppServerExtensionFactories()).toHaveLength(0);

    loadOpenClawPlugins(options);
    const runner = createCodexAppServerToolResultExtensionRunner({});
    const result = await runner.applyToolResultExtensions({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "compacted" }]);
  });

  it("rejects Codex app-server extension factories from non-bundled plugins even when they declare the contract", () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "codex-ext",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["codex-app-server"],
        },
      },
      body: `export default { id: "codex-ext", register(api) {
  api.registerCodexAppServerExtensionFactory(() => undefined);
} };`,
    });

    const registry = loadOpenClawPlugins({
      workspaceDir: tmp,
      onlyPluginIds: ["codex-ext"],
      config: {
        plugins: {
          load: { paths: [pluginFile] },
          allow: ["codex-ext"],
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "codex-ext",
        message: "only bundled plugins can register Codex app-server extension factories",
      }),
    );
    expect(listCodexAppServerExtensionFactories()).toHaveLength(0);
  });

  it("rejects bundled plugins that omit the Codex app-server extension contract", () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "codex-ext",
      filename: "index.mjs",
      body: `export default { id: "codex-ext", register(api) {
  api.registerCodexAppServerExtensionFactory(() => undefined);
} };`,
    });

    const registry = loadOpenClawPlugins({
      onlyPluginIds: ["codex-ext"],
      config: {
        plugins: {
          entries: {
            "codex-ext": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "codex-ext",
        message:
          'plugin must declare contracts.embeddedExtensionFactories: ["codex-app-server"] to register Codex app-server extension factories',
      }),
    );
    expect(listCodexAppServerExtensionFactories()).toHaveLength(0);
  });

  it("rejects non-function Codex app-server extension factories from bundled plugins", () => {
    const tmp = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tmp;

    writeTempPlugin({
      dir: tmp,
      id: "codex-ext",
      filename: "index.mjs",
      manifest: {
        contracts: {
          embeddedExtensionFactories: ["codex-app-server"],
        },
      },
      body: `export default { id: "codex-ext", register(api) {
  api.registerCodexAppServerExtensionFactory("not-a-function");
} };`,
    });

    const registry = loadOpenClawPlugins({
      onlyPluginIds: ["codex-ext"],
      config: {
        plugins: {
          entries: {
            "codex-ext": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "codex-ext",
        message: "codex app-server extension factory must be a function",
      }),
    );
    expect(listCodexAppServerExtensionFactories()).toHaveLength(0);
  });

  it("initializes async Codex app-server extension factories in registration order", async () => {
    const steps: string[] = [];
    const runner = createCodexAppServerToolResultExtensionRunner({}, [
      async (codex) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        codex.on("tool_result", async ({ result }) => {
          steps.push("first");
          return {
            result: {
              ...result,
              content: [{ type: "text", text: `${result.content[0]?.type}:${steps.length}` }],
            },
          };
        });
      },
      async (codex) => {
        codex.on("tool_result", async ({ result }) => {
          steps.push("second");
          return { result };
        });
      },
    ]);

    await runner.applyToolResultExtensions({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(steps).toEqual(["first", "second"]);
  });
});
