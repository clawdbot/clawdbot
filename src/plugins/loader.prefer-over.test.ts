import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-prefer-over-"));
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o755);
  }
  tempDirs.push(dir);
  return dir;
}

function writeChannelToolPlugin(params: {
  rootDir: string;
  id: string;
  channelId: string;
  enabledByDefault?: boolean;
  preferOver?: string[];
}): string {
  const pluginDir = path.join(params.rootDir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(pluginDir, 0o755);
  }
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        channels: [params.channelId],
        ...(params.enabledByDefault ? { enabledByDefault: true } : {}),
        channelConfigs: {
          [params.channelId]: {
            schema: { type: "object" },
            ...(params.preferOver ? { preferOver: params.preferOver } : {}),
          },
        },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: ${JSON.stringify(params.id)},
      register(api) {
        api.registerChannel({
          plugin: {
            id: ${JSON.stringify(params.channelId)},
            meta: {
              id: ${JSON.stringify(params.channelId)},
              label: ${JSON.stringify(params.channelId)},
              selectionLabel: ${JSON.stringify(params.channelId)},
              docsPath: ${JSON.stringify(`/channels/${params.channelId}`)},
              blurb: "fixture channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
        api.registerTool({
          name: "qqbot_remind",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { name: "qqbot_remind" });
      },
    };`,
    "utf-8",
  );
  return pluginDir;
}

afterEach(() => {
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin loader preferOver activation", () => {
  it("loads the preferred external channel plugin without the replaced bundled plugin tools", () => {
    const bundledRoot = makeTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
    });
    const externalRoot = makeTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makeTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const rawConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      plugins: { load: { paths: [externalPluginDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(autoEnabled.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
    expect(autoEnabled.config.plugins?.entries?.qqbot?.enabled).toBe(false);
    expect(registry.plugins.find((plugin) => plugin.id === "openclaw-qqbot")?.status).toBe(
      "loaded",
    );
    expect(registry.plugins.find((plugin) => plugin.id === "qqbot")?.status).toBe("disabled");
    expect(registry.tools.map((tool) => tool.pluginId)).toEqual(["openclaw-qqbot"]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "plugin tool name conflict",
    );
  });

  it("blocks tools from a plugin that loses a duplicate channel registration", () => {
    const bundledRoot = makeTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
    });
    const externalRoot = makeTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
    });
    const env = {
      OPENCLAW_STATE_DIR: makeTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: { qqbot: { appId: "app", clientSecret: "secret" } },
        plugins: {
          load: { paths: [externalPluginDir] },
          entries: {
            qqbot: { enabled: true },
            "openclaw-qqbot": { enabled: true },
          },
        },
      },
      env,
    });

    const diagnostics = registry.diagnostics.map((diag) => diag.message).join("\n");
    expect(diagnostics).toContain("channel already registered: qqbot");
    expect(diagnostics).not.toContain("plugin tool name conflict");
    expect(registry.tools.map((tool) => tool.pluginId)).toHaveLength(1);
  });
});
