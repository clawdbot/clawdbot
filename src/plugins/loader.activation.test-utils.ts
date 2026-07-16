// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getContextEngineRegistration } from "../context-engine/registry.js";
import { withEnv } from "../test-utils/env.js";
import { getCompactionProvider } from "./compaction-provider.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  mkdirSafe,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  countMatching,
  writeWorkspacePlugin,
  withStateDir,
  loadRegistryFromSinglePlugin,
  loadRegistryFromAllowedPlugins,
  runRegistryScenarios,
  runSinglePluginRegistryScenarios,
  loadRegistryFromScenarioPlugins,
  expectRegisteredHttpRoute,
  expectDuplicateRegistrationResult,
  expectRegistryErrorDiagnostic,
  expectDiagnosticContaining,
  expectNoDiagnosticContaining,
  createErrorLogger,
  expectCacheMissThenHit,
  globalAfterEach0,
  globalAfterAll1,
} from "./loader.test-harness.js";
import { listMemoryPromptSupplements } from "./memory-state.test-fixtures.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

describe("loadOpenClawPlugins", () => {
  it.each([
    {
      name: "does not reuse cached registries when env-resolved install paths change",
      setup: () => {
        useNoBundledPlugins();
        const openclawHome = makeTempDir();
        const ignoredHome = makeTempDir();
        const stateDir = makeTempDir();
        const pluginDir = path.join(openclawHome, "plugins", "tracked-install-cache");
        mkdirSafe(pluginDir);
        const plugin = writePlugin({
          id: "tracked-install-cache",
          dir: pluginDir,
          filename: "index.cjs",
          body: `module.exports = { id: "tracked-install-cache", register() {} };`,
        });

        writePersistedInstalledPluginIndexInstallRecordsSync(
          {
            "tracked-install-cache": {
              source: "path" as const,
              installPath: "~/plugins/tracked-install-cache",
              sourcePath: "~/plugins/tracked-install-cache",
            },
          },
          { stateDir },
        );

        const options = {
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["tracked-install-cache"],
            },
          },
        };

        const secondHome = makeTempDir();
        return {
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_HOME: openclawHome,
                HOME: ignoredHome,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
              },
            }),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_HOME: secondHome,
                HOME: ignoredHome,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across different plugin SDK resolution preferences",
      setup: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "cache-sdk-resolution",
          filename: "cache-sdk-resolution.cjs",
          body: `module.exports = { id: "cache-sdk-resolution", register() {} };`,
        });

        const options = {
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              allow: ["cache-sdk-resolution"],
              load: {
                paths: [plugin.file],
              },
            },
          },
        };

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              pluginSdkResolution: "workspace" as PluginSdkResolutionPreference,
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across gateway subagent binding modes",
      setup: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "cache-gateway-shared",
          filename: "cache-gateway-shared.cjs",
          body: `module.exports = { id: "cache-gateway-shared", register() {} };`,
        });

        const options = {
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              allow: ["cache-gateway-shared"],
              load: {
                paths: [plugin.file],
              },
            },
          },
        };

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              runtimeOptions: {
                allowGatewaySubagentBinding: true,
              },
            }),
        };
      },
    },
  ])("$name", ({ setup }) => {
    expectCacheMissThenHit(setup());
  });

  it("normalizes bundled plugin env overrides against the provided env", () => {
    const bundledDir = makeTempDir();
    const homeDir = path.dirname(bundledDir);
    const override = `~/${path.basename(bundledDir)}`;
    const plugin = writePlugin({
      id: "tilde-bundled",
      dir: path.join(bundledDir, "tilde-bundled"),
      filename: "index.cjs",
      body: `module.exports = { id: "tilde-bundled", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_HOME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: override,
      },
      config: {
        plugins: {
          allow: ["tilde-bundled"],
          entries: {
            "tilde-bundled": { enabled: true },
          },
        },
      },
    });

    expect(
      fs.realpathSync(registry.plugins.find((entry) => entry.id === "tilde-bundled")?.source ?? ""),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("prefers OPENCLAW_HOME over HOME for env-expanded load paths", () => {
    const ignoredHome = makeTempDir();
    const openclawHome = makeTempDir();
    const stateDir = makeTempDir();
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "openclaw-home-demo",
      dir: path.join(openclawHome, "plugins", "openclaw-home-demo"),
      filename: "index.cjs",
      body: `module.exports = { id: "openclaw-home-demo", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      env: {
        ...process.env,
        HOME: ignoredHome,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      },
      config: {
        plugins: {
          allow: ["openclaw-home-demo"],
          entries: {
            "openclaw-home-demo": { enabled: true },
          },
          load: {
            paths: ["~/plugins/openclaw-home-demo"],
          },
        },
      },
    });

    expect(
      fs.realpathSync(
        registry.plugins.find((entry) => entry.id === "openclaw-home-demo")?.source ?? "",
      ),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("loads plugins when source and root differ only by realpath alias", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "alias-safe",
      filename: "alias-safe.cjs",
      body: `module.exports = { id: "alias-safe", register() {} };`,
    });
    const realRoot = fs.realpathSync(plugin.dir);
    if (realRoot === plugin.dir) {
      return;
    }

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["alias-safe"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "alias-safe");
    expect(loaded?.status).toBe("loaded");
  });

  it("denylist disables plugins even if allowed", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "blocked",
      body: `module.exports = { id: "blocked", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["blocked"],
        deny: ["blocked"],
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "blocked");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "configurable",
      filename: "configurable.cjs",
      body: `module.exports = { id: "configurable", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        entries: {
          configurable: {
            config: "nope" as unknown as Record<string, unknown>,
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "configurable");
    expect(configurable?.status).toBe("error");
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "configurable",
      message: "invalid config",
    });
  });

  it("repairs incomplete registered channel metadata before storing registry entries", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "channel-meta-repair",
      filename: "channel-meta-repair.cjs",
      body: `module.exports = { id: "channel-meta-repair", register(api) {
    api.registerChannel({
      plugin: {
        id: "telegram",
        meta: {
          id: "telegram"
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

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["channel-meta-repair"],
      },
    });

    const telegram = registry.channels.find((entry) => entry.plugin.id === "telegram")?.plugin;
    expect(telegram?.meta.id).toBe("telegram");
    expect(telegram?.meta.label).toBe("Telegram");
    expect(telegram?.meta.docsPath).toBe("/channels/telegram");
    expectDiagnosticContaining({
      registry,
      level: "warn",
      message:
        'channel "telegram" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
    });
  });

  it("throws when strict plugin loading sees plugin errors", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "configurable",
      filename: "configurable.cjs",
      body: `module.exports = { id: "configurable", register() {} };`,
    });

    expect(() =>
      loadOpenClawPlugins({
        cache: false,
        throwOnLoadError: true,
        config: {
          plugins: {
            enabled: true,
            load: { paths: [plugin.file] },
            allow: ["configurable"],
            entries: {
              configurable: {
                enabled: true,
                config: "nope" as unknown as Record<string, unknown>,
              },
            },
          },
        },
      }),
    ).toThrow("plugin load failed: configurable: invalid config: <root>: must be object");
  });

  it("fails when plugin export id mismatches manifest id", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "manifest-id",
      filename: "manifest-id.cjs",
      body: `module.exports = { id: "export-id", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["manifest-id"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "manifest-id");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toBe(
      'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
    );
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "manifest-id",
      message: 'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
    });
  });

  it("can include plugin export shape when register is missing", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "missing-register-shape",
      filename: "missing-register-shape.cjs",
      body: `module.exports = { default: { default: { id: "missing-register-shape" } } };`,
    });

    const registry = withEnv({ OPENCLAW_PLUGIN_LOAD_DEBUG: "1" }, () =>
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: ["missing-register-shape"],
        },
      }),
    );

    const loaded = registry.plugins.find((entry) => entry.id === "missing-register-shape");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("plugin export missing register/activate");
    expect(loaded?.error).toContain("module shape:");
    expect(loaded?.error).toContain("export:object keys=default");
    expect(loaded?.error).toContain("export.default:object keys=default");
  });

  it.each([
    {
      id: "wrong-channel-entry",
      kind: "bundled-channel-entry",
      error: "bundled channel entry requires setup-runtime loader",
    },
    {
      id: "wrong-channel-setup-entry",
      kind: "bundled-channel-setup-entry",
      error: "bundled channel setup entry requires setup-runtime loader",
    },
  ])("reports $kind loaded through the legacy plugin loader", ({ id, kind, error }) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id,
      filename: `${id}.cjs`,
      body: `module.exports = { id: ${JSON.stringify(id)}, kind: ${JSON.stringify(kind)} };`,
    });
    const errors: string[] = [];

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: [id],
      },
      options: {
        logger: createErrorLogger(errors),
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === id);
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toBe(error);
    expectRegistryErrorDiagnostic({ registry, pluginId: id, message: error });
    expect(errors).toEqual([
      `[plugins] ${id} ${error}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`,
    ]);
  });

  it("handles single-plugin channel, context engine, and cli validation", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "registers channel plugins",
        pluginId: "channel-demo",
        body: `module.exports = { id: "channel-demo", register(api) {
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
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
          expect(channel?.plugin.id).toBe("demo");
        },
      },
      {
        label: "updates duplicate channel ids during same-plugin registration",
        pluginId: "channel-dup",
        body: `module.exports = { id: "channel-dup", register(api) {
    api.registerChannel({
      plugin: {
        id: "demo",
        meta: {
          id: "demo",
          label: "Demo Override",
          selectionLabel: "Demo Override",
          docsPath: "/channels/demo-override",
          blurb: "override"
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" })
        },
        outbound: { deliveryMode: "direct" }
      }
    });
    api.registerChannel({
      plugin: {
        id: "demo",
        meta: {
          id: "demo",
          label: "Demo Duplicate",
          selectionLabel: "Demo Duplicate",
          docsPath: "/channels/demo-duplicate",
          blurb: "duplicate"
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
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(countMatching(registry.channels, (entry) => entry.plugin.id === "demo")).toBe(1);
          expect(
            registry.channels.find((entry) => entry.plugin.id === "demo")?.plugin.meta?.label,
          ).toBe("Demo Duplicate");
        },
      },
      {
        label: "rejects malformed plugin context engine registration",
        pluginId: "context-engine-malformed",
        body: `module.exports = { id: "context-engine-malformed", register(api) {
    api.registerContextEngine({ id: "broken-context" });
  } };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "context-engine-malformed",
            message: "context engine registration missing id",
          });
          expect(getContextEngineRegistration("broken-context")).toBeUndefined();
        },
      },
      {
        label: "rejects plugin context engine ids reserved by core",
        pluginId: "context-engine-core-collision",
        body: `module.exports = { id: "context-engine-core-collision", register(api) {
    api.registerContextEngine("legacy", () => ({}));
  } };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "context-engine-core-collision",
            message: "context engine id reserved by core: legacy",
          });
        },
      },
      {
        label: "rejects malformed compaction provider registration",
        pluginId: "compaction-provider-malformed",
        body: `module.exports = { id: "compaction-provider-malformed", register(api) {
    api.registerCompactionProvider({ id: "broken-compaction", label: "Broken" });
  } };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "compaction-provider-malformed",
            message: 'compaction provider "broken-compaction" registration missing summarize',
          });
          expect(getCompactionProvider("broken-compaction")).toBeUndefined();
        },
      },
      {
        label: "rejects malformed memory prompt supplement registration",
        pluginId: "memory-prompt-supplement-malformed",
        body: `module.exports = { id: "memory-prompt-supplement-malformed", register(api) {
    api.registerMemoryPromptSupplement({ id: "broken-memory-prompt" });
  } };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "memory-prompt-supplement-malformed",
            message: "memory prompt supplement registration missing builder",
          });
          expect(listMemoryPromptSupplements()).toStrictEqual([]);
        },
      },
      {
        label: "requires plugin CLI registrars to declare explicit command roots",
        pluginId: "cli-missing-metadata",
        body: `module.exports = { id: "cli-missing-metadata", register(api) {
    api.registerCli(() => {});
  } };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars).toHaveLength(0);
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "cli-missing-metadata",
            message: "cli registration missing explicit commands metadata",
          });
        },
      },
      {
        label: "registers node feature CLI commands under nodes",
        pluginId: "node-cli-feature",
        body: `module.exports = { id: "node-cli-feature", register(api) {
    api.registerNodeCliFeature(() => {}, {
      descriptors: [
        {
          name: "demo-node",
          description: "Demo node feature",
          hasSubcommands: true,
        },
      ],
    });
  } };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars).toHaveLength(1);
          expect(registry.cliRegistrars[0]?.parentPath).toEqual(["nodes"]);
          expect(registry.cliRegistrars[0]?.commands).toEqual(["demo-node"]);
          expect(registry.cliRegistrars[0]?.descriptors).toEqual([
            {
              name: "demo-node",
              description: "Demo node feature",
              hasSubcommands: true,
            },
          ]);
        },
      },
    ] as const;

    runSinglePluginRegistryScenarios(scenarios);
  });

  it("registers plugin http routes", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "defaults exact match",
        pluginId: "http-route-demo",
        routeOptions:
          '{ path: "/demo", auth: "gateway", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } }',
        expectedPath: "/demo",
        expectedAuth: "gateway",
        expectedMatch: "exact",
        assert: expectRegisteredHttpRoute,
      },
      {
        label: "keeps explicit auth and match options",
        pluginId: "http-demo",
        routeOptions:
          '{ path: "/webhook", auth: "plugin", match: "prefix", handler: async () => false }',
        expectedPath: "/webhook",
        expectedAuth: "plugin",
        expectedMatch: "prefix",
        assert: expectRegisteredHttpRoute,
      },
    ] as const;

    runSinglePluginRegistryScenarios(
      scenarios.map((scenario) =>
        Object.assign({}, scenario, {
          body: `module.exports = { id: "${scenario.pluginId}", register(api) {
    api.registerHttpRoute(${scenario.routeOptions});
  } };`,
        }),
      ),
    );
  });

  it("rejects duplicate plugin registrations", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "plugin-visible hook names",
        ownerA: "hook-owner-a",
        ownerB: "hook-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
    api.registerHook("gateway:startup", () => {}, { name: "shared-hook" });
  } };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          countMatching(registry.hooks, (entry) => entry.entry.hook.name === "shared-hook"),
        duplicateMessage: "hook already registered: shared-hook (hook-owner-a)",
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "plugin service ids",
        ownerA: "service-owner-a",
        ownerB: "service-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
    api.registerService({ id: "shared-service", start() {} });
  } };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          countMatching(registry.services, (entry) => entry.service.id === "shared-service"),
        duplicateMessage: "service already registered: shared-service (service-owner-a)",
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "gateway discovery service ids",
        ownerA: "discovery-owner-a",
        ownerB: "discovery-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
    api.registerGatewayDiscoveryService({ id: "shared-discovery", advertise() {} });
  } };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.gatewayDiscoveryServices.filter(
            (entry) => entry.service.id === "shared-discovery",
          ).length,
        duplicateMessage:
          "gateway discovery service already registered: shared-discovery (discovery-owner-a)",
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.plugins.find((entry) => entry.id === "discovery-owner-a")
              ?.gatewayDiscoveryServiceIds,
          ).toEqual(["shared-discovery"]);
        },
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "plugin context engine ids",
        ownerA: "context-engine-owner-a",
        ownerB: "context-engine-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
    api.registerContextEngine("shared-context-engine-loader-test", () => ({}));
  } };`,
        selectCount: () => 1,
        duplicateMessage:
          "context engine already registered: shared-context-engine-loader-test (plugin:context-engine-owner-a)",
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.plugins.find((entry) => entry.id === "context-engine-owner-a")
              ?.contextEngineIds,
          ).toEqual(["shared-context-engine-loader-test"]);
        },
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "plugin CLI command roots",
        ownerA: "cli-owner-a",
        ownerB: "cli-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
    api.registerCli(() => {}, { commands: ["shared-cli"] });
  } };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.cliRegistrars.length,
        duplicateMessage: "cli command already registered: shared-cli (cli-owner-a)",
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars[0]?.pluginId).toBe("cli-owner-a");
        },
        assert: expectDuplicateRegistrationResult,
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => {
      const first = writePlugin({
        id: scenario.ownerA,
        filename: `${scenario.ownerA}.cjs`,
        body: scenario.buildBody(scenario.ownerA),
      });
      const second = writePlugin({
        id: scenario.ownerB,
        filename: `${scenario.ownerB}.cjs`,
        body: scenario.buildBody(scenario.ownerB),
      });
      return loadRegistryFromAllowedPlugins([first, second]);
    });
  });

  it("allows the same plugin to register the same service id twice", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "service-owner-self",
      filename: "service-owner-self.cjs",
      body: `module.exports = { id: "service-owner-self", register(api) {
    api.registerService({ id: "shared-service", start() {} });
    api.registerService({ id: "shared-service", start() {} });
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["service-owner-self"],
      },
    });

    expect(countMatching(registry.services, (entry) => entry.service.id === "shared-service")).toBe(
      1,
    );
    expectNoDiagnosticContaining({
      registry,
      message: "service already registered: shared-service",
    });
  });

  it("tracks regular services and gateway discovery services separately", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "split-service-owner",
      filename: "split-service-owner.cjs",
      body: `module.exports = { id: "split-service-owner", register(api) {
    api.registerService({ id: "shared-service", start() {} });
    api.registerGatewayDiscoveryService({ id: "shared-service", advertise() {} });
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["split-service-owner"],
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "split-service-owner");
    expect(record?.services).toEqual(["shared-service"]);
    expect(record?.gatewayDiscoveryServiceIds).toEqual(["shared-service"]);
    expect(registry.services).toHaveLength(1);
    expect(registry.gatewayDiscoveryServices).toHaveLength(1);
    expect(registry.diagnostics).toStrictEqual([]);
  });

  it("rewrites removed registerHttpHandler failures into migration diagnostics", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-handler-legacy",
      filename: "http-handler-legacy.cjs",
      body: `module.exports = { id: "http-handler-legacy", register(api) {
    api.registerHttpHandler({ path: "/legacy", handler: async () => true });
  } };`,
    });

    const errors: string[] = [];
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-legacy"],
      },
      options: {
        logger: createErrorLogger(errors),
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-legacy");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("api.registerHttpHandler(...) was removed");
    expect(loaded?.error).toContain("api.registerHttpRoute(...)");
    expect(loaded?.error).toContain("registerPluginHttpRoute(...)");
    expectDiagnosticContaining({
      registry,
      message: "api.registerHttpHandler(...) was removed",
    });
    expect(
      errors.some((message) => message.includes("api.registerHttpHandler(...) was removed")),
    ).toBe(true);
  });

  it("does not rewrite unrelated registerHttpHandler helper failures", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-handler-local-helper",
      filename: "http-handler-local-helper.cjs",
      body: `module.exports = { id: "http-handler-local-helper", register() {
    const registerHttpHandler = undefined;
    registerHttpHandler();
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-local-helper"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-local-helper");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).not.toContain("api.registerHttpHandler(...) was removed");
  });

  it("enforces plugin http route validation and conflict rules", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "missing auth is rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-missing-auth",
            filename: "http-route-missing-auth.cjs",
            body: `module.exports = { id: "http-route-missing-auth", register(api) {
    api.registerHttpRoute({ path: "/demo", handler: async () => true });
  } };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.httpRoutes.find((entry) => entry.pluginId === "http-route-missing-auth"),
          ).toBeUndefined();
          expectDiagnosticContaining({
            registry,
            message: "http route registration missing or invalid auth",
          });
        },
      },
      {
        label: "same plugin can implicitly replace its own route",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-replace-self",
            filename: "http-route-replace-self.cjs",
            body: `module.exports = { id: "http-route-replace-self", register(api) {
    api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
    api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => true });
  } };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-replace-self",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/demo");
          expect(registry.diagnostics).toStrictEqual([]);
        },
      },
      {
        label: "cross-plugin replaceExisting is rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-owner-a",
            filename: "http-route-owner-a.cjs",
            body: `module.exports = { id: "http-route-owner-a", register(api) {
    api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
  } };`,
          }),
          writePlugin({
            id: "http-route-owner-b",
            filename: "http-route-owner-b.cjs",
            body: `module.exports = { id: "http-route-owner-b", register(api) {
    api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
  } };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const route = registry.httpRoutes.find((entry) => entry.path === "/demo");
          expect(route?.pluginId).toBe("http-route-owner-a");
          expectDiagnosticContaining({
            registry,
            message: "http route replacement rejected",
          });
        },
      },
      {
        label: "mixed-auth overlaps are rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-overlap",
            filename: "http-route-overlap.cjs",
            body: `module.exports = { id: "http-route-overlap", register(api) {
    api.registerHttpRoute({ path: "/plugin/secure", auth: "gateway", match: "prefix", handler: async () => true });
    api.registerHttpRoute({ path: "/plugin/secure/report", auth: "plugin", match: "exact", handler: async () => true });
  } };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/plugin/secure");
          expectDiagnosticContaining({
            registry,
            message: "http route overlap rejected",
          });
        },
      },
      {
        label: "same-auth overlaps are allowed",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-overlap-same-auth",
            filename: "http-route-overlap-same-auth.cjs",
            body: `module.exports = { id: "http-route-overlap-same-auth", register(api) {
    api.registerHttpRoute({ path: "/plugin/public", auth: "plugin", match: "prefix", handler: async () => true });
    api.registerHttpRoute({ path: "/plugin/public/report", auth: "plugin", match: "exact", handler: async () => true });
  } };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap-same-auth",
          );
          expect(routes).toHaveLength(2);
          expect(registry.diagnostics).toStrictEqual([]);
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) =>
      loadRegistryFromScenarioPlugins(scenario.buildPlugins()),
    );
  });

  it("respects explicit disable in config", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "config-disable",
      body: `module.exports = { id: "config-disable", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
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

  it("loads bundled channel entries through nested default export wrappers", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(pluginDir, "full-loaded.txt");

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/nested-default-channel",
          openclaw: {
            extensions: ["./index.cjs"],
          },
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
          id: "nested-default-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["nested-default-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
    default: {
      default: {
        id: "nested-default-channel",
        kind: "bundled-channel-entry",
        name: "Nested Default Channel",
        description: "interop-wrapped bundled channel entry",
        register(api) {
          require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
          api.registerChannel({
            plugin: {
              id: "nested-default-channel",
              meta: {
                id: "nested-default-channel",
                label: "Nested Default Channel",
                selectionLabel: "Nested Default Channel",
                docsPath: "/channels/nested-default-channel",
                blurb: "interop-wrapped bundled channel entry",
              },
              capabilities: { chatTypes: ["direct"] },
              config: {
                listAccountIds: () => ["default"],
                resolveAccount: () => ({ accountId: "default", token: "configured" }),
              },
              outbound: { deliveryMode: "direct" },
            },
          });
        },
      },
    },
  };`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: {
          "nested-default-channel": {
            enabled: true,
            token: "configured",
          },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["nested-default-channel"],
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(true);
    expect(registry.plugins.find((entry) => entry.id === "nested-default-channel")?.status).toBe(
      "loaded",
    );
    expect(registry.channels.map((entry) => entry.plugin.id)).toContain("nested-default-channel");
  });

  it("does not treat manifest channel ids as scoped plugin id matches", () => {
    useNoBundledPlugins();
    const target = writePlugin({
      id: "target-plugin",
      filename: "target-plugin.cjs",
      body: `module.exports = { id: "target-plugin", register() {} };`,
    });
    const unrelated = writePlugin({
      id: "unrelated-plugin",
      filename: "unrelated-plugin.cjs",
      body: `module.exports = { id: "unrelated-plugin", register() { throw new Error("unrelated plugin should not load"); } };`,
    });
    fs.writeFileSync(
      path.join(unrelated.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "unrelated-plugin",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["target-plugin"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [target.file, unrelated.file] },
          allow: ["target-plugin", "unrelated-plugin"],
          entries: {
            "target-plugin": { enabled: true },
            "unrelated-plugin": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["target-plugin"],
    });

    expect(registry.plugins.map((entry) => entry.id)).toEqual(["target-plugin"]);
  });

  it("does not setup-load an explicitly disabled channel plugin even when the caller scopes to it", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "lazy-channel-imported.txt");
    const plugin = writePlugin({
      id: "lazy-channel-plugin",
      filename: "lazy-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "lazy-channel-plugin",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "lazy-channel",
          meta: {
            id: "lazy-channel",
            label: "Lazy Channel",
            selectionLabel: "Lazy Channel",
            docsPath: "/channels/lazy-channel",
            blurb: "lazy test channel",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({ accountId: "default" }),
          },
          outbound: { deliveryMode: "direct" },
        },
      });
    },
  };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "lazy-channel-plugin",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["lazy-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: ["lazy-channel-plugin"],
        entries: {
          "lazy-channel-plugin": { enabled: false },
        },
      },
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(0);
    expect(registry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status).toBe(
      "disabled",
    );

    const broadSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(broadSetupRegistry.channelSetups).toHaveLength(0);
    expect(broadSetupRegistry.channels).toHaveLength(0);
    expect(
      broadSetupRegistry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status,
    ).toBe("disabled");

    const scopedSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["lazy-channel-plugin"],
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(scopedSetupRegistry.channelSetups).toHaveLength(0);
    expect(scopedSetupRegistry.channels).toHaveLength(0);
    expect(
      scopedSetupRegistry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status,
    ).toBe("disabled");
  });

  it("blocks untrusted setup-only workspace channel plugins when explicitly scoped", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "workspace-setup-only-loaded.txt");
    const { workspaceDir, workspacePluginDir } = writeWorkspacePlugin({
      id: "workspace-shadow",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "workspace-shadow",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "workspace-shadow",
          meta: {
            id: "workspace-shadow",
            label: "Workspace Shadow",
            selectionLabel: "Workspace Shadow",
            docsPath: "/channels/workspace-shadow",
            blurb: "workspace shadow",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => undefined,
          },
          outbound: { deliveryMode: "direct" },
        },
      });
    },
  };`,
    });
    fs.writeFileSync(
      path.join(workspacePluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "workspace-shadow",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["workspace-shadow"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      includeSetupOnlyChannelPlugins: true,
      forceSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["workspace-shadow"],
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(0);
    expect(registry.channels).toHaveLength(0);
    expect(registry.plugins.find((entry) => entry.id === "workspace-shadow")).toMatchObject({
      status: "disabled",
      error: "workspace plugin (disabled by default)",
    });
  });

  it("keeps trusted setup-only workspace channel plugins available when explicitly scoped", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "trusted-workspace-setup-only-loaded.txt");
    const { workspaceDir, workspacePluginDir } = writeWorkspacePlugin({
      id: "trusted-workspace-shadow",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "trusted-workspace-shadow",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "telegram",
          meta: {
            id: "telegram",
            label: "Trusted Workspace Telegram",
            selectionLabel: "Trusted Workspace Telegram",
            docsPath: "/channels/telegram",
            blurb: "trusted workspace telegram",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({ accountId: "default" }),
          },
          outbound: { deliveryMode: "direct" },
        },
      });
    },
  };`,
    });
    fs.writeFileSync(
      path.join(workspacePluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "trusted-workspace-shadow",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["telegram"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      includeSetupOnlyChannelPlugins: true,
      forceSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["trusted-workspace-shadow"],
      config: {
        plugins: {
          enabled: true,
          allow: ["trusted-workspace-shadow"],
        },
      },
    });

    expect(fs.existsSync(marker)).toBe(true);
    expect(registry.channelSetups.map((entry) => entry.plugin.meta.label)).toEqual([
      "Trusted Workspace Telegram",
    ]);
    expect(registry.channels).toHaveLength(0);
    expect(registry.plugins.find((entry) => entry.id === "trusted-workspace-shadow")?.status).toBe(
      "loaded",
    );
  });

  it("does not setup-load an untrusted config-origin channel plugin when the caller scopes to it", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "untrusted-load-path-channel-imported.txt");
    const plugin = writePlugin({
      id: "untrusted-load-path-channel",
      filename: "untrusted-load-path-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "untrusted-load-path-channel",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "untrusted-load-path-channel",
          meta: {
            id: "untrusted-load-path-channel",
            label: "Untrusted Load Path Channel",
            selectionLabel: "Untrusted Load Path Channel",
            docsPath: "/channels/untrusted-load-path-channel",
            blurb: "untrusted load-path setup gate",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({ accountId: "default" }),
          },
          outbound: { deliveryMode: "direct" },
        },
      });
    },
  };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "untrusted-load-path-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["untrusted-load-path-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const scopedSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
        },
      },
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["untrusted-load-path-channel"],
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(scopedSetupRegistry.channelSetups).toHaveLength(0);
    expect(scopedSetupRegistry.channels).toHaveLength(0);
    expect(
      scopedSetupRegistry.plugins.find((entry) => entry.id === "untrusted-load-path-channel")
        ?.status,
    ).toBe("disabled");
  });

  it("does not setup-load a denylisted config-origin channel plugin even when explicitly allowed", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "denylisted-load-path-channel-imported.txt");
    const plugin = writePlugin({
      id: "denylisted-load-path-channel",
      filename: "denylisted-load-path-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "denylisted-load-path-channel",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "denylisted-load-path-channel",
          meta: {
            id: "denylisted-load-path-channel",
            label: "Denylisted Load Path Channel",
            selectionLabel: "Denylisted Load Path Channel",
            docsPath: "/channels/denylisted-load-path-channel",
            blurb: "denylisted load-path setup gate",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({ accountId: "default" }),
          },
          outbound: { deliveryMode: "direct" },
        },
      });
    },
  };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "denylisted-load-path-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["denylisted-load-path-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const scopedSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["denylisted-load-path-channel"],
          deny: ["denylisted-load-path-channel"],
        },
      },
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["denylisted-load-path-channel"],
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(scopedSetupRegistry.channelSetups).toHaveLength(0);
    expect(scopedSetupRegistry.channels).toHaveLength(0);
    expect(
      scopedSetupRegistry.plugins.find((entry) => entry.id === "denylisted-load-path-channel")
        ?.status,
    ).toBe("disabled");
  });

  it("does not setup-load an untrusted global channel plugin when the caller scopes to it", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "untrusted-global-channel-imported.txt");
    withStateDir((stateDir) => {
      const globalDir = path.join(stateDir, "extensions", "untrusted-global-channel");
      mkdirSafe(globalDir);
      fs.writeFileSync(
        path.join(globalDir, "index.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "untrusted-global-channel",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "untrusted-global-channel",
          meta: {
            id: "untrusted-global-channel",
            label: "Untrusted Global Channel",
            selectionLabel: "Untrusted Global Channel",
            docsPath: "/channels/untrusted-global-channel",
            blurb: "untrusted global setup gate",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({ accountId: "default" }),
          },
          outbound: { deliveryMode: "direct" },
        },
      });
    },
  };`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(globalDir, "openclaw.plugin.json"),
        JSON.stringify(
          {
            id: "untrusted-global-channel",
            configSchema: EMPTY_PLUGIN_SCHEMA,
            channels: ["untrusted-global-channel"],
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(globalDir, "package.json"),
        JSON.stringify(
          {
            name: "@openclaw/untrusted-global-channel",
            version: "0.0.0-test",
            main: "./index.cjs",
            openclaw: {
              extensions: ["./index.cjs"],
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const scopedSetupRegistry = loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            enabled: true,
          },
        },
        includeSetupOnlyChannelPlugins: true,
        onlyPluginIds: ["untrusted-global-channel"],
      });

      expect(fs.existsSync(marker)).toBe(false);
      expect(scopedSetupRegistry.channelSetups).toHaveLength(0);
      expect(scopedSetupRegistry.channels).toHaveLength(0);
      expect(
        scopedSetupRegistry.plugins.find((entry) => entry.id === "untrusted-global-channel")
          ?.status,
      ).toBe("disabled");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
