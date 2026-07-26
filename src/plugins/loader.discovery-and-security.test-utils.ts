// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { withEnv } from "../test-utils/env.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { warnWhenAllowlistIsOpen } from "./loader-provenance.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  clearPluginLoaderCache,
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  mkdirSafe,
  type PluginLoadConfig,
  type PluginRegistry,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  simplePluginBody,
  updatePluginManifest,
  memoryPluginBody,
  setupBundledDreamingMemoryPlugins,
  writeBundledPlugin,
  makeOpenClawDevSourceRoot,
  writeWorkspacePlugin,
  withStateDir,
  loadRegistryFromSinglePlugin,
  runRegistryScenarios,
  runScenarioCases,
  expectOpenAllowWarnings,
  expectLoadedPluginProvenance,
  expectPluginSourcePrecedence,
  expectPluginOriginAndStatus,
  expectDiagnosticContaining,
  expectNoDiagnosticContaining,
  createWarningLogger,
  createEnvResolvedPluginFixture,
  expectEscapingEntryRejected,
  globalAfterEach0,
  globalAfterAll1,
} from "./loader.test-harness.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

describe("loadOpenClawPlugins", () => {
  it("ignores unknown typed hooks from plugins and keeps loading", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-unknown",
      filename: "hook-unknown.cjs",
      body: `module.exports = { id: "hook-unknown", register(api) {
    api.on("totally_unknown_hook_name", () => ({ foo: "bar" }));
    api.on(123, () => ({ foo: "baz" }));
    api.on("before_model_resolve", () => ({ providerOverride: "demo-provider" }));
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-unknown"],
        entries: {
          "hook-unknown": {
            hooks: {
              allowConversationAccess: true,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-unknown")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    const unknownHookDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes('unknown typed hook "'),
    );
    expect(unknownHookDiagnostics).toHaveLength(2);
    expect(
      unknownHookDiagnostics.some((diag) =>
        diag.message.includes('unknown typed hook "totally_unknown_hook_name" ignored'),
      ),
    ).toBe(true);
    expect(
      unknownHookDiagnostics.some((diag) =>
        diag.message.includes('unknown typed hook "123" ignored'),
      ),
    ).toBe(true);
  });

  it("enforces memory slot loading rules", () => {
    const scenarios = [
      {
        label: "enforces memory slot selection",
        loadRegistry: () => {
          const memoryA = writePlugin({
            id: "memory-a",
            body: memoryPluginBody("memory-a"),
          });
          const memoryB = writePlugin({
            id: "memory-b",
            body: memoryPluginBody("memory-b"),
          });

          return withEnv(
            {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            },
            () =>
              loadOpenClawPlugins({
                cache: false,
                config: {
                  plugins: {
                    load: { paths: [memoryA.file, memoryB.file] },
                    slots: { memory: "memory-b" },
                  },
                },
              }),
          );
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(b?.status).toBe("loaded");
          expect(a?.status).toBe("disabled");
        },
      },
      {
        label: "skips importing bundled memory plugins that are disabled by memory slot",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryADir = path.join(bundledDir, "memory-a");
          const memoryBDir = path.join(bundledDir, "memory-b");
          mkdirSafe(memoryADir);
          mkdirSafe(memoryBDir);
          writePlugin({
            id: "memory-a",
            dir: memoryADir,
            filename: "index.cjs",
            body: `throw new Error("memory-a should not be imported when slot selects memory-b");`,
          });
          writePlugin({
            id: "memory-b",
            dir: memoryBDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-b"),
          });
          fs.writeFileSync(
            path.join(memoryADir, "openclaw.plugin.json"),
            JSON.stringify(
              {
                id: "memory-a",
                kind: "memory",
                configSchema: EMPTY_PLUGIN_SCHEMA,
              },
              null,
              2,
            ),
            "utf-8",
          );
          fs.writeFileSync(
            path.join(memoryBDir, "openclaw.plugin.json"),
            JSON.stringify(
              {
                id: "memory-b",
                kind: "memory",
                configSchema: EMPTY_PLUGIN_SCHEMA,
              },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-a", "memory-b"],
                slots: { memory: "memory-b" },
                entries: {
                  "memory-a": { enabled: true },
                  "memory-b": { enabled: true },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(a?.status).toBe("disabled");
          expect(a?.error ?? "").toContain('memory slot set to "memory-b"');
          expect(b?.status).toBe("loaded");
        },
      },
      {
        label:
          "loads dreaming engine through a restrictive allowlist when selected memory slot enables dreaming",
        loadRegistry: () => {
          const { selectedId } = setupBundledDreamingMemoryPlugins();

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: [selectedId],
                slots: { memory: selectedId },
                entries: {
                  [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("loaded");
          expect(core?.enabled).toBe(true);
          expect(lance?.status).toBe("loaded");
          expect(lance?.memorySlotSelected).toBe(true);
        },
      },
      {
        label: "keeps restrictive allowlist dreaming sidecar in manifest-only snapshots",
        loadRegistry: () => {
          const { selectedId } = setupBundledDreamingMemoryPlugins({
            coreBody: `throw new Error("manifest-only snapshot should not import memory-core");`,
          });

          return loadOpenClawPlugins({
            cache: false,
            activate: false,
            loadModules: false,
            config: {
              plugins: {
                allow: [selectedId],
                slots: { memory: selectedId },
                entries: {
                  [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("loaded");
          expect(lance?.status).toBe("loaded");
          expect(lance?.memorySlotSelected).toBe(true);
        },
      },
      {
        label: "keeps denied dreaming sidecars fail-closed under restrictive allowlists",
        loadRegistry: () => {
          const { selectedId } = setupBundledDreamingMemoryPlugins({
            coreBody: `throw new Error("denied memory-core should not load");`,
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: [selectedId],
                deny: ["memory-core"],
                slots: { memory: selectedId },
                entries: {
                  [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("disabled");
          expect(core?.error).toBe("blocked by denylist");
          expect(lance?.status).toBe("loaded");
        },
      },
      {
        label: "keeps explicitly disabled dreaming sidecars fail-closed",
        loadRegistry: () => {
          const { selectedId } = setupBundledDreamingMemoryPlugins({
            coreBody: `throw new Error("disabled memory-core should not load");`,
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: [selectedId],
                slots: { memory: selectedId },
                entries: {
                  "memory-core": { enabled: false },
                  [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("disabled");
          expect(core?.error).toBe("disabled in config");
          expect(lance?.status).toBe("loaded");
        },
      },
      {
        label: "does not authorize dreaming sidecars for non-memory selected slots",
        loadRegistry: () => {
          const { selectedId } = setupBundledDreamingMemoryPlugins({
            selectedKind: "utility",
            coreBody: `throw new Error("non-memory selected slot should not load memory-core");`,
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: [selectedId],
                slots: { memory: selectedId },
                entries: {
                  [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const selected = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("disabled");
          expect(core?.error).toBe("not in allowlist");
          expect(selected?.status).toBe("loaded");
        },
      },
      {
        label:
          "loads dreaming engine alongside a different memory slot plugin when dreaming is enabled",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryCoreDir = path.join(bundledDir, "memory-core");
          const memoryLanceDir = path.join(bundledDir, "memory-lancedb");
          mkdirSafe(memoryCoreDir);
          mkdirSafe(memoryLanceDir);
          writePlugin({
            id: "memory-core",
            dir: memoryCoreDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-core"),
          });
          writePlugin({
            id: "memory-lancedb",
            dir: memoryLanceDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-lancedb"),
          });
          const openSchema = { type: "object", additionalProperties: true };
          fs.writeFileSync(
            path.join(memoryCoreDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-core", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          fs.writeFileSync(
            path.join(memoryLanceDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-lancedb", kind: "memory", configSchema: openSchema },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-core", "memory-lancedb"],
                slots: { memory: "memory-lancedb" },
                entries: {
                  "memory-core": { enabled: true },
                  "memory-lancedb": { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("loaded");
          expect(lance?.status).toBe("loaded");
          expect(lance?.memorySlotSelected).toBe(true);
          expect(core?.memorySlotSelected).not.toBe(true);
        },
      },
      {
        label: "excludes dreaming engine when dreaming is disabled and it is not the slot",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryCoreDir = path.join(bundledDir, "memory-core");
          const memoryLanceDir = path.join(bundledDir, "memory-lancedb");
          mkdirSafe(memoryCoreDir);
          mkdirSafe(memoryLanceDir);
          writePlugin({
            id: "memory-core",
            dir: memoryCoreDir,
            filename: "index.cjs",
            body: `throw new Error("memory-core should not load when dreaming is disabled");`,
          });
          writePlugin({
            id: "memory-lancedb",
            dir: memoryLanceDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-lancedb"),
          });
          fs.writeFileSync(
            path.join(memoryCoreDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-core", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          fs.writeFileSync(
            path.join(memoryLanceDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-lancedb", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-core", "memory-lancedb"],
                slots: { memory: "memory-lancedb" },
                entries: {
                  "memory-core": { enabled: true },
                  "memory-lancedb": { enabled: true },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("disabled");
          expect(lance?.status).toBe("loaded");
        },
      },
      {
        label: 'keeps memory slot "none" disabled even with stale memory-core dreaming config',
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryCoreDir = path.join(bundledDir, "memory-core");
          mkdirSafe(memoryCoreDir);
          writePlugin({
            id: "memory-core",
            dir: memoryCoreDir,
            filename: "index.cjs",
            body: `throw new Error("memory-core should not load when memory slot is none");`,
          });
          fs.writeFileSync(
            path.join(memoryCoreDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-core", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-core"],
                slots: { memory: "none" },
                entries: {
                  "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          expect(core?.status).toBe("disabled");
        },
      },
      {
        label: "disables memory plugins when slot is none",
        loadRegistry: () => {
          const memory = writePlugin({
            id: "memory-off",
            body: memoryPluginBody("memory-off"),
          });

          return withEnv(
            {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            },
            () =>
              loadOpenClawPlugins({
                cache: false,
                config: {
                  plugins: {
                    load: { paths: [memory.file] },
                    slots: { memory: "none" },
                  },
                },
              }),
          );
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const entry = registry.plugins.find((item) => item.id === "memory-off");
          expect(entry?.status).toBe("disabled");
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, ({ loadRegistry }) => loadRegistry());
  });

  it("loads dreaming sidecar metadata through a restrictive selected-memory allowlist", async () => {
    const { selectedId } = setupBundledDreamingMemoryPlugins();

    const registry = await loadOpenClawPluginCliRegistry({
      cache: false,
      config: {
        plugins: {
          allow: [selectedId],
          slots: { memory: selectedId },
          entries: {
            [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
          },
        },
      },
    });

    expect(registry.plugins.map((entry) => entry.id)).toEqual(["memory-core", selectedId]);
    expect(registry.plugins.find((entry) => entry.id === "memory-core")?.status).toBe("loaded");
    expect(registry.plugins.find((entry) => entry.id === selectedId)?.status).toBe("loaded");
  });

  it("resolves duplicate plugin ids by source precedence", () => {
    const scenarios = [
      {
        label: "config load overrides bundled",
        pluginId: "shadow",
        bundledFilename: "shadow.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "shadow",
            body: simplePluginBody("shadow"),
            filename: "shadow.cjs",
          });

          const override = writePlugin({
            id: "shadow",
            body: simplePluginBody("shadow"),
          });

          return loadOpenClawPlugins({
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
        },
        expectedLoadedOrigin: "config",
        expectedDisabledOrigin: "bundled",
        assert: expectPluginSourcePrecedence,
      },
      {
        label: "bundled beats auto-discovered global duplicate",
        pluginId: "demo-bundled-duplicate",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "demo-bundled-duplicate",
            body: simplePluginBody("demo-bundled-duplicate"),
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "demo-bundled-duplicate");
            mkdirSafe(globalDir);
            writePlugin({
              id: "demo-bundled-duplicate",
              body: simplePluginBody("demo-bundled-duplicate"),
              dir: globalDir,
              filename: "index.cjs",
            });

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["demo-bundled-duplicate"],
                  entries: {
                    "demo-bundled-duplicate": { enabled: true },
                  },
                },
              },
            });
          });
        },
        expectedLoadedOrigin: "bundled",
        expectedDisabledOrigin: "global",
        expectedDisabledError: "overridden by bundled plugin",
        assert: expectPluginSourcePrecedence,
      },
      {
        label: "installed global beats bundled duplicate",
        pluginId: "demo-installed-duplicate",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "demo-installed-duplicate",
            body: simplePluginBody("demo-installed-duplicate"),
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "demo-installed-duplicate");
            mkdirSafe(globalDir);
            writePlugin({
              id: "demo-installed-duplicate",
              body: simplePluginBody("demo-installed-duplicate"),
              dir: globalDir,
              filename: "index.cjs",
            });
            writePersistedInstalledPluginIndexInstallRecordsSync(
              {
                "demo-installed-duplicate": {
                  source: "npm",
                  installPath: globalDir,
                },
              },
              { stateDir },
            );

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["demo-installed-duplicate"],
                  entries: {
                    "demo-installed-duplicate": { enabled: true },
                  },
                },
              },
            });
          });
        },
        expectedLoadedOrigin: "global",
        expectedDisabledOrigin: "bundled",
        expectedDisabledError: "overridden by global plugin",
        expectDuplicateWarning: false,
        assert: expectPluginSourcePrecedence,
      },
      {
        label: "dev source bundled beats installed global duplicate",
        pluginId: "demo-dev-source-duplicate",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          const devSourceRoot = makeOpenClawDevSourceRoot();
          const bundledPluginsDir = path.join(devSourceRoot, "extensions");
          writeBundledPlugin({
            id: "demo-dev-source-duplicate",
            body: simplePluginBody("demo-dev-source-duplicate"),
            bundledDir: path.join(bundledPluginsDir, "demo-dev-source-duplicate"),
          });
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
          return withEnv({ OPENCLAW_DEV_SOURCE_ROOT: devSourceRoot }, () =>
            withStateDir((stateDir) => {
              const globalDir = path.join(stateDir, "extensions", "demo-dev-source-duplicate");
              mkdirSafe(globalDir);
              writePlugin({
                id: "demo-dev-source-duplicate",
                body: simplePluginBody("demo-dev-source-duplicate"),
                dir: globalDir,
                filename: "index.cjs",
              });
              writePersistedInstalledPluginIndexInstallRecordsSync(
                {
                  "demo-dev-source-duplicate": {
                    source: "npm",
                    installPath: globalDir,
                  },
                },
                { stateDir },
              );

              return loadOpenClawPlugins({
                cache: false,
                config: {
                  plugins: {
                    allow: ["demo-dev-source-duplicate"],
                    entries: {
                      "demo-dev-source-duplicate": { enabled: true },
                    },
                  },
                },
              });
            }),
          );
        },
        expectedLoadedOrigin: "bundled",
        expectedDisabledOrigin: "global",
        expectedDisabledError: "overridden by bundled plugin",
        assert: expectPluginSourcePrecedence,
      },
      {
        label: "transient installed memory plugin beats bundled duplicate",
        pluginId: "memory-lancedb",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "memory-lancedb",
            body: memoryPluginBody("memory-lancedb"),
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "node_modules", "@openclaw", "memory-lancedb");
            mkdirSafe(globalDir);
            const globalPlugin = writePlugin({
              id: "memory-lancedb",
              body: `module.exports = {
                  id: "memory-lancedb",
                  kind: "memory",
                  register(api) {
                    api.registerTool({
                      name: "memory_recall",
                      description: "Recall memories",
                      parameters: {},
                      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
                    });
                  },
                };`,
              dir: globalDir,
              filename: "index.cjs",
            });
            updatePluginManifest(globalPlugin, {
              kind: "memory",
              contracts: { tools: ["memory_recall"] },
            });
            fs.writeFileSync(
              path.join(globalDir, "package.json"),
              JSON.stringify(
                {
                  name: "@openclaw/memory-lancedb",
                  version: "2026.5.12-beta.1",
                  openclaw: { extensions: ["./index.cjs"] },
                },
                null,
                2,
              ),
              "utf-8",
            );

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["memory-lancedb"],
                  slots: { memory: "memory-lancedb" },
                  entries: {
                    "memory-lancedb": { enabled: true },
                  },
                  installs: {
                    "memory-lancedb": {
                      source: "npm",
                      spec: "@openclaw/memory-lancedb",
                      resolvedName: "@openclaw/memory-lancedb",
                      resolvedVersion: "2026.5.12-beta.1",
                      installPath: globalDir,
                    },
                  },
                },
              },
            });
          });
        },
        expectedLoadedOrigin: "global",
        expectedDisabledOrigin: "bundled",
        expectedDisabledError: "overridden by global plugin",
        expectDuplicateWarning: false,
        assert: (
          registry: PluginRegistry,
          scenario: Parameters<typeof expectPluginSourcePrecedence>[1],
        ) => {
          expectPluginSourcePrecedence(registry, scenario);
          expect(
            registry.tools.flatMap((entry) => entry.names),
            scenario.label,
          ).toContain("memory_recall");
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => scenario.loadRegistry());
  });

  it("warns about open allowlists only for auto-discovered plugins", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const scenarios = [
      {
        label: "explicit config path stays quiet",
        pluginId: "warn-open-allow-config",
        loads: 1,
        expectedWarnings: 0,
        loadRegistry: (warnings: string[]) => {
          const plugin = writePlugin({
            id: "warn-open-allow-config",
            body: simplePluginBody("warn-open-allow-config"),
          });
          return loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            config: {
              plugins: {
                load: { paths: [plugin.file] },
              },
            },
          });
        },
      },
      {
        label: "workspace discovery warns once",
        pluginId: "warn-open-allow-workspace",
        loads: 2,
        expectedWarnings: 1,
        loadRegistry: (() => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "warn-open-allow-workspace",
          });
          return (warnings: string[]) =>
            loadOpenClawPlugins({
              cache: false,
              workspaceDir,
              logger: createWarningLogger(warnings),
              config: {
                plugins: {
                  enabled: true,
                },
              },
            });
        })(),
      },
    ] as const;

    runScenarioCases(scenarios, (scenario) => {
      const warnings: string[] = [];

      for (let index = 0; index < scenario.loads; index += 1) {
        scenario.loadRegistry(warnings);
      }

      expectOpenAllowWarnings({
        warnings,
        pluginId: scenario.pluginId,
        expectedWarnings: scenario.expectedWarnings,
        label: scenario.label,
      });
    });
  });

  it("stays quiet when every non-bundled plugin is explicitly enabled", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const { workspaceDir } = writeWorkspacePlugin({
      id: "warn-explicitly-enabled-plugin",
    });
    const warnings: string[] = [];
    loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          enabled: true,
          entries: { "warn-explicitly-enabled-plugin": { enabled: true } },
        },
      },
    });

    expect(warnings.join("\n")).not.toContain("plugins.allow is empty");
  });

  it("warns when plugins.allow entries do not match any discovered plugin ids", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const { workspaceDir } = writeWorkspacePlugin({
      id: "warn-mismatch-allow-plugin",
    });
    const warnings: string[] = [];
    loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          enabled: true,
          // User configured a channel-style id that does not match the real plugin id.
          allow: ["warn-mismatch-allow-channel"],
        },
      },
    });
    const emptyWarnings = warnings.filter((msg) => msg.includes("plugins.allow is empty"));
    const mismatchWarnings = warnings.filter((msg) =>
      msg.includes("do not match any discovered plugin ids"),
    );
    expect(emptyWarnings, "should not emit empty-allowlist warning").toHaveLength(0);
    expect(mismatchWarnings, "should emit mismatch warning once").toHaveLength(1);
    expect(mismatchWarnings[0]).toContain(`"warn-mismatch-allow-channel"`);
    expect(mismatchWarnings[0]).toContain("warn-mismatch-allow-plugin");
    expect(mismatchWarnings[0]).toContain("Use the plugin id");
  });

  it("stays quiet when plugins.allow contains at least one matching plugin id", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const { workspaceDir } = writeWorkspacePlugin({
      id: "warn-partial-allow-plugin",
    });
    const warnings: string[] = [];
    loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          enabled: true,
          // Allow contains one real plugin id plus a stray channel-style entry.
          allow: ["warn-partial-allow-plugin", "warn-partial-allow-channel"],
        },
      },
    });
    const openAllowWarnings = warnings.filter(
      (msg) =>
        msg.includes("plugins.allow is empty") ||
        msg.includes("do not match any discovered plugin ids"),
    );
    expect(openAllowWarnings, "should not emit allowlist warning when one id matches").toHaveLength(
      0,
    );
  });

  it("stays quiet when plugins.allow matches only bundled plugin ids, even while workspace/global plugins are present", () => {
    // Regression for Codex P2 feedback on #68389: the mismatch warning should be computed
    // against the full discovered plugin set (bundled + workspace + global), not only the
    // workspace/global subset that the warning talks about. An allowlist that intentionally
    // trusts bundled ids like ["telegram"] is valid and must not trip the mismatch path just
    // because some unrelated non-bundled plugin happens to be auto-discoverable.
    useNoBundledPlugins();
    clearPluginLoaderCache();
    writeBundledPlugin({
      id: "warn-bundled-allow-only-plugin",
      body: simplePluginBody("warn-bundled-allow-only-plugin"),
    });
    const { workspaceDir } = writeWorkspacePlugin({
      id: "warn-noise-workspace-plugin",
    });
    const warnings: string[] = [];
    loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          enabled: true,
          // Allowlist intentionally only trusts a bundled plugin id.
          allow: ["warn-bundled-allow-only-plugin"],
        },
      },
    });
    const openAllowWarnings = warnings.filter(
      (msg) =>
        msg.includes("plugins.allow is empty") ||
        msg.includes("do not match any discovered plugin ids"),
    );
    expect(
      openAllowWarnings,
      "bundled-only allowlists should not trip the mismatch warning",
    ).toHaveLength(0);
  });

  it("includes actionable plugins.allow remediation hints in the open allowlist warning", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();

    const { workspaceDir } = writeWorkspacePlugin({
      id: "warn-open-allow-remediation",
    });
    const warnings: string[] = [];
    loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    const openAllowWarning = warnings.find((msg) => msg.includes("plugins.allow is empty"));
    expect(openAllowWarning).toBeDefined();
    expect(openAllowWarning).toContain('"warn-open-allow-remediation"');
    expect(openAllowWarning).toContain('"plugins": { "allow": [');
    expect(openAllowWarning).toContain("openclaw plugins list --enabled --verbose");
    expect(openAllowWarning).toContain("openclaw plugins inspect warn-open-allow-remediation");
  });

  it("distinguishes load permission from capability trust in the untracked-provenance warning", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const globalDir = path.join(stateDir, "extensions", "warn-untracked-remediation");
      mkdirSafe(globalDir);
      writePlugin({
        id: "warn-untracked-remediation",
        body: simplePluginBody("warn-untracked-remediation"),
        dir: globalDir,
        filename: "index.cjs",
      });

      const warnings: string[] = [];
      const registry = loadOpenClawPlugins({
        cache: false,
        logger: createWarningLogger(warnings),
        config: {
          plugins: {
            enabled: true,
          },
        },
      });

      const untrackedWarning = warnings.find(
        (msg) =>
          msg.includes("warn-untracked-remediation") &&
          msg.includes("OpenClaw can't verify where this plugin came from"),
      );
      expect(untrackedWarning).toBeDefined();
      expect(untrackedWarning).toContain("OpenClaw can't verify where this plugin came from");
      expect(untrackedWarning).toContain("openclaw plugins inspect warn-untracked-remediation");
      expect(untrackedWarning).toContain(
        "plugins.allow lets it load, but does not make it trusted",
      );
      expect(untrackedWarning).toContain(
        "reinstall it from its official npm package or its official ClawHub listing",
      );

      const diagnostic = registry.diagnostics.find(
        (entry) =>
          entry.pluginId === "warn-untracked-remediation" &&
          entry.message.includes("OpenClaw can't verify where this plugin came from"),
      );
      expect(diagnostic?.message).toContain("OpenClaw can't verify where this plugin came from");
      expect(diagnostic?.message).toContain("openclaw plugins inspect warn-untracked-remediation");
      expect(diagnostic?.message).toContain(
        "plugins.allow lets it load, but does not make it trusted",
      );
      expect(diagnostic?.message).toContain(
        "reinstall it from its official npm package or its official ClawHub listing",
      );
    });
  });

  it("omits the truncated plugins.allow snippet when more than six plugins are discovered", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `discovered-plugin-${index + 1}`);
    const warnings: string[] = [];
    const seenWarningKeys = new Set<string>();
    const cache = {
      hasOpenAllowlistWarning(key: string) {
        return seenWarningKeys.has(key);
      },
      recordOpenAllowlistWarning(key: string) {
        seenWarningKeys.add(key);
      },
    };
    warnWhenAllowlistIsOpen({
      emitWarning: true,
      logger: createWarningLogger(warnings),
      pluginsEnabled: true,
      allow: [],
      warningCacheKey: "truncated",
      warningCache: cache,
      discoverablePlugins: ids.map((id) => ({ id, source: `/tmp/${id}`, origin: "global" })),
    });

    expect(warnings).toHaveLength(1);
    const message = warnings[0] ?? "";
    expect(message).toContain("plugins.allow is empty");
    expect(message).toContain("(+2 more)");
    expect(message).not.toContain('"plugins": { "allow": [');
    expect(message).toContain("openclaw plugins list --enabled --verbose");
    expect(message).toContain("openclaw plugins inspect <id>");
  });

  it("handles workspace-discovered plugins according to trust and precedence", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "untrusted workspace plugins stay disabled",
        pluginId: "workspace-helper",
        loadRegistry: () => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "workspace-helper",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectPluginOriginAndStatus({
            registry,
            pluginId: "workspace-helper",
            origin: "workspace",
            status: "disabled",
            label: "untrusted workspace plugins stay disabled",
            errorIncludes: "workspace plugin (disabled by default)",
          });
        },
      },
      {
        label: "trusted workspace plugins load",
        pluginId: "workspace-helper",
        loadRegistry: () => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "workspace-helper",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
                allow: ["workspace-helper"],
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectPluginOriginAndStatus({
            registry,
            pluginId: "workspace-helper",
            origin: "workspace",
            status: "loaded",
            label: "trusted workspace plugins load",
          });
        },
      },
      {
        label: "bundled plugins stay ahead of trusted workspace duplicates",
        pluginId: "shadowed",
        expectedLoadedOrigin: "bundled",
        expectedDisabledOrigin: "workspace",
        expectedDisabledError: "overridden by bundled plugin",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "shadowed",
          });
          const { workspaceDir } = writeWorkspacePlugin({
            id: "shadowed",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
                allow: ["shadowed"],
                entries: {
                  shadowed: { enabled: true },
                },
              },
            },
          });
        },
        assert: (registry: PluginRegistry) => {
          expectPluginSourcePrecedence(registry, {
            pluginId: "shadowed",
            expectedLoadedOrigin: "bundled",
            expectedDisabledOrigin: "workspace",
            expectedDisabledError: "overridden by bundled plugin",
            label: "bundled plugins stay ahead of trusted workspace duplicates",
          });
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => scenario.loadRegistry());
  });

  it("loads bundled plugins when manifest metadata opts into default enablement", () => {
    const { bundledDir, plugin } = writeBundledPlugin({
      id: "profile-aware",
      body: simplePluginBody("profile-aware"),
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "profile-aware",
          enabledByDefault: true,
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    const bundledPlugin = registry.plugins.find((entry) => entry.id === "profile-aware");
    expect(bundledPlugin?.origin).toBe("bundled");
    expect(bundledPlugin?.status).toBe("loaded");
  });

  it("keeps scoped and unscoped plugin ids distinct", () => {
    useNoBundledPlugins();
    const scoped = writePlugin({
      id: "@team/shadowed",
      body: simplePluginBody("@team/shadowed"),
      filename: "scoped.cjs",
    });
    const unscoped = writePlugin({
      id: "shadowed",
      body: simplePluginBody("shadowed"),
      filename: "unscoped.cjs",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [scoped.file, unscoped.file] },
          allow: ["@team/shadowed", "shadowed"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "@team/shadowed")?.status).toBe("loaded");
    expect(registry.plugins.find((entry) => entry.id === "shadowed")?.status).toBe("loaded");
    expectNoDiagnosticContaining({ registry, message: "duplicate plugin id" });
  });

  it("evaluates load-path provenance warnings", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "does not warn when loaded non-bundled plugin is in plugins.allow",
        loadRegistry: () => {
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "rogue");
            mkdirSafe(globalDir);
            writePlugin({
              id: "rogue",
              body: simplePluginBody("rogue"),
              dir: globalDir,
              filename: "index.cjs",
            });

            const warnings: string[] = [];
            const registry = loadOpenClawPlugins({
              cache: false,
              logger: createWarningLogger(warnings),
              config: {
                plugins: {
                  allow: ["rogue"],
                },
              },
            });

            return { registry, warnings, pluginId: "rogue", expectWarning: false };
          });
        },
      },
      {
        label: "warns when loaded non-bundled plugin has no provenance and no allowlist is set",
        loadRegistry: () => {
          const stateDir = makeTempDir();
          return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
            const globalDir = path.join(stateDir, "extensions", "rogue");
            mkdirSafe(globalDir);
            writePlugin({
              id: "rogue",
              body: `module.exports = { id: "rogue", register() {} };`,
              dir: globalDir,
              filename: "index.cjs",
            });

            const warnings: string[] = [];
            const registry = loadOpenClawPlugins({
              cache: false,
              logger: createWarningLogger(warnings),
              config: {
                plugins: {
                  enabled: true,
                },
              },
            });

            return { registry, warnings, pluginId: "rogue", expectWarning: true };
          });
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved load paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-load-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env,
            config: {
              plugins: {
                load: { paths: ["~/plugins/tracked-load-path"] },
                allow: [plugin.id],
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
            expectedSource: plugin.file,
          };
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved install paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-install-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
                allow: [plugin.id],
                installs: {
                  [plugin.id]: {
                    source: "path",
                    installPath: `~/plugins/${plugin.id}`,
                    sourcePath: `~/plugins/${plugin.id}`,
                  },
                },
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
            expectedSource: plugin.file,
          };
        },
      },
      {
        label: "does not warn when install paths resolve through a symlinked state root",
        loadRegistry: () => {
          useNoBundledPlugins();
          const stateDir = makeTempDir();
          const realHome = path.join(stateDir, "real-home");
          const linkedHome = path.join(stateDir, "linked-home");
          mkdirSafe(realHome);
          fs.symlinkSync(realHome, linkedHome, process.platform === "win32" ? "junction" : "dir");

          const pluginDir = path.join(
            realHome,
            ".openclaw",
            "npm",
            "node_modules",
            "@example",
            "tracked-symlink-install",
          );
          mkdirSafe(pluginDir);
          const plugin = writePlugin({
            id: "tracked-symlink-install",
            body: simplePluginBody("tracked-symlink-install"),
            dir: pluginDir,
            filename: "index.cjs",
          });
          writePersistedInstalledPluginIndexInstallRecordsSync(
            {
              [plugin.id]: {
                source: "npm",
                spec: "@example/tracked-symlink-install@1.0.0",
                installPath: path.join(
                  linkedHome,
                  ".openclaw",
                  "npm",
                  "node_modules",
                  "@example",
                  "tracked-symlink-install",
                ),
                version: "1.0.0",
              },
            },
            { stateDir },
          );

          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
            },
            config: {
              plugins: {
                enabled: true,
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
          };
        },
      },
    ] as const;

    runScenarioCases(scenarios, (scenario) => {
      const loadedScenario = scenario.loadRegistry();
      const expectedSource =
        "expectedSource" in loadedScenario && typeof loadedScenario.expectedSource === "string"
          ? loadedScenario.expectedSource
          : undefined;
      expectLoadedPluginProvenance({
        scenario,
        ...loadedScenario,
        expectedSource,
      });
    });
  });

  it("uses the source runtime snapshot allowlist for plugin trust checks", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const globalDir = path.join(stateDir, "extensions", "trusted-plugin");
      mkdirSafe(globalDir);
      writePlugin({
        id: "trusted-plugin",
        body: simplePluginBody("trusted-plugin"),
        dir: globalDir,
        filename: "index.cjs",
      });
      const untrustedDir = path.join(stateDir, "extensions", "untrusted-plugin");
      mkdirSafe(untrustedDir);
      writePlugin({
        id: "untrusted-plugin",
        body: simplePluginBody("untrusted-plugin"),
        dir: untrustedDir,
        filename: "index.cjs",
      });
      const runtimeConfig = {
        plugins: {
          enabled: true,
          allow: ["runtime-added-plugin"],
        },
      } satisfies PluginLoadConfig;
      const sourceConfig = {
        plugins: {
          enabled: true,
          allow: ["trusted-plugin"],
        },
      } satisfies PluginLoadConfig;
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

      const warnings: string[] = [];
      const registry = loadOpenClawPlugins({
        cache: false,
        logger: createWarningLogger(warnings),
        config: runtimeConfig,
      });

      expect(registry.plugins.find((entry) => entry.id === "trusted-plugin")?.status).toBe(
        "loaded",
      );
      const untrustedPlugin = registry.plugins.find((entry) => entry.id === "untrusted-plugin");
      expect(untrustedPlugin?.status).toBe("disabled");
      expect(untrustedPlugin?.error).toBe("not in allowlist");
      expect(warnings.join("\n")).not.toContain("plugins.allow is empty");
      expect(
        warnings.filter(
          (message) =>
            message.includes("trusted-plugin") &&
            message.includes("OpenClaw can't verify where this plugin came from"),
        ),
      ).toEqual([]);
    });
  });

  it.each([
    {
      name: "rejects plugin entry files that escape plugin root via symlink",
      id: "symlinked",
      linkKind: "symlink" as const,
    },
    {
      name: "rejects plugin entry files that escape plugin root via hardlink",
      id: "hardlinked",
      linkKind: "hardlink" as const,
      skip: process.platform === "win32",
    },
  ])("$name", ({ id, linkKind, skip }) => {
    if (skip) {
      return;
    }
    expectEscapingEntryRejected({
      id,
      linkKind,
      sourceBody: `module.exports = { id: "${id}", register() { throw new Error("should not run"); } };`,
    });
  });

  it("allows bundled plugin entry files that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "hardlinked-bundled");
    mkdirSafe(pluginDir);

    const outsideDir = makeTempDir();
    const outsideEntry = path.join(outsideDir, "outside.cjs");
    fs.writeFileSync(
      outsideEntry,
      'module.exports = { id: "hardlinked-bundled", register() {} };',
      "utf-8",
    );
    const plugin = writePlugin({
      id: "hardlinked-bundled",
      body: 'module.exports = { id: "hardlinked-bundled", register() {} };',
      dir: pluginDir,
      filename: "index.cjs",
    });
    fs.rmSync(plugin.file);
    try {
      fs.linkSync(outsideEntry, plugin.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config: {
        plugins: {
          entries: {
            "hardlinked-bundled": { enabled: true },
          },
          allow: ["hardlinked-bundled"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "hardlinked-bundled");
    expect(record?.status).toBe("loaded");
    expectNoDiagnosticContaining({ registry, message: "unsafe plugin path" });
  });

  it("preserves runtime reflection semantics when runtime is lazily initialized", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    const plugin = writePlugin({
      id: "runtime-introspection",
      filename: "runtime-introspection.cjs",
      body: `module.exports = { id: "runtime-introspection", register(api) {
    const runtime = api.runtime ?? {};
    const keys = Object.keys(runtime);
    for (const key of ["channel", "mediaUnderstanding", "llm"]) {
      if (!keys.includes(key)) {
        throw new Error("runtime " + key + " key missing");
      }
      if (!(key in runtime)) {
        throw new Error("runtime " + key + " missing from has check");
      }
      if (!Object.getOwnPropertyDescriptor(runtime, key)) {
        throw new Error("runtime " + key + " descriptor missing");
      }
    }
  } };`,
    });

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: ["runtime-introspection"],
        },
        options: {
          onlyPluginIds: ["runtime-introspection"],
        },
      }),
    );

    const record = registry.plugins.find((entry) => entry.id === "runtime-introspection");
    expect(record?.status).toBe("loaded");
  });

  it("suppresses trust warning logs for non-activating snapshot loads", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const globalDir = path.join(stateDir, "extensions", "rogue");
      mkdirSafe(globalDir);
      writePlugin({
        id: "rogue",
        body: simplePluginBody("rogue"),
        dir: globalDir,
        filename: "index.cjs",
      });

      const warnings: string[] = [];
      const registry = loadOpenClawPlugins({
        activate: false,
        cache: false,
        logger: createWarningLogger(warnings),
        config: {
          plugins: {
            enabled: true,
          },
        },
      });

      expect(warnings).toStrictEqual([]);
      expectDiagnosticContaining({
        registry,
        level: "warn",
        pluginId: "rogue",
        message: "OpenClaw can't verify where this plugin came from",
      });
    });
  });

  it("loads source TypeScript plugins that route through local runtime shims", () => {
    const plugin = writePlugin({
      id: "source-runtime-shim",
      filename: "source-runtime-shim.ts",
      body: `import "./runtime-shim.ts";

  export default {
    id: "source-runtime-shim",
    register() {},
  };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "runtime-shim.ts"),
      `import { helperValue } from "./helper.js";

  export const runtimeValue = helperValue;`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(plugin.dir, "helper.ts"),
      `export const helperValue = "ok";`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["source-runtime-shim"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "source-runtime-shim");
    expect(record?.status).toBe("loaded");
  });

  it("converts Windows absolute import specifiers to file URLs only for module loading", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(toSafeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
      expect(toSafeImportPath("C:\\Users\\alice\\plugin folder\\x#y.mjs")).toBe(
        "file:///C:/Users/alice/plugin%20folder/x%23y.mjs",
      );
      expect(toSafeImportPath("\\\\server\\share\\plugin\\index.mjs")).toBe(
        "file://server/share/plugin/index.mjs",
      );
      expect(toSafeImportPath("file:///C:/Users/alice/plugin/index.mjs")).toBe(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
      expect(toSafeImportPath("./relative/index.mjs")).toBe("./relative/index.mjs");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
