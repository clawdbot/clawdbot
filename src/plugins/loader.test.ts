import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadClawdbotPlugins } from "./loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const tempDirs: string[] = [];
const prevBundledDir = process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR;
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `clawdbot-plugin-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
}): TempPlugin {
  const dir = params.dir ?? makeTempDir();
  const filename = params.filename ?? `${params.id}.js`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "clawdbot.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
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
    writePlugin({
      id: "bundled",
      body: `export default { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.ts",
    });
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

  it("loads bundled telegram plugin when enabled", { timeout: 120_000 }, () => {
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = path.join(process.cwd(), "extensions");

    const registry = loadClawdbotPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      },
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(telegram?.status).toBe("loaded");
    expect(registry.channels.some((entry) => entry.plugin.id === "telegram")).toBe(true);
  });

  it("enables bundled memory plugin when selected by slot", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "memory-core",
      body: `export default { id: "memory-core", kind: "memory", register() {} };`,
      dir: bundledDir,
      filename: "memory-core.ts",
    });
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
    writePlugin({
      id: "memory-core",
      body: `export default { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };`,
      dir: pluginDir,
      filename: "index.ts",
    });

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
      body: `export default { id: "allowed", register(api) { api.registerGatewayMethod("allowed.ping", ({ respond }) => respond(true, { ok: true })); } };`,
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
      body: `export default { id: "blocked", register() {} };`,
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
      body: `export default { id: "configurable", register() {} };`,
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
      body: `export default { id: "channel-demo", register(api) {
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
} };`,
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
      body: `export default { id: "http-demo", register(api) {
  api.registerHttpHandler(async () => false);
} };`,
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
      body: `export default { id: "config-disable", register() {} };`,
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
    writePlugin({
      id: "shadow",
      body: `export default { id: "shadow", register() {} };`,
      dir: bundledDir,
      filename: "shadow.js",
    });
    process.env.CLAWDBOT_BUNDLED_PLUGINS_DIR = bundledDir;

    const override = writePlugin({
      id: "shadow",
      body: `export default { id: "shadow", register() {} };`,
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
