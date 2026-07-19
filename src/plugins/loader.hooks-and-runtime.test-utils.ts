// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  mkdirSafe,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  withStateDir,
  loadRegistryFromSinglePlugin,
  expectDiagnosticContaining,
  createSetupEntryChannelPluginFixture,
  globalAfterEach0,
  globalAfterAll1,
  updatePluginManifest,
} from "./loader.test-harness.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

describe("loadOpenClawPlugins", () => {
  it("setup-loads a trusted global channel plugin when the caller scopes to it", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "trusted-global-channel-imported.txt");
    withStateDir((stateDir) => {
      const globalDir = path.join(stateDir, "extensions", "trusted-global-channel");
      mkdirSafe(globalDir);
      fs.writeFileSync(
        path.join(globalDir, "index.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "trusted-global-channel",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "trusted-global-channel",
          meta: {
            id: "trusted-global-channel",
            label: "Trusted Global Channel",
            selectionLabel: "Trusted Global Channel",
            docsPath: "/channels/trusted-global-channel",
            blurb: "trusted global setup gate",
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
            id: "trusted-global-channel",
            configSchema: EMPTY_PLUGIN_SCHEMA,
            channels: ["trusted-global-channel"],
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
            name: "@openclaw/trusted-global-channel",
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
            allow: ["trusted-global-channel"],
          },
        },
        includeSetupOnlyChannelPlugins: true,
        forceSetupOnlyChannelPlugins: true,
        onlyPluginIds: ["trusted-global-channel"],
      });

      expect(fs.existsSync(marker)).toBe(true);
      expect(scopedSetupRegistry.channelSetups.map((entry) => entry.plugin.meta.label)).toEqual([
        "Trusted Global Channel",
      ]);
      expect(scopedSetupRegistry.channels).toHaveLength(0);
      expect(
        scopedSetupRegistry.plugins.find((entry) => entry.id === "trusted-global-channel")?.status,
      ).toBe("loaded");
    });
  });

  it("does not setup-load an auto-enabled config-origin channel plugin without explicit trust", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "auto-enabled-load-path-channel-imported.txt");
    const plugin = writePlugin({
      id: "auto-enabled-load-path-channel",
      filename: "auto-enabled-load-path-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
  module.exports = {
    id: "auto-enabled-load-path-channel",
    register(api) {
      api.registerChannel({
        plugin: {
          id: "auto-enabled-load-path-channel",
          meta: {
            id: "auto-enabled-load-path-channel",
            label: "Auto Enabled Load Path Channel",
            selectionLabel: "Auto Enabled Load Path Channel",
            docsPath: "/channels/auto-enabled-load-path-channel",
            blurb: "auto-enabled load-path setup gate",
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
          id: "auto-enabled-load-path-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["auto-enabled-load-path-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const scopedSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: {
          "auto-enabled-load-path-channel": {
            enabled: true,
          },
        },
        plugins: {
          load: { paths: [plugin.file] },
        },
      },
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["auto-enabled-load-path-channel"],
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(scopedSetupRegistry.channelSetups).toHaveLength(0);
    expect(scopedSetupRegistry.channels).toHaveLength(0);
    expect(
      scopedSetupRegistry.plugins.find((entry) => entry.id === "auto-enabled-load-path-channel")
        ?.status,
    ).toBe("disabled");
  });

  it.each([
    {
      name: "uses package setupEntry for selected setup-only channel loads",
      fixture: {
        id: "setup-entry-test",
        label: "Setup Entry Test",
        packageName: "@openclaw/setup-entry-test",
        fullBlurb: "full entry should not run in setup-only mode",
        setupBlurb: "setup entry",
        configured: false,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-entry-test"],
              entries: {
                "setup-entry-test": { enabled: false },
              },
            },
          },
          includeSetupOnlyChannelPlugins: true,
          onlyPluginIds: ["setup-entry-test"],
        }),
      expectFullLoaded: false,
      expectSetupLoaded: false,
      expectedChannelSetups: 0,
      expectedChannels: 0,
    },
    {
      name: "keeps bundled setupEntry setup-only loads on the setup-safe path",
      fixture: {
        id: "setup-only-bundled-contract-test",
        label: "Setup Only Bundled Contract Test",
        packageName: "@openclaw/setup-only-bundled-contract-test",
        fullBlurb: "full entry should not run in setup-only mode",
        setupBlurb: "setup-only bundled contract",
        configured: false,
        useBundledSetupEntryContract: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-only-bundled-contract-test"],
              entries: {
                "setup-only-bundled-contract-test": { enabled: false },
              },
            },
          },
          includeSetupOnlyChannelPlugins: true,
          onlyPluginIds: ["setup-only-bundled-contract-test"],
        }),
      expectFullLoaded: false,
      expectSetupLoaded: false,
      expectedChannelSetups: 0,
      expectedChannels: 0,
    },
    {
      name: "uses package setupEntry for enabled but unconfigured channel loads",
      fixture: {
        id: "setup-runtime-test",
        label: "Setup Runtime Test",
        packageName: "@openclaw/setup-runtime-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime",
        configured: false,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-test"],
            },
          },
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
    },
    {
      name: "uses package setupEntry bundled contract for setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-contract-test",
        label: "Setup Runtime Bundled Contract Test",
        packageName: "@openclaw/setup-runtime-bundled-contract-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime bundled contract",
        configured: false,
        useBundledSetupEntryContract: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-contract-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
    },
    {
      name: "preserves bundled setupEntry split secrets for setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-contract-secrets-test",
        label: "Setup Runtime Bundled Contract Secrets Test",
        packageName: "@openclaw/setup-runtime-bundled-contract-secrets-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime bundled contract secrets",
        configured: false,
        useBundledSetupEntryContract: true,
        splitBundledSetupSecrets: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-contract-secrets-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectedSetupSecretId: "channels.setup-runtime-bundled-contract-secrets-test.setup-token",
    },
    {
      name: "applies bundled setupEntry runtime setter for setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-contract-runtime-test",
        label: "Setup Runtime Bundled Contract Runtime Test",
        packageName: "@openclaw/setup-runtime-bundled-contract-runtime-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime bundled contract runtime",
        configured: false,
        useBundledSetupEntryContract: true,
        bundledSetupRuntimeMarker: path.join(makeTempDir(), "setup-runtime-applied.txt"),
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-contract-runtime-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectSetupRuntimeLoaded: true,
    },
    {
      name: "runs bundled setupEntry setup-runtime registrations before deferred full loads",
      fixture: {
        id: "setup-runtime-bundled-route-test",
        label: "Setup Runtime Bundled Route Test",
        packageName: "@openclaw/setup-runtime-bundled-route-test",
        fullBlurb: "full entry should defer while configured",
        setupBlurb: "setup runtime route",
        configured: true,
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
        useBundledSetupEntryContract: true,
        bundledSetupRuntimeRoutePath: "/setup-runtime-route",
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          preferSetupRuntimeForChannelPlugins: true,
          config: {
            channels: {
              "setup-runtime-bundled-route-test": {
                enabled: true,
                token: "configured",
              },
            },
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-route-test"],
            },
          },
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectedSetupRuntimeRoutePath: "/setup-runtime-route",
    },
    {
      name: "merges bundled runtime plugin into setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-runtime-merge-test",
        label: "Setup Runtime Bundled Runtime Merge Test",
        packageName: "@openclaw/setup-runtime-bundled-runtime-merge-test",
        fullBlurb: "full runtime plugin",
        setupBlurb: "setup runtime override",
        configured: false,
        useBundledFullEntryContract: true,
        useBundledSetupEntryContract: true,
        bundledFullRuntimeMarker: path.join(makeTempDir(), "bundled-runtime-applied.txt"),
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-runtime-merge-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectBundledFullRuntimeLoaded: true,
    },
    {
      name: "preserves external setupEntry runtime setter for deferred configured channel loads",
      fixture: {
        id: "setup-runtime-external-deferred-test",
        label: "Setup Runtime External Deferred Test",
        packageName: "@openclaw/setup-runtime-external-deferred-test",
        fullBlurb: "full entry should defer while configured",
        setupBlurb: "setup runtime external deferred",
        configured: true,
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
        bundledSetupRuntimeMarker: path.join(makeTempDir(), "external-setup-runtime-applied.txt"),
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          preferSetupRuntimeForChannelPlugins: true,
          config: {
            channels: {
              "setup-runtime-external-deferred-test": {
                enabled: true,
                token: "configured",
              },
            },
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-external-deferred-test"],
            },
          },
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectSetupRuntimeLoaded: true,
    },
    {
      name: "does not prefer setupEntry for configured channel loads without startup opt-in",
      fixture: {
        id: "setup-runtime-not-preferred-test",
        label: "Setup Runtime Not Preferred Test",
        packageName: "@openclaw/setup-runtime-not-preferred-test",
        fullBlurb: "full entry should still load without explicit startup opt-in",
        setupBlurb: "setup runtime not preferred",
        configured: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          preferSetupRuntimeForChannelPlugins: true,
          config: {
            channels: {
              "setup-runtime-not-preferred-test": {
                enabled: true,
                token: "configured",
              },
            },
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-not-preferred-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: false,
      expectedChannels: 1,
    },
  ])(
    "$name",
    ({
      fixture,
      load,
      expectFullLoaded,
      expectSetupLoaded,
      expectedChannelSetups,
      expectedChannels,
      expectedSetupSecretId,
      expectSetupRuntimeLoaded,
      expectBundledFullRuntimeLoaded,
      expectedSetupRuntimeRoutePath,
    }) => {
      const built = createSetupEntryChannelPluginFixture(fixture);
      const registry = load({ pluginDir: built.pluginDir });

      expect(fs.existsSync(built.fullMarker)).toBe(expectFullLoaded);
      expect(fs.existsSync(built.setupMarker)).toBe(expectSetupLoaded);
      expect(registry.channelSetups).toHaveLength(expectedChannelSetups ?? 1);
      expect(registry.channels).toHaveLength(expectedChannels);
      if (fixture.bundledSetupRuntimeMarker) {
        expect(fs.existsSync(fixture.bundledSetupRuntimeMarker)).toBe(
          expectSetupRuntimeLoaded ?? false,
        );
      }
      if (fixture.bundledFullRuntimeMarker) {
        expect(fs.existsSync(fixture.bundledFullRuntimeMarker)).toBe(
          expectBundledFullRuntimeLoaded ?? false,
        );
      }
      if (expectedSetupSecretId) {
        expect(
          registry.channelSetups[0]?.plugin.secrets?.secretTargetRegistryEntries?.some(
            (entry) => entry.id === expectedSetupSecretId,
          ),
        ).toBe(true);
        expect(
          registry.channels[0]?.plugin.secrets?.secretTargetRegistryEntries?.some(
            (entry) => entry.id === expectedSetupSecretId,
          ),
        ).toBe(true);
      }
      if (expectedSetupRuntimeRoutePath) {
        expect(
          registry.httpRoutes.some(
            (route) =>
              route.pluginId === fixture.id && route.path === expectedSetupRuntimeRoutePath,
          ),
        ).toBe(true);
      }
    },
  );

  it("applies the bundled runtime setter before loading the merged setup-runtime plugin", () => {
    const runtimeMarker = path.join(makeTempDir(), "setup-runtime-before-load.txt");
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-order-test",
      label: "Setup Runtime Order Test",
      packageName: "@openclaw/setup-runtime-order-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledFullEntryContract: true,
      useBundledSetupEntryContract: true,
      bundledFullRuntimeMarker: runtimeMarker,
      requireBundledFullRuntimeBeforeLoad: true,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-runtime-order-test"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-order-test")?.status).toBe(
      "loaded",
    );
    expect(fs.existsSync(runtimeMarker)).toBe(true);
  });

  it("records setup runtime setter failures without aborting the full load pass", () => {
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-error-test",
      label: "Setup Runtime Error Test",
      packageName: "@openclaw/setup-runtime-error-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledSetupEntryContract: true,
      bundledSetupRuntimeError: "broken setup runtime setter",
    });
    const helperPlugin = writePlugin({
      id: "setup-runtime-helper-test",
      filename: "setup-runtime-helper-test.cjs",
      body: `module.exports = { id: "setup-runtime-helper-test", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir, helperPlugin.file] },
          allow: ["setup-runtime-error-test", "setup-runtime-helper-test"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-error-test")?.status).toBe(
      "error",
    );
    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-error-test")?.error,
    ).toContain("broken setup runtime setter");
    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-helper-test")?.status).toBe(
      "loaded",
    );
  });

  it("rolls back setup-runtime registrations when setup side effects fail", () => {
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-route-error-test",
      label: "Setup Runtime Route Error Test",
      packageName: "@openclaw/setup-runtime-route-error-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime route",
      configured: true,
      startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
      useBundledSetupEntryContract: true,
      bundledSetupRuntimeRoutePath: "/setup-runtime-route-error",
      bundledSetupRuntimeRegisterError: "broken setup-runtime registrar",
    });
    const helperPlugin = writePlugin({
      id: "setup-runtime-route-helper-test",
      filename: "setup-runtime-route-helper-test.cjs",
      body: `module.exports = { id: "setup-runtime-route-helper-test", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      preferSetupRuntimeForChannelPlugins: true,
      config: {
        channels: {
          "setup-runtime-route-error-test": {
            enabled: true,
            token: "configured",
          },
        },
        plugins: {
          load: { paths: [built.pluginDir, helperPlugin.file] },
          allow: ["setup-runtime-route-error-test", "setup-runtime-route-helper-test"],
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-route-error-test")?.status,
    ).toBe("error");
    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-route-error-test")?.error,
    ).toContain("broken setup-runtime registrar");
    expect(registry.httpRoutes.some((route) => route.path === "/setup-runtime-route-error")).toBe(
      false,
    );
    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-route-helper-test")?.status,
    ).toBe("loaded");
  });

  it("closes setup-runtime registration APIs after synchronous registration", async () => {
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-late-route-test",
      label: "Setup Runtime Late Route Test",
      packageName: "@openclaw/setup-runtime-late-route-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime route",
      configured: true,
      startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
      useBundledSetupEntryContract: true,
      bundledSetupRuntimeRoutePath: "/setup-runtime-sync-route",
      bundledSetupRuntimeLateRoutePath: "/setup-runtime-late-route",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      preferSetupRuntimeForChannelPlugins: true,
      config: {
        channels: {
          "setup-runtime-late-route-test": {
            enabled: true,
            token: "configured",
          },
        },
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-runtime-late-route-test"],
        },
      },
    });

    await Promise.resolve();

    expect(registry.httpRoutes.some((route) => route.path === "/setup-runtime-sync-route")).toBe(
      true,
    );
    expect(registry.httpRoutes.some((route) => route.path === "/setup-runtime-late-route")).toBe(
      false,
    );
  });

  it("rejects mismatched bundled runtime entry ids before applying setup-runtime setters", () => {
    const runtimeMarker = path.join(makeTempDir(), "setup-runtime-mismatch.txt");
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-mismatch-test",
      bundledFullEntryId: "wrong-runtime-id",
      label: "Setup Runtime Mismatch Test",
      packageName: "@openclaw/setup-runtime-mismatch-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledFullEntryContract: true,
      useBundledSetupEntryContract: true,
      bundledFullRuntimeMarker: runtimeMarker,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-runtime-mismatch-test"],
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-mismatch-test")?.status,
    ).toBe("error");
    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-mismatch-test")?.error,
    ).toContain('runtime entry uses "wrong-runtime-id"');
    expect(registry.channels).toHaveLength(0);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("rejects mismatched bundled setup export ids before loading setup-runtime entry code", () => {
    const runtimeMarker = path.join(makeTempDir(), "setup-runtime-mismatch.txt");
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-export-mismatch-test",
      bundledSetupEntryId: "wrong-setup-id",
      label: "Setup Export Mismatch Test",
      packageName: "@openclaw/setup-export-mismatch-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledFullEntryContract: true,
      useBundledSetupEntryContract: true,
      bundledFullRuntimeMarker: runtimeMarker,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-export-mismatch-test"],
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "setup-export-mismatch-test")?.status,
    ).toBe("error");
    expect(
      registry.plugins.find((entry) => entry.id === "setup-export-mismatch-test")?.error,
    ).toContain('setup export uses "wrong-setup-id"');
    expect(registry.channels).toHaveLength(0);
    expect(fs.existsSync(built.fullMarker)).toBe(false);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("isolates loadSetupPlugin errors as per-plugin diagnostics instead of crashing registry load", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();

    // Plugin whose setup-entry uses the bundled contract but loadSetupPlugin() throws
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-entry-throws-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
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
          id: "setup-entry-throws-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["setup-entry-throws-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    // index.cjs: full entry (should NOT be reached if setup-entry is used)
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: "setup-entry-throws-test", register() {} };`,
      "utf-8",
    );
    // setup-entry.cjs: bundled contract whose loadSetupPlugin throws
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `module.exports = {
    kind: "bundled-channel-setup-entry",
    loadSetupPlugin: () => { throw new Error("boom: setup plugin missing"); },
  };`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["setup-entry-throws-test"],
        },
      },
    });

    // The registry load should NOT crash; the error should be recorded as a
    // per-plugin diagnostic rather than aborting the whole load.
    expect(registry.diagnostics.length).toBeGreaterThanOrEqual(1);
    const diagnostic = registry.diagnostics.find(
      (d) => d.pluginId === "setup-entry-throws-test" && d.level === "error",
    );
    expect(diagnostic?.message).toContain("failed to load setup entry");
  });

  it("keeps healthy sibling channel plugins loadable when a setup entry throws", () => {
    useNoBundledPlugins();
    const brokenDir = makeTempDir();

    fs.writeFileSync(
      path.join(brokenDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-entry-throws-sibling-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-entry-throws-sibling-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["broken-chat"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "index.cjs"),
      `module.exports = { id: "setup-entry-throws-sibling-test", register() {} };`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "setup-entry.cjs"),
      `module.exports = {
    kind: "bundled-channel-setup-entry",
    loadSetupPlugin: () => { throw new Error("boom: setup plugin missing"); },
  };`,
      "utf-8",
    );

    const healthy = writePlugin({
      id: "healthy-channel",
      filename: "healthy-channel.cjs",
      body: `module.exports = { id: "healthy-channel", register(api) {
    api.registerChannel({
      plugin: {
        id: "healthy-chat",
        meta: {
          id: "healthy-chat",
          label: "Healthy Chat",
          selectionLabel: "Healthy Chat",
          docsPath: "/channels/healthy-chat",
          blurb: "healthy sibling channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      }
    });
  } };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [brokenDir, healthy.file] },
          allow: ["setup-entry-throws-sibling-test", "healthy-channel"],
        },
      },
    });

    const healthyMeta = registry.channels.find((entry) => entry.plugin.id === "healthy-chat")
      ?.plugin.meta;
    if (!healthyMeta) {
      throw new Error("expected healthy chat plugin metadata");
    }
    expect(healthyMeta?.label).toBe("Healthy Chat");
    expect(healthyMeta?.docsPath).toBe("/channels/healthy-chat");
    expect(registry.plugins.find((entry) => entry.id === "healthy-channel")?.status).toBe("loaded");
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "setup-entry-throws-sibling-test",
      message: "failed to load setup entry",
    });
  });

  it("records a diagnostic when registerChannel throws in the setup-entry path", () => {
    useNoBundledPlugins();
    const brokenDir = makeTempDir();

    fs.writeFileSync(
      path.join(brokenDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/register-channel-throws-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "register-channel-throws-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["register-channel-throws-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "index.cjs"),
      `module.exports = { id: "register-channel-throws-test", register() {} };`,
      "utf-8",
    );
    // setup-entry.cjs: loadSetupPlugin succeeds, but the returned plugin
    // has a nested throwing getter on config.listAccountIds that triggers
    // inside registerChannel -> normalizeRegisteredChannelPlugin.
    fs.writeFileSync(
      path.join(brokenDir, "setup-entry.cjs"),
      `const configObj = {
    resolveAccount: () => ({ accountId: "default" }),
  };
  Object.defineProperty(configObj, "listAccountIds", {
    get() { throw new Error("boom: registerChannel exploded"); },
    enumerable: true,
    configurable: true,
  });
  module.exports = {
    kind: "bundled-channel-setup-entry",
    loadSetupPlugin: () => ({
      id: "register-channel-throws-test",
      meta: {
        id: "register-channel-throws-test",
        label: "Throws on register",
        selectionLabel: "Throws on register",
        docsPath: "/channels/register-throws",
        blurb: "test channel that throws during registration",
      },
      capabilities: { chatTypes: ["direct"] },
      config: configObj,
      outbound: { deliveryMode: "direct" },
    }),
  };`,
      "utf-8",
    );

    const healthy = writePlugin({
      id: "healthy-after-register-throw",
      filename: "healthy-after-register-throw.cjs",
      body: `module.exports = { id: "healthy-after-register-throw", register(api) {
    api.registerChannel({
      plugin: {
        id: "healthy-after-register-throw-chat",
        meta: {
          id: "healthy-after-register-throw-chat",
          label: "Healthy After Register Throw",
          selectionLabel: "Healthy After Register Throw",
          docsPath: "/channels/healthy-after-register-throw",
          blurb: "survives sibling registerChannel throw",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      }
    });
  } };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [brokenDir, healthy.file] },
          allow: ["register-channel-throws-test", "healthy-after-register-throw"],
        },
      },
    });

    // The broken plugin should be recorded as a diagnostic, not crash the loop.
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "register-channel-throws-test",
      message: "failed to register setup channel",
    });
    // The healthy plugin loaded AFTER the broken one must still be present.
    const healthyChannel = registry.channels.find(
      (entry) => entry.plugin.id === "healthy-after-register-throw-chat",
    );
    if (!healthyChannel) {
      throw new Error("expected healthy channel after register throw");
    }
    expect(healthyChannel.plugin.meta.label).toBe("Healthy After Register Throw");
    expect(
      registry.plugins.find((entry) => entry.id === "healthy-after-register-throw")?.status,
    ).toBe("loaded");
  });

  it("prefers built bundled plugin artifacts over source TS when requested", () => {
    const repoRoot = makeTempDir();
    const sourceDir = path.join(repoRoot, "extensions", "startup-artifact-test");
    const runtimeDir = path.join(repoRoot, "dist-runtime", "extensions", "startup-artifact-test");
    mkdirSafe(sourceDir);
    mkdirSafe(runtimeDir);
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "startup-artifact-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "index.ts"),
      'throw new Error("source TS should not load during gateway startup");\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(runtimeDir, "index.js"),
      'module.exports = { id: "startup-artifact-test", register() {} };\n',
      "utf-8",
    );

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          preferBuiltPluginArtifacts: true,
          onlyPluginIds: ["startup-artifact-test"],
          config: {
            plugins: {
              allow: ["startup-artifact-test"],
              entries: {
                "startup-artifact-test": {
                  enabled: true,
                },
              },
            },
          },
        }),
    );

    expect(registry.plugins.find((entry) => entry.id === "startup-artifact-test")?.status).toBe(
      "loaded",
    );
  });

  it("prefers package-local dist artifacts for bundled source checkout plugins", () => {
    const repoRoot = makeTempDir();
    const sourceDir = path.join(repoRoot, "extensions", "startup-package-artifact-test");
    const runtimeDir = path.join(sourceDir, "dist");
    mkdirSafe(sourceDir);
    mkdirSafe(runtimeDir);
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "startup-package-artifact-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify(
        {
          openclaw: {
            extensions: ["./index.ts"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "index.ts"),
      'throw new Error("source TS should not load during gateway startup");\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(runtimeDir, "index.js"),
      'module.exports = { id: "startup-package-artifact-test", register() {} };\n',
      "utf-8",
    );

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          preferBuiltPluginArtifacts: true,
          onlyPluginIds: ["startup-package-artifact-test"],
          config: {
            plugins: {
              allow: ["startup-package-artifact-test"],
              entries: {
                "startup-package-artifact-test": {
                  enabled: true,
                },
              },
            },
          },
        }),
    );

    expect(
      registry.plugins.find((entry) => entry.id === "startup-package-artifact-test")?.status,
    ).toBe("loaded");
  });

  it("ignores built artifacts when the bundled source plugin opts out of core dist", () => {
    const repoRoot = makeTempDir();
    const sourceDir = path.join(repoRoot, "extensions", "source-only-artifact-test");
    const runtimeDir = path.join(sourceDir, "dist");
    const builtPluginDir = path.join(repoRoot, "dist", "extensions", "source-only-artifact-test");
    mkdirSafe(path.join(repoRoot, ".git"));
    mkdirSafe(path.join(repoRoot, "src"));
    mkdirSafe(sourceDir);
    mkdirSafe(runtimeDir);
    mkdirSafe(builtPluginDir);
    fs.writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");
    fs.writeFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify(
        { id: "source-only-artifact-test", configSchema: EMPTY_PLUGIN_SCHEMA },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        openclaw: {
          extensions: ["./index.ts"],
          build: { bundledDist: false },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "index.ts"),
      'export default { id: "source-only-artifact-test", register() {} };\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(runtimeDir, "index.js"),
      'throw new Error("stale package-local dist should not load");\n',
      "utf-8",
    );
    fs.copyFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      path.join(builtPluginDir, "openclaw.plugin.json"),
    );
    fs.writeFileSync(
      path.join(builtPluginDir, "package.json"),
      JSON.stringify({ openclaw: { extensions: ["./index.js"] } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(builtPluginDir, "index.js"),
      'throw new Error("stale discovered core dist should not load");\n',
      "utf-8",
    );
    const bundledRuntimeDir = path.join(
      repoRoot,
      "dist-runtime",
      "extensions",
      "source-only-artifact-test",
    );
    mkdirSafe(bundledRuntimeDir);
    fs.writeFileSync(
      path.join(bundledRuntimeDir, "index.js"),
      'throw new Error("stale core dist should not load");\n',
      "utf-8",
    );

    const config = {
      plugins: {
        allow: ["source-only-artifact-test"],
        entries: { "source-only-artifact-test": { enabled: true } },
      },
    };
    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "dist", "extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () => {
        const manifestRegistry = loadPluginManifestRegistry({ config });
        return loadOpenClawPlugins({
          cache: false,
          preferBuiltPluginArtifacts: true,
          onlyPluginIds: ["source-only-artifact-test"],
          config,
          manifestRegistry,
        });
      },
    );

    expect(registry.plugins.find((entry) => entry.id === "source-only-artifact-test")?.status).toBe(
      "loaded",
    );
  });

  it("prefers package-local dist artifacts over workspace source TS when requested", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const distDir = path.join(pluginDir, "dist");
    mkdirSafe(distDir);
    mkdirSafe(path.join(pluginDir, "src"));
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          openclaw: {
            extensions: ["./src/index.mts"],
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
          id: "workspace-artifact-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "src", "index.mts"),
      'throw new Error("workspace source TS should not load during gateway startup");\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(distDir, "index.mjs"),
      'export default { id: "workspace-artifact-test", register() {} };\n',
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      preferBuiltPluginArtifacts: true,
      config: {
        plugins: {
          allow: ["workspace-artifact-test"],
          load: { paths: [pluginDir] },
          entries: {
            "workspace-artifact-test": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "workspace-artifact-test")?.status).toBe(
      "loaded",
    );
  });

  it("probes supported package-local dist artifact extensions before source TS", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const distDir = path.join(pluginDir, "dist");
    mkdirSafe(distDir);
    mkdirSafe(path.join(pluginDir, "src"));
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          openclaw: {
            extensions: ["./src/index.ts"],
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
          id: "workspace-artifact-extension-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "src", "index.ts"),
      'throw new Error("workspace source TS should not load during gateway startup");\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(distDir, "index.mjs"),
      'export default { id: "workspace-artifact-extension-test", register() {} };\n',
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      preferBuiltPluginArtifacts: true,
      config: {
        plugins: {
          allow: ["workspace-artifact-extension-test"],
          load: { paths: [pluginDir] },
          entries: {
            "workspace-artifact-extension-test": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "workspace-artifact-extension-test")?.status,
    ).toBe("loaded");
  });

  it("does not replace explicit JavaScript entries with package-local dist artifacts", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const distDir = path.join(pluginDir, "dist");
    mkdirSafe(distDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          openclaw: {
            extensions: ["./index.js"],
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
          id: "workspace-explicit-js-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      'export default { id: "workspace-explicit-js-test", register() {} };\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(distDir, "index.js"),
      'throw new Error("explicit JS entry should not be replaced by dist");\n',
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      preferBuiltPluginArtifacts: true,
      config: {
        plugins: {
          allow: ["workspace-explicit-js-test"],
          load: { paths: [pluginDir] },
          entries: {
            "workspace-explicit-js-test": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "workspace-explicit-js-test")?.status,
    ).toBe("loaded");
  });

  it("keeps package-local dist artifacts inside the plugin root boundary", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const outsideDistDir = makeTempDir();
    mkdirSafe(path.join(pluginDir, "src"));
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          openclaw: {
            extensions: ["./src/index.mts"],
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
          id: "workspace-artifact-symlink-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "src", "index.mts"),
      'throw new Error("workspace source TS should not load during gateway startup");\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(outsideDistDir, "index.mjs"),
      'export default { id: "workspace-artifact-symlink-test", register() {} };\n',
      "utf-8",
    );
    try {
      fs.symlinkSync(outsideDistDir, path.join(pluginDir, "dist"), "dir");
    } catch {
      return;
    }

    const registry = loadOpenClawPlugins({
      cache: false,
      preferBuiltPluginArtifacts: true,
      config: {
        plugins: {
          allow: ["workspace-artifact-symlink-test"],
          load: { paths: [pluginDir] },
          entries: {
            "workspace-artifact-symlink-test": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "workspace-artifact-symlink-test")?.status,
    ).not.toBe("loaded");
    expectDiagnosticContaining({ registry, message: "escapes" });
  });

  it("blocks before_prompt_build but preserves legacy model overrides when prompt injection is disabled", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy",
      filename: "hook-policy.cjs",
      body: `module.exports = { id: "hook-policy", register(api) {
    api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
    api.on("before_agent_start", () => ({
      prependContext: "legacy",
      modelOverride: "demo-legacy-model",
      providerOverride: "demo-legacy-provider",
    }));
    api.on("before_model_resolve", () => ({ providerOverride: "demo-explicit-provider" }));
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy"],
        entries: {
          "hook-policy": {
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess: true,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-policy")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_agent_start",
      "before_model_resolve",
    ]);
    const runner = createHookRunner(registry);
    const legacyResult = await runner.runBeforeAgentStart({ prompt: "hello", messages: [] }, {});
    expect(legacyResult).toEqual({
      modelOverride: "demo-legacy-model",
      providerOverride: "demo-legacy-provider",
    });
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(1);
    const constrainedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "prompt fields constrained by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(constrainedDiagnostics).toHaveLength(1);
  });

  it("blocks next-turn injections when prompt injection is disabled", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "next-turn-policy",
      filename: "next-turn-policy.cjs",
      body: `module.exports = { id: "next-turn-policy", register(api) {
    void api.session.workflow.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "blocked context",
    });
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["next-turn-policy"],
        entries: {
          "next-turn-policy": {
            hooks: {
              allowPromptInjection: false,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "next-turn-policy")?.status).toBe(
      "loaded",
    );
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.pluginId === "next-turn-policy" &&
          entry.message ===
            "next-turn injection blocked by plugins.entries.next-turn-policy.hooks.allowPromptInjection=false",
      ),
    ).toBe(true);
  });

  it("keeps prompt-injection typed hooks enabled by default", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy-default",
      filename: "hook-policy-default.cjs",
      body: `module.exports = { id: "hook-policy-default", register(api) {
    api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
    api.on("before_agent_start", () => ({ prependContext: "legacy" }));
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy-default"],
      },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_prompt_build",
      "before_agent_start",
    ]);
  });

  it("applies configured typed hook timeout overrides", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-timeouts",
      filename: "hook-timeouts.cjs",
      body: `module.exports = { id: "hook-timeouts", register(api) {
    api.on("before_prompt_build", () => ({ prependContext: "prepend" }), { timeoutMs: 5000 });
    api.on("before_model_resolve", () => ({ providerOverride: "demo-provider" }));
    api.on("before_agent_start", () => ({ modelOverride: "demo-model" }));
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-timeouts"],
        entries: {
          "hook-timeouts": {
            hooks: {
              allowConversationAccess: true,
              timeoutMs: 250,
              timeouts: {
                before_model_resolve: 750,
              },
            },
          },
        },
      },
    });

    expect(
      Object.fromEntries(registry.typedHooks.map((entry) => [entry.hookName, entry.timeoutMs])),
    ).toEqual({
      before_prompt_build: 250,
      before_model_resolve: 750,
      before_agent_start: 250,
    });
  });

  it.each([
    {
      label: "per-hook timeout over the global timeout",
      hooks: { timeoutMs: 250, timeouts: { after_tool_call: 25 } },
      expectedTimeoutMs: 25,
    },
    {
      label: "global timeout when no per-hook timeout is configured",
      hooks: { timeoutMs: 40 },
      expectedTimeoutMs: 40,
    },
  ])("bounds agent tool-result middleware with $label", async ({ hooks, expectedTimeoutMs }) => {
    useNoBundledPlugins();
    const pluginId = `tool-result-middleware-timeout-${expectedTimeoutMs}`;
    const plugin = writePlugin({
      id: pluginId,
      filename: `${pluginId}.cjs`,
      body: `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
    api.registerAgentToolResultMiddleware(() => new Promise(() => {}), {
      runtimes: ["openclaw"],
    });
  } };`,
    });
    updatePluginManifest(plugin, {
      contracts: { agentToolResultMiddleware: ["openclaw"] },
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: [pluginId],
        entries: {
          [pluginId]: {
            hooks,
          },
        },
      },
    });
    const middleware = registry.agentToolResultMiddlewares[0];
    if (!middleware) {
      throw new Error("expected tool-result middleware registration");
    }

    vi.useFakeTimers();
    try {
      const middlewareRun = middleware.handler(
        {
          toolCallId: "call-1",
          toolName: "exec",
          args: {},
          result: { content: [{ type: "text", text: "raw" }], details: {} },
        },
        { runtime: "openclaw" },
      );
      const outcome = Promise.resolve(middlewareRun).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({
          status: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await vi.advanceTimersByTimeAsync(expectedTimeoutMs);

      await expect(outcome).resolves.toEqual({
        status: "rejected",
        message: `agent tool result middleware for ${pluginId} timed out after ${expectedTimeoutMs}ms`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves agent tool-result middleware unbounded when no timeout is configured", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "tool-result-middleware-no-timeout",
      filename: "tool-result-middleware-no-timeout.cjs",
      body: `module.exports = { id: "tool-result-middleware-no-timeout", register(api) {
    api.registerAgentToolResultMiddleware(() => new Promise(() => {}), {
      runtimes: ["openclaw"],
    });
  } };`,
    });
    updatePluginManifest(plugin, {
      contracts: { agentToolResultMiddleware: ["openclaw"] },
    });
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["tool-result-middleware-no-timeout"] },
    });
    const middleware = registry.agentToolResultMiddlewares[0];
    if (!middleware) {
      throw new Error("expected tool-result middleware registration");
    }

    vi.useFakeTimers();
    try {
      let settled = false;
      void Promise.resolve(
        middleware.handler(
          {
            toolCallId: "call-1",
            toolName: "exec",
            args: {},
            result: { content: [{ type: "text", text: "raw" }], details: {} },
          },
          { runtime: "openclaw" },
        ),
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the registration option when typed hook policy has no timeout", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "after-tool-call-option-timeout",
      filename: "after-tool-call-option-timeout.cjs",
      body: `module.exports = { id: "after-tool-call-option-timeout", register(api) {
    api.on("after_tool_call", () => new Promise(() => {}), { timeoutMs: 30 });
  } };`,
    });
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["after-tool-call-option-timeout"] },
    });
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(registry, { logger });

    vi.useFakeTimers();
    try {
      const run = runner.runAfterToolCall({ toolName: "exec", params: {} }, { toolName: "exec" });
      await vi.advanceTimersByTimeAsync(30);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] after_tool_call handler from after-tool-call-option-timeout failed: timed out after 30ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks conversation typed hooks for non-bundled plugins unless explicitly allowed", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "conversation-hooks",
      filename: "conversation-hooks.cjs",
      body: `module.exports = { id: "conversation-hooks", register(api) {
    api.on("before_model_resolve", () => undefined);
    api.on("before_agent_reply", () => undefined);
    api.on("llm_input", () => undefined);
    api.on("llm_output", () => undefined);
    api.on("before_agent_finalize", () => undefined);
    api.on("agent_end", () => undefined);
    api.on("before_agent_run", () => undefined);
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["conversation-hooks"],
      },
    });

    expect(registry.typedHooks).toStrictEqual([]);
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "non-bundled plugins must set plugins.entries.conversation-hooks.hooks.allowConversationAccess=true",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(7);
  });

  it("allows conversation typed hooks for non-bundled plugins when explicitly enabled", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "conversation-hooks-allowed",
      filename: "conversation-hooks-allowed.cjs",
      body: `module.exports = { id: "conversation-hooks-allowed", register(api) {
    api.on("before_model_resolve", () => undefined);
    api.on("before_agent_reply", () => undefined);
    api.on("llm_input", () => undefined);
    api.on("llm_output", () => undefined);
    api.on("before_agent_finalize", () => undefined);
    api.on("agent_end", () => undefined);
    api.on("before_agent_run", () => undefined);
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["conversation-hooks-allowed"],
        entries: {
          "conversation-hooks-allowed": {
            hooks: {
              allowConversationAccess: true,
            },
          },
        },
      },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_model_resolve",
      "before_agent_reply",
      "llm_input",
      "llm_output",
      "before_agent_finalize",
      "agent_end",
      "before_agent_run",
    ]);
  });

  it("normalizes legacy deactivate typed hooks onto gateway_stop", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "legacy-deactivate-hook",
      filename: "legacy-deactivate-hook.cjs",
      body: `module.exports = { id: "legacy-deactivate-hook", register(api) {
    api.on("deactivate", () => undefined);
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["legacy-deactivate-hook"],
        entries: {
          "legacy-deactivate-hook": {
            hooks: {
              timeoutMs: 250,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "legacy-deactivate-hook")?.status).toBe(
      "loaded",
    );
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["gateway_stop"]);
    expect(registry.typedHooks[0]?.timeoutMs).toBe(250);
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "legacy-deactivate-hook" &&
          diag.message ===
            'typed hook "deactivate" is deprecated (legacy-deactivate-hook-alias); use "gateway_stop". This compatibility alias will be removed after 2026-08-16.',
      ),
    ).toBe(true);
  });

  it("warns when plugins register deprecated subagent_spawning typed hooks", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "legacy-subagent-spawning-hook",
      filename: "legacy-subagent-spawning-hook.cjs",
      body: `module.exports = { id: "legacy-subagent-spawning-hook", register(api) {
    api.on("subagent_spawning", () => ({ status: "ok" }));
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["legacy-subagent-spawning-hook"],
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "legacy-subagent-spawning-hook")?.status,
    ).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["subagent_spawning"]);
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "legacy-subagent-spawning-hook" &&
          diag.message ===
            'typed hook "subagent_spawning" is deprecated (legacy-subagent-spawning-hook); Core prepares thread-bound subagent bindings through channel session-binding adapters before `subagent_spawned` fires. Use `subagent_spawned` for observation; core session bindings for routing. This compatibility hook will be removed after 2026-08-30.',
      ),
    ).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
