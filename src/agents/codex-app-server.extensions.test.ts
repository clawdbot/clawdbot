// Verifies plugin extension points that are exposed to the Codex app server.
import fs from "node:fs";
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

function findDiagnostic(
  diagnostics: readonly { level?: string; pluginId?: string; message?: string }[],
  pluginId: string,
  message: string,
): { level?: string; pluginId?: string; message?: string } | undefined {
  return diagnostics.find(
    (diagnostic) => diagnostic.pluginId === pluginId && diagnostic.message === message,
  );
}

function createTempDir(): string {
  return createTempPluginDir(tempDirs, "openclaw-codex-ext-");
}

function createBundledTempDir(): string {
  // Bundled-only extension points are tested from the dist-runtime shape because
  // production rejects equivalent registrations from arbitrary plugin paths.
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
    expect(listAgentToolResultMiddlewares("openclaw")).toHaveLength(0);

    resetActivePluginRegistryForTest();
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);

    // The second load proves manifest-backed discovery can restore middleware
    // after the active in-memory registry has been reset.
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
          agentToolResultMiddleware: ["openclaw"],
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

    const diagnostic = findDiagnostic(
      registry.diagnostics,
      "tool-result-middleware",
      "plugin must declare contracts.agentToolResultMiddleware for: codex",
    );
    expect(diagnostic?.level).toBe("error");
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("allows middleware from installed plugins when they declare the runtime contract", () => {
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
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " installed compacted" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    // Installed plugins can register Codex middleware only when explicitly
    // enabled and when their manifest declares the targeted runtime contract.
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

    expect(registry.diagnostics).not.toContainEqual(
      expect.objectContaining({
        pluginId: "tool-result-middleware",
        message: "only bundled plugins can register agent tool result middleware",
      }),
    );
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
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
          agentToolResultMiddleware: ["openclaw", "codex"],
        },
      },
      body: `const middleware = () => undefined;
export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(middleware, { runtimes: ["openclaw"] });
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

    expect(listAgentToolResultMiddlewares("openclaw")).toHaveLength(1);
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

    // Startup activation stays false here; the runner must load the owner only
    // when Codex asks for the middleware runtime.
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

  it("lazily loads installed middleware owners from manifest contracts", async () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
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
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " installed lazily compacted" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    setRuntimeConfigSnapshot({
      plugins: {
        load: { paths: [pluginFile] },
        allow: ["tool-result-middleware"],
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

    expect(result.content).toEqual([{ type: "text", text: "exec installed lazily compacted" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("does not lazily load installed middleware owners without explicit opt-in", async () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
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
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " should not run" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    setRuntimeConfigSnapshot({
      plugins: {
        load: { paths: [pluginFile] },
      },
    });
    resetActivePluginRegistryForTest();

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "raw" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("does not treat auto-enabled runtime config as explicit middleware opt-in", async () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
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
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " should not run" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    const sourceConfig = {
      plugins: {
        load: { paths: [pluginFile] },
      },
    };
    setRuntimeConfigSnapshot(
      {
        plugins: {
          load: { paths: [pluginFile] },
          entries: {
            "tool-result-middleware": {
              enabled: true,
            },
          },
        },
      },
      sourceConfig,
    );
    resetActivePluginRegistryForTest();

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "raw" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("forces full runtime load for setup-loaded installed middleware owners", async () => {
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "setup-channel-middleware",
      manifest: {
        channels: ["setup-channel-middleware"],
        channelConfigs: {
          "setup-channel-middleware": {
            schema: { type: "object", additionalProperties: false, properties: {} },
          },
        },
        contracts: {
          agentToolResultMiddleware: ["codex"],
        },
      },
      body: `export default { id: "setup-channel-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " setup-owner compacted" }] }
  }), { runtimes: ["codex"] });
} };`,
    });
    const pluginDir = path.dirname(pluginFile);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "setup-channel-middleware",
          version: "0.0.0",
          type: "module",
          openclaw: {
            extensions: [path.basename(pluginFile)],
            setupEntry: "setup.mjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup.mjs"),
      `export const plugin = {
  id: "setup-channel-middleware",
  meta: { id: "setup-channel-middleware", label: "Setup Channel Middleware" },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => undefined
  }
};`,
      "utf-8",
    );
    const config = {
      plugins: {
        load: { paths: [pluginDir] },
        allow: ["setup-channel-middleware"],
      },
    };

    loadOpenClawPlugins({ config });
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
    setRuntimeConfigSnapshot(config);

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "exec setup-owner compacted" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  });

  it("loads missing installed middleware when bundled middleware is already active", async () => {
    const bundledDir = createBundledTempDir();
    const installedDir = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    writeTempPlugin({
      dir: bundledDir,
      id: "bundled-tool-result-middleware",
      filename: "index.mjs",
      manifest: {
        contracts: {
          agentToolResultMiddleware: ["codex"],
        },
      },
      body: `export default { id: "bundled-tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.result.content[0].text + " | bundled" }] }
  }), { runtimes: ["codex"] });
} };`,
    });
    const installedPluginFile = writeTempPlugin({
      dir: installedDir,
      id: "installed-tool-result-middleware",
      manifest: {
        activation: {
          onStartup: false,
        },
        contracts: {
          agentToolResultMiddleware: ["codex"],
        },
      },
      body: `export default { id: "installed-tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.result.content[0].text + " | installed" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

    loadOpenClawPlugins({
      onlyPluginIds: ["bundled-tool-result-middleware"],
      config: {
        plugins: {
          entries: {
            "bundled-tool-result-middleware": {
              enabled: true,
            },
          },
        },
      },
    });
    setRuntimeConfigSnapshot({
      plugins: {
        load: { paths: [installedPluginFile] },
        allow: ["installed-tool-result-middleware"],
      },
    });

    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "git status" },
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "raw | bundled | installed" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
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

    // Factories are cached like middleware so app-server startup can recover
    // them after registry resets without reinterpreting arbitrary paths.
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

    // Embedded app-server hooks are core-facing: external plugin paths cannot
    // install factories even with a matching manifest contract.
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

    const diagnostic = findDiagnostic(
      registry.diagnostics,
      "codex-ext",
      "only bundled plugins can register Codex app-server extension factories",
    );
    expect(diagnostic?.level).toBe("error");
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

    const diagnostic = findDiagnostic(
      registry.diagnostics,
      "codex-ext",
      'plugin must declare contracts.embeddedExtensionFactories: ["codex-app-server"] to register Codex app-server extension factories',
    );
    expect(diagnostic?.level).toBe("error");
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

    const diagnostic = findDiagnostic(
      registry.diagnostics,
      "codex-ext",
      "codex app-server extension factory must be a function",
    );
    expect(diagnostic?.level).toBe("error");
    expect(listCodexAppServerExtensionFactories()).toHaveLength(0);
  });

  it("initializes async Codex app-server extension factories in registration order", async () => {
    const steps: string[] = [];
    let releaseFirstFactory: () => void = () => {};
    const firstFactoryCanContinue = new Promise<void>((resolve) => {
      releaseFirstFactory = resolve;
    });
    const runner = createCodexAppServerToolResultExtensionRunner({}, [
      async (codex) => {
        await firstFactoryCanContinue;
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

    // Awaiting each factory in order keeps later handlers from observing a
    // partially initialized earlier extension.
    releaseFirstFactory();
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
