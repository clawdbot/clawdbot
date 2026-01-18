import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadClawdbotPlugins } from "./loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const tempDirs: string[] = [];
const prevBundledDir = process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR;

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `clawdbot-plugin-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePlugin(params: { id: string; body: string }): TempPlugin {
  const dir = makeTempDir();
  const file = path.join(dir, `${params.id}.js`);
  fs.writeFileSync(file, params.body, "utf-8");
  return { dir, file, id: params.id };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  if (prevBundledDir === undefined) {
    delete process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = prevBundledDir;
  }
});

describe("loadClawdbotPlugins", () => {
  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    const bundledPath = path.join(bundledDir, "bundled.ts");
    fs.writeFileSync(bundledPath, "export default function () {}", "utf-8");
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "bundled");
    expect(bundled?.status).toBe("disabled");

    const enabledRegistry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
          entries: {
            bundled: { enabled: true },
          },
        },
      },
    });

    const enabled = enabledRegistry.plugins.find((entry) => entry.id === "bundled");
    expect(enabled?.status).toBe("loaded");
  });

  it("enables bundled memory plugin when selected by slot", () => {
    const bundledDir = makeTempDir();
    const bundledPath = path.join(bundledDir, "memory-core.ts");
    fs.writeFileSync(
      bundledPath,
      'export default { id: "memory-core", kind: "memory", register() {} };',
      "utf-8",
    );
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "memory-core");
    fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@clawdbot/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
        clawdbot: { extensions: ["./index.ts"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.ts"),
      'export default { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
      "utf-8",
    );

    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });
  it("loads plugins from config paths", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "allowed",
      body: `export default function (api) { api.registerGatewayMethod("allowed.ping", ({ respond }) => respond(true, { ok: true })); }`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["allowed"],
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "allowed");
    expect(loaded?.status).toBe("loaded");
    expect(Object.keys(registry.gatewayHandlers)).toContain("allowed.ping");
  });

  it("denylist disables plugins even if allowed", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "blocked",
      body: `export default function () {}`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["blocked"],
          deny: ["blocked"],
        },
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "blocked");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "configurable",
      body: `export default {\n  id: "configurable",\n  configSchema: {\n    parse(value) {\n      if (!value || typeof value !== "object" || Array.isArray(value)) {\n        throw new Error("bad config");\n      }\n      return value;\n    }\n  },\n  register() {}\n};`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            configurable: {
              config: "nope" as unknown as Record<string, unknown>,
            },
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "configurable");
    expect(configurable?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("registers channel plugins", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "channel-demo",
      body: `export default function (api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "demo channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
};`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["channel-demo"],
        },
      },
    });

    const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
    expect(channel).toBeDefined();
  });

  it("registers http handlers", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "http-demo",
      body: `export default function (api) {
  api.registerHttpHandler(async () => false);
};`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["http-demo"],
        },
      },
    });

    const handler = registry.httpHandlers.find((entry) => entry.pluginId === "http-demo");
    expect(handler).toBeDefined();
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-demo");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("respects explicit disable in config", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "config-disable",
      body: `export default function () {}`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "config-disable": { enabled: false },
          },
        },
      },
    });

    const disabled = registry.plugins.find((entry) => entry.id === "config-disable");
    expect(disabled?.status).toBe("disabled");
  });

  it("enforces memory slot selection", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memoryA = writePlugin({
      id: "memory-a",
      body: `export default { id: "memory-a", kind: "memory", register() {} };`,
    });
    const memoryB = writePlugin({
      id: "memory-b",
      body: `export default { id: "memory-b", kind: "memory", register() {} };`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memoryA.file, memoryB.file] },
          slots: { memory: "memory-b" },
        },
      },
    });

    const a = registry.plugins.find((entry) => entry.id === "memory-a");
    const b = registry.plugins.find((entry) => entry.id === "memory-b");
    expect(b?.status).toBe("loaded");
    expect(a?.status).toBe("disabled");
  });

  it("disables memory plugins when slot is none", () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memory = writePlugin({
      id: "memory-off",
      body: `export default { id: "memory-off", kind: "memory", register() {} };`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memory.file] },
          slots: { memory: "none" },
        },
      },
    });

    const entry = registry.plugins.find((item) => item.id === "memory-off");
    expect(entry?.status).toBe("disabled");
  });

  it("prefers higher-precedence plugins with the same id", () => {
    const bundledDir = makeTempDir();
    fs.writeFileSync(path.join(bundledDir, "shadow.js"), "export default function () {}", "utf-8");
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = bundledDir;

    const override = writePlugin({
      id: "shadow",
      body: `export default function () {}`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [override.file] },
          entries: {
            shadow: { enabled: true },
          },
        },
      },
    });

    const entries = registry.plugins.filter((entry) => entry.id === "shadow");
    const loaded = entries.find((entry) => entry.status === "loaded");
    const overridden = entries.find((entry) => entry.status === "disabled");
    expect(loaded?.origin).toBe("config");
    expect(overridden?.origin).toBe("bundled");
  });
});
