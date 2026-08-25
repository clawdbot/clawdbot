// Verifies plugin loader prefer-over selection behavior. Cede mechanics are covered by the
// loader.prefer-over.cede.test.ts sibling, split out to stay within the file-size budget.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs: string[] = [];

function makePluginLoaderTempDir(): string {
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
        contracts: { tools: ["qqbot_remind"] },
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

function writeMultiChannelPlugin(params: {
  rootDir: string;
  id: string;
  channelIds: string[];
  channelConfigIds?: string[];
  toolName: string;
  preferOver?: Record<string, string[]>;
}): string {
  const pluginDir = path.join(params.rootDir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(pluginDir, 0o755);
  }
  const channelConfigs = Object.fromEntries(
    (params.channelConfigIds ?? params.channelIds).map((channelId) => [
      channelId,
      {
        schema: { type: "object" },
        ...(params.preferOver?.[channelId] ? { preferOver: params.preferOver[channelId] } : {}),
      },
    ]),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        channels: params.channelIds,
        contracts: { tools: [params.toolName] },
        channelConfigs,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  const registrations = params.channelIds
    .map(
      (channelId) => `api.registerChannel({
          plugin: {
            id: ${JSON.stringify(channelId)},
            meta: {
              id: ${JSON.stringify(channelId)},
              label: ${JSON.stringify(channelId)},
              selectionLabel: ${JSON.stringify(channelId)},
              docsPath: ${JSON.stringify(`/channels/${channelId}`)},
              blurb: "fixture channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });`,
    )
    .join("\n        ");
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: ${JSON.stringify(params.id)},
      register(api) {
        ${registrations}
        api.registerTool({
          name: ${JSON.stringify(params.toolName)},
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { name: ${JSON.stringify(params.toolName)} });
      },
    };`,
    "utf-8",
  );
  return pluginDir;
}

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin loader preferOver activation", () => {
  it("loads the preferred external channel plugin without the replaced bundled plugin tools", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
      preferOver: ["qqbot"],
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
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

  // A replacement that only claims zzalpha must not decide zzbeta, and the plugin that yields
  // zzalpha must keep its tools. Before the loader read the declaration, discovery order decided
  // the channel: one order stripped the fallback's tools, the other handed zzalpha to the fallback
  // and blocked the replacement instead.
  it.each([
    { name: "replacement discovered first", replacementFirst: true },
    { name: "fallback discovered first", replacementFirst: false },
  ])("settles a contested channel by declaration when the $name", ({ replacementFirst }) => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: {
        load: {
          paths: replacementFirst ? [replacementDir, fallbackDir] : [fallbackDir, replacementDir],
        },
      },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    const owner = (channelId: string) =>
      registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
    // The declaration settles zzalpha; zzbeta was never contested.
    expect(owner("zzalpha")).toBe("zz-replacement");
    expect(owner("zzbeta")).toBe("zz-fallback");
    // Yielding a channel is not a duplicate registration, so neither plugin loses its tools.
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "zz-fallback",
      "zz-replacement",
    ]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "channel already registered",
    );
  });

  // `channelConfigs` is optional per claim: the registry only warns when a declared channel has
  // no descriptor, and the channel still registers. Displacement gated on schema descriptors read
  // a bare claim as uncontested, so discovery order settled the one channel the replacement's
  // declaration exists to take.
  it.each([
    { name: "replacement discovered first", replacementFirst: true },
    { name: "fallback discovered first", replacementFirst: false },
  ])(
    "settles a channel the fallback claims without channelConfigs when the $name",
    ({ replacementFirst }) => {
      const root = makePluginLoaderTempDir();
      const fallbackDir = writeMultiChannelPlugin({
        rootDir: root,
        id: "zz-fallback",
        channelIds: ["zzalpha", "zzbeta"],
        channelConfigIds: ["zzbeta"],
        toolName: "zz_fallback_tool",
      });
      const replacementDir = writeMultiChannelPlugin({
        rootDir: root,
        id: "zz-replacement",
        channelIds: ["zzalpha"],
        toolName: "zz_replacement_tool",
        preferOver: { zzalpha: ["zz-fallback"] },
      });
      const env = {
        OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
        OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
      };
      const rawConfig = {
        channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
        plugins: {
          load: {
            paths: replacementFirst ? [replacementDir, fallbackDir] : [fallbackDir, replacementDir],
          },
        },
      };
      const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

      const registry = loadOpenClawPlugins({
        cache: false,
        config: autoEnabled.config,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: autoEnabled.autoEnabledReasons,
        env,
      });

      const owner = (channelId: string) =>
        registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
      expect(owner("zzalpha")).toBe("zz-replacement");
      expect(owner("zzbeta")).toBe("zz-fallback");
      expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
        "zz-fallback",
        "zz-replacement",
      ]);
      expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
        "channel already registered",
      );
    },
  );

  // The declaration does not have to live in the manifest. Auto-enable and schema ownership both
  // resolve built-in and external-catalog preferences, so runtime arbitration has to see the same
  // ones or it settles a catalog-declared replacement by discovery order instead.
  it.each([
    { name: "replacement discovered first", replacementFirst: true },
    { name: "fallback discovered first", replacementFirst: false },
  ])("honors a catalog-declared preference when the $name", ({ replacementFirst }) => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
    });
    const catalogDir = makePluginLoaderTempDir();
    const catalogPath = path.join(catalogDir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/zz-replacement",
            openclaw: {
              plugin: { id: "zz-replacement" },
              channel: { id: "zzalpha", preferOver: ["zz-fallback"] },
            },
          },
        ],
      }),
      "utf-8",
    );
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
      OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath,
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: {
        load: {
          paths: replacementFirst ? [replacementDir, fallbackDir] : [fallbackDir, replacementDir],
        },
      },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    const owner = (channelId: string) =>
      registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
    expect(owner("zzalpha")).toBe("zz-replacement");
    expect(owner("zzbeta")).toBe("zz-fallback");
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "zz-fallback",
      "zz-replacement",
    ]);
  });

  // Regression on #128904: cede planning resolves `preferOver` out of the external plugin
  // catalogs, whose location is decided entirely by `OPENCLAW_PLUGIN_CATALOG_PATHS`. Neither that
  // variable nor its sibling reached the discovery fingerprint or the activation metadata hash, so
  // two loads that differed only by catalog file shared one cache entry and the second inherited
  // the first's cede map — and with it the wrong runtime channel owner.
  it("does not reuse a cached registry across a different external catalog path", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
    });
    const writeCatalog = (preferOver: string[]): string => {
      const catalogPath = path.join(makePluginLoaderTempDir(), "catalog.json");
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          entries: [
            {
              name: "@openclaw/zz-replacement",
              openclaw: {
                plugin: { id: "zz-replacement" },
                channel: { id: "zzalpha", preferOver },
              },
            },
          ],
        }),
        "utf-8",
      );
      return catalogPath;
    };
    const preferringCatalog = writeCatalog(["zz-fallback"]);
    const neutralCatalog = writeCatalog([]);
    const baseEnv = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    // One catalog-free activation result feeds both loads on purpose: the catalog file is then the
    // only input that differs, which is exactly the pair the cache identity could not tell apart.
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env: baseEnv });
    const ownerWithCatalog = (catalogPath: string) =>
      loadOpenClawPlugins({
        config: autoEnabled.config,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: autoEnabled.autoEnabledReasons,
        env: { ...baseEnv, OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath },
      }).channels.find((entry) => entry.plugin.id === "zzalpha")?.pluginId;

    expect(ownerWithCatalog(preferringCatalog)).toBe("zz-replacement");
    expect(ownerWithCatalog(neutralCatalog)).toBe("zz-fallback");
  });

  // Neither claimant has to supply a descriptor at all: a catalog-declared preference between
  // two bare claims must still cede the channel, or the schemaless pair falls back to discovery
  // order.
  it.each([
    { name: "replacement discovered first", replacementFirst: true },
    { name: "fallback discovered first", replacementFirst: false },
  ])(
    "settles a channel with no channelConfigs on either claimant when the $name",
    ({ replacementFirst }) => {
      const root = makePluginLoaderTempDir();
      const fallbackDir = writeMultiChannelPlugin({
        rootDir: root,
        id: "zz-fallback",
        channelIds: ["zzalpha", "zzbeta"],
        channelConfigIds: ["zzbeta"],
        toolName: "zz_fallback_tool",
      });
      const replacementDir = writeMultiChannelPlugin({
        rootDir: root,
        id: "zz-replacement",
        channelIds: ["zzalpha"],
        channelConfigIds: [],
        toolName: "zz_replacement_tool",
      });
      const catalogDir = makePluginLoaderTempDir();
      const catalogPath = path.join(catalogDir, "catalog.json");
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          entries: [
            {
              name: "@openclaw/zz-replacement",
              openclaw: {
                plugin: { id: "zz-replacement" },
                channel: { id: "zzalpha", preferOver: ["zz-fallback"] },
              },
            },
          ],
        }),
        "utf-8",
      );
      const env = {
        OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
        OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
        OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath,
      };
      const rawConfig = {
        channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
        plugins: {
          load: {
            paths: replacementFirst ? [replacementDir, fallbackDir] : [fallbackDir, replacementDir],
          },
        },
      };
      const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

      const registry = loadOpenClawPlugins({
        cache: false,
        config: autoEnabled.config,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: autoEnabled.autoEnabledReasons,
        env,
      });

      const owner = (channelId: string) =>
        registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
      expect(owner("zzalpha")).toBe("zz-replacement");
      expect(owner("zzbeta")).toBe("zz-fallback");
      expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
        "zz-fallback",
        "zz-replacement",
      ]);
    },
  );

  // `preferOver` names a plugin the way its author wrote it, and a plugin's channel ids are among
  // its aliases. The config layer resolves those spellings, so runtime arbitration has to see the
  // same edge or it hands the channel to the plugin the declaration was written against.
  it("honors a preference that names the claimant by one of its channel ids", () => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha", "zzbeta"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
    });
    const catalogDir = makePluginLoaderTempDir();
    const catalogPath = path.join(catalogDir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/zz-replacement",
            openclaw: {
              plugin: { id: "zz-replacement" },
              // `zzbeta` is a channel of zz-fallback, so it resolves to that plugin.
              channel: { id: "zzalpha", preferOver: ["zzbeta"] },
            },
          },
        ],
      }),
      "utf-8",
    );
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
      OPENCLAW_PLUGIN_CATALOG_PATHS: catalogPath,
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" }, zzbeta: { token: "beta" } },
      plugins: { load: { paths: [fallbackDir, replacementDir] } },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    const owner = (channelId: string) =>
      registry.channels.find((entry) => entry.plugin.id === channelId)?.pluginId;
    expect(owner("zzalpha")).toBe("zz-replacement");
    expect(registry.tools.map((tool) => tool.pluginId).toSorted()).toEqual([
      "zz-fallback",
      "zz-replacement",
    ]);
  });

  // An operator's own choice outranks a manifest preference. Schema ownership skips displacing an
  // explicitly selected claimant, so runtime arbitration has to skip it too: registration order
  // owns the channel, the duplicate diagnostic stands, and both surfaces name the same owner.
  it.each([
    { name: "replacement registers second", replacementFirst: false },
    { name: "fallback registers second", replacementFirst: true },
  ])("keeps an explicitly selected owner when the $name", ({ replacementFirst }) => {
    const root = makePluginLoaderTempDir();
    const fallbackDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-fallback",
      channelIds: ["zzalpha"],
      toolName: "zz_fallback_tool",
    });
    const replacementDir = writeMultiChannelPlugin({
      rootDir: root,
      id: "zz-replacement",
      channelIds: ["zzalpha"],
      toolName: "zz_replacement_tool",
      preferOver: { zzalpha: ["zz-fallback"] },
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: makePluginLoaderTempDir(),
    };
    const rawConfig = {
      channels: { zzalpha: { token: "alpha" } },
      plugins: {
        entries: { "zz-fallback": { enabled: true }, "zz-replacement": { enabled: true } },
        load: {
          paths: replacementFirst ? [replacementDir, fallbackDir] : [fallbackDir, replacementDir],
        },
      },
    };
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    // Registration order decides, so the plugin listed first keeps the channel either way.
    const firstRegistered = replacementFirst ? "zz-replacement" : "zz-fallback";
    const runtimeOwner = registry.channels.find((entry) => entry.plugin.id === "zzalpha")?.pluginId;
    expect(runtimeOwner).toBe(firstRegistered);
    // The documented duplicate contract still applies to the claimant that lost the race.
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).toContain(
      "channel already registered",
    );

    // Both stay loaded: an explicit choice is never silently dropped for a manifest preference.
    expect(
      registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
    ).toEqual(expect.arrayContaining(["zz-fallback", "zz-replacement"]));
  });

  it("blocks tools from a plugin that loses a duplicate channel registration", () => {
    const bundledRoot = makePluginLoaderTempDir();
    writeChannelToolPlugin({
      rootDir: bundledRoot,
      id: "qqbot",
      channelId: "qqbot",
      enabledByDefault: true,
    });
    const externalRoot = makePluginLoaderTempDir();
    const externalPluginDir = writeChannelToolPlugin({
      rootDir: externalRoot,
      id: "openclaw-qqbot",
      channelId: "qqbot",
    });
    const env = {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
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
