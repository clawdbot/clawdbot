import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  inlineChannelPluginEntryFactorySource,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("plugin loader CLI metadata", () => {
  it("suppresses trust warning logs during CLI metadata loads", async () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    const globalDir = path.join(stateDir, "extensions", "rogue");
    fs.mkdirSync(globalDir, { recursive: true });
    writePlugin({
      id: "rogue",
      dir: globalDir,
      filename: "index.cjs",
      body: `module.exports = {
  id: "rogue",
  register(api) {
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "rogue",
          description: "Rogue CLI metadata",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
    });

    const warnings: string[] = [];
    const registry = await loadOpenClawPluginCliRegistry({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      logger: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
        debug: () => {},
      },
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    expect(warnings).toEqual([]);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain("rogue");
  });

  it("passes validated plugin config into non-activating CLI metadata loads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "config-cli",
      filename: "config-cli.cjs",
      body: `module.exports = {
  id: "config-cli",
  register(api) {
    if (!api.pluginConfig || api.pluginConfig.token !== "ok") {
      throw new Error("missing plugin config");
    }
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "cfg",
          description: "Config-backed CLI command",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "config-cli",
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              token: { type: "string" },
            },
            required: ["token"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["config-cli"],
          entries: {
            "config-cli": {
              config: {
                token: "ok",
              },
            },
          },
        },
      },
    });

    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain("cfg");
    expect(registry.plugins.find((entry) => entry.id === "config-cli")?.status).toBe("loaded");
  });

  it("uses the real channel entry in cli-metadata mode for CLI metadata capture", async () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(pluginDir, "full-loaded.txt");
    const modeMarker = path.join(pluginDir, "registration-mode.txt");
    const runtimeMarker = path.join(pluginDir, "runtime-set.txt");

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/cli-metadata-channel",
          openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-entry.cjs" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "cli-metadata-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["cli-metadata-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `${inlineChannelPluginEntryFactorySource()}
require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  ...defineChannelPluginEntry({
    id: "cli-metadata-channel",
    name: "CLI Metadata Channel",
    description: "cli metadata channel",
    setRuntime() {
      require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf-8");
    },
    plugin: {
      id: "cli-metadata-channel",
      meta: {
        id: "cli-metadata-channel",
        label: "CLI Metadata Channel",
        selectionLabel: "CLI Metadata Channel",
        docsPath: "/channels/cli-metadata-channel",
        blurb: "cli metadata channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      outbound: { deliveryMode: "direct" },
    },
    registerCliMetadata(api) {
      require("node:fs").writeFileSync(
        ${JSON.stringify(modeMarker)},
        String(api.registrationMode),
        "utf-8",
      );
      api.registerCli(() => {}, {
        descriptors: [
          {
            name: "cli-metadata-channel",
            description: "Channel CLI metadata",
            hasSubcommands: true,
          },
        ],
      });
    },
    registerFull() {
      throw new Error("full channel entry should not run during CLI metadata capture");
    },
  }),
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `throw new Error("setup entry should not load during CLI metadata capture");`,
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["cli-metadata-channel"],
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(true);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
    expect(fs.readFileSync(modeMarker, "utf-8")).toBe("cli-metadata");
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain(
      "cli-metadata-channel",
    );
  });

  it("skips bundled channel full entries that do not provide a dedicated cli-metadata entry", async () => {
    const bundledRoot = makeTempDir();
    const pluginDir = path.join(bundledRoot, "bundled-skip-channel");
    const fullMarker = path.join(pluginDir, "full-loaded.txt");

    fs.mkdirSync(pluginDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/bundled-skip-channel",
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "bundled-skip-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["bundled-skip-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "bundled-skip-channel",
  register() {
    throw new Error("bundled channel full entry should not load during CLI metadata capture");
  },
};`,
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          allow: ["bundled-skip-channel"],
          entries: {
            "bundled-skip-channel": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(false);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).not.toContain(
      "bundled-skip-channel",
    );
    expect(registry.plugins.find((entry) => entry.id === "bundled-skip-channel")?.status).toBe(
      "loaded",
    );
  });

  it("prefers bundled channel cli-metadata entries over full channel entries", async () => {
    const bundledRoot = makeTempDir();
    const pluginDir = path.join(bundledRoot, "bundled-cli-channel");
    const fullMarker = path.join(pluginDir, "full-loaded.txt");
    const cliMarker = path.join(pluginDir, "cli-loaded.txt");

    fs.mkdirSync(pluginDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/bundled-cli-channel",
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "bundled-cli-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["bundled-cli-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "bundled-cli-channel",
  register() {
    throw new Error("bundled channel full entry should not load during CLI metadata capture");
  },
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "cli-metadata.cjs"),
      `module.exports = {
  id: "bundled-cli-channel",
  register(api) {
    require("node:fs").writeFileSync(${JSON.stringify(cliMarker)}, "loaded", "utf-8");
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "bundled-cli-channel",
          description: "Bundled channel CLI metadata",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          allow: ["bundled-cli-channel"],
          entries: {
            "bundled-cli-channel": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(false);
    expect(fs.existsSync(cliMarker)).toBe(true);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain(
      "bundled-cli-channel",
    );
  });

  it("skips bundled non-channel full entries that do not provide a dedicated cli-metadata entry", async () => {
    const bundledRoot = makeTempDir();
    const pluginDir = path.join(bundledRoot, "bundled-skip-provider");
    const fullMarker = path.join(pluginDir, "full-loaded.txt");

    fs.mkdirSync(pluginDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/bundled-skip-provider",
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "bundled-skip-provider",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "bundled-skip-provider",
  register() {
    throw new Error("bundled provider full entry should not load during CLI metadata capture");
  },
};`,
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          allow: ["bundled-skip-provider"],
          entries: {
            "bundled-skip-provider": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(false);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).not.toContain(
      "bundled-skip-provider",
    );
    expect(registry.plugins.find((entry) => entry.id === "bundled-skip-provider")?.status).toBe(
      "loaded",
    );
  });

  it("collects channel CLI metadata during full plugin loads", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const modeMarker = path.join(pluginDir, "registration-mode.txt");
    const fullMarker = path.join(pluginDir, "full-loaded.txt");

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/full-cli-metadata-channel",
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "full-cli-metadata-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["full-cli-metadata-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `${inlineChannelPluginEntryFactorySource()}
module.exports = {
  ...defineChannelPluginEntry({
    id: "full-cli-metadata-channel",
    name: "Full CLI Metadata Channel",
    description: "full cli metadata channel",
    plugin: {
      id: "full-cli-metadata-channel",
      meta: {
        id: "full-cli-metadata-channel",
        label: "Full CLI Metadata Channel",
        selectionLabel: "Full CLI Metadata Channel",
        docsPath: "/channels/full-cli-metadata-channel",
        blurb: "full cli metadata channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      outbound: { deliveryMode: "direct" },
    },
    registerCliMetadata(api) {
      require("node:fs").writeFileSync(
        ${JSON.stringify(modeMarker)},
        String(api.registrationMode),
        "utf-8",
      );
      api.registerCli(() => {}, {
        descriptors: [
          {
            name: "full-cli-metadata-channel",
            description: "Full-load channel CLI metadata",
            hasSubcommands: true,
          },
        ],
      });
    },
    registerFull() {
      require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
    },
  }),
};`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["full-cli-metadata-channel"],
        },
      },
    });

    expect(fs.readFileSync(modeMarker, "utf-8")).toBe("full");
    expect(fs.existsSync(fullMarker)).toBe(true);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain(
      "full-cli-metadata-channel",
    );
  });

  it("rejects async plugin registration when collecting CLI metadata", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "async-cli",
      filename: "async-cli.cjs",
      body: `module.exports = {
  id: "async-cli",
  async register(api) {
    await Promise.resolve();
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "async-cli",
          description: "Async CLI metadata",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
    });

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["async-cli"],
        },
      },
    });

    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).not.toContain("async-cli");
    const loaded = registry.plugins.find((entry) => entry.id === "async-cli");
    expect(loaded?.status).toBe("error");
    expect(loaded?.failurePhase).toBe("register");
    expect(loaded?.error).toContain("plugin register must be synchronous");
  });

  it("applies memory slot gating to non-bundled CLI metadata loads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "memory-external",
      filename: "memory-external.cjs",
      body: `module.exports = {
  id: "memory-external",
  kind: "memory",
  register(api) {
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "memory-external",
          description: "External memory CLI metadata",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "memory-external",
          kind: "memory",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["memory-external"],
          slots: { memory: "memory-other" },
        },
      },
    });

    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).not.toContain(
      "memory-external",
    );
    const memory = registry.plugins.find((entry) => entry.id === "memory-external");
    expect(memory?.status).toBe("disabled");
    expect(memory?.error ?? "").toContain('memory slot set to "memory-other"');
  });

  it("re-evaluates memory slot gating after resolving exported plugin kind", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "memory-export-only",
      filename: "memory-export-only.cjs",
      body: `module.exports = {
  id: "memory-export-only",
  kind: "memory",
  register(api) {
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "memory-export-only",
          description: "Export-only memory CLI metadata",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
    });

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["memory-export-only"],
          slots: { memory: "memory-other" },
        },
      },
    });

    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).not.toContain(
      "memory-export-only",
    );
    const memory = registry.plugins.find((entry) => entry.id === "memory-export-only");
    expect(memory?.status).toBe("disabled");
    expect(memory?.error ?? "").toContain('memory slot set to "memory-other"');
  });
});
