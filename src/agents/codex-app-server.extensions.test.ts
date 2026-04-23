import { afterEach, describe, expect, it } from "vitest";
import { createCodexAppServerToolResultExtensionRunner } from "../plugin-sdk/agent-harness.js";
import { listCodexAppServerExtensionFactories } from "../plugins/codex-app-server-extension-factory.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  cleanupTempPluginTestEnvironment,
  createTempPluginDir,
  resetActivePluginRegistryForTest,
  writeTempPlugin,
} from "./test-helpers/temp-plugin-extension-fixtures.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const tempDirs: string[] = [];

function createTempDir(): string {
  return createTempPluginDir(tempDirs, "openclaw-codex-ext-");
}

afterEach(() => {
  cleanupTempPluginTestEnvironment(tempDirs, originalBundledPluginsDir);
});

describe("Codex app-server extension factories", () => {
  it("includes plugin-registered Codex app-server extension factories and restores them from cache", async () => {
    const tmp = createTempDir();
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
    const tmp = createTempDir();
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
    const tmp = createTempDir();
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
