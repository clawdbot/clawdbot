// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
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
  writeFixtureText,
  writeFixtureJson,
  pluginManifest,
  channelPluginSource,
} from "./loader.test-harness.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

function createSetupFailureFixture(params: {
  id: string;
  channelId?: string;
  setupEntrySource: string;
}) {
  const pluginDir = makePluginLoaderTempDir();
  writeFixtureJson(pluginDir, "package.json", {
    name: `@openclaw/${params.id}`,
    openclaw: {
      extensions: ["./index.cjs"],
      setupEntry: "./setup-entry.cjs",
    },
  });
  writeFixtureJson(
    pluginDir,
    "openclaw.plugin.json",
    pluginManifest(params.id, [params.channelId ?? params.id]),
  );
  writeFixtureText(
    pluginDir,
    "index.cjs",
    `module.exports = { id: ${JSON.stringify(params.id)}, register() {} };`,
  );
  writeFixtureText(pluginDir, "setup-entry.cjs", params.setupEntrySource);
  return pluginDir;
}

const THROWING_SETUP_ENTRY_SOURCE = `module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin: () => { throw new Error("boom: setup plugin missing"); },
};`;

function loadSetupPlugins(params: { paths: string[]; ids: string[]; enabled?: boolean }) {
  return loadOpenClawPlugins({
    cache: false,
    channelPluginLoadIntent: "setup",
    config: {
      plugins: {
        ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
        load: { paths: params.paths },
        allow: params.ids,
      },
    },
  });
}

type SetupEntryScenario = {
  name: string;
  fixture: Parameters<typeof createSetupEntryChannelPluginFixture>[0];
  loadOptions?: {
    setupIntent?: boolean;
    setupOnly?: boolean;
    scopePlugin?: boolean;
    disableEntry?: boolean;
  };
  expectFullLoaded: boolean;
  expectSetupLoaded: boolean;
  expectedChannelSetups?: number;
  expectedChannels: number;
  expectedSetupSecretId?: string;
  expectSetupRuntimeLoaded?: boolean;
  expectBundledFullRuntimeLoaded?: boolean;
};

type BuiltArtifactScenario = {
  id: string;
  origin: "bundled" | "workspace";
  sourceEntry: string;
  sourceBody: string;
  artifactLocation: "core" | "package";
  artifactEntry: string;
  artifactBody: string;
  packageBeforeManifest?: boolean;
  packageEntry?: string;
};

function loadBuiltArtifactScenario(scenario: BuiltArtifactScenario) {
  const repoRoot = makePluginLoaderTempDir();
  const pluginDir =
    scenario.origin === "bundled"
      ? path.join(repoRoot, "extensions", scenario.id)
      : makePluginLoaderTempDir();
  const packageManifest = scenario.packageEntry
    ? { openclaw: { extensions: [scenario.packageEntry] } }
    : undefined;
  if (scenario.packageBeforeManifest && packageManifest) {
    writeFixtureJson(pluginDir, "package.json", packageManifest);
  }
  writeFixtureJson(pluginDir, "openclaw.plugin.json", pluginManifest(scenario.id));
  if (!scenario.packageBeforeManifest && packageManifest) {
    writeFixtureJson(pluginDir, "package.json", packageManifest);
  }
  writeFixtureText(pluginDir, scenario.sourceEntry, scenario.sourceBody);
  const artifactDir =
    scenario.artifactLocation === "core"
      ? path.join(repoRoot, "dist-runtime", "extensions", scenario.id)
      : path.join(pluginDir, "dist");
  writeFixtureText(artifactDir, scenario.artifactEntry, scenario.artifactBody);

  const load = () =>
    loadOpenClawPlugins({
      cache: false,
      preferBuiltPluginArtifacts: true,
      ...(scenario.origin === "bundled" ? { onlyPluginIds: [scenario.id] } : {}),
      config: {
        plugins: {
          allow: [scenario.id],
          ...(scenario.origin === "workspace" ? { load: { paths: [pluginDir] } } : {}),
          entries: { [scenario.id]: { enabled: true } },
        },
      },
    });
  const registry =
    scenario.origin === "bundled"
      ? withEnv(
          {
            OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          },
          load,
        )
      : load();
  return registry.plugins.find((entry) => entry.id === scenario.id)?.status;
}

function loadSourceExternalArtifactScenario(params: {
  sourceBody: string;
  packageLocalBody: string;
  rootBuildBody?: string;
  runtimeOverlayBody?: string;
}) {
  const id = "source-external-artifact-test";
  const repoRoot = makePluginLoaderTempDir();
  const sourceDir = path.join(repoRoot, "extensions", id);
  const rootBuildDir = path.join(repoRoot, "dist", "extensions", id);
  mkdirSafe(path.join(repoRoot, ".git"));
  mkdirSafe(path.join(repoRoot, "src"));
  writeFixtureText(repoRoot, "pnpm-workspace.yaml", "packages: []\n");
  writeFixtureJson(sourceDir, "openclaw.plugin.json", pluginManifest(id));
  writeFixtureJson(sourceDir, "package.json", {
    openclaw: {
      extensions: ["./index.ts"],
      build: { bundledDist: false },
    },
  });
  writeFixtureText(sourceDir, "index.ts", params.sourceBody);
  writeFixtureText(sourceDir, "dist/index.js", params.packageLocalBody);
  if (params.rootBuildBody) {
    mkdirSafe(rootBuildDir);
    fs.copyFileSync(
      path.join(sourceDir, "openclaw.plugin.json"),
      path.join(rootBuildDir, "openclaw.plugin.json"),
    );
    writeFixtureJson(rootBuildDir, "package.json", {
      openclaw: { extensions: ["./index.js"] },
    });
    writeFixtureText(rootBuildDir, "index.js", params.rootBuildBody);
  }
  if (params.runtimeOverlayBody) {
    writeFixtureText(
      repoRoot,
      path.join("dist-runtime", "extensions", id, "index.js"),
      params.runtimeOverlayBody,
    );
  }

  const config = {
    plugins: {
      allow: [id],
      entries: { [id]: { enabled: true } },
    },
  };
  const registry = withEnv(
    {
      OPENCLAW_BUNDLED_PLUGINS_DIR: params.rootBuildBody
        ? path.join(repoRoot, "dist", "extensions")
        : path.join(repoRoot, "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    () => {
      const manifestRegistry = loadPluginManifestRegistryCore({ config });
      return loadOpenClawPlugins({
        cache: false,
        preferBuiltPluginArtifacts: true,
        onlyPluginIds: [id],
        config,
        manifestRegistry,
      });
    },
  );
  return registry.plugins.find((entry) => entry.id === id)?.status;
}

describe("loadOpenClawPlugins", () => {
  it("setup-loads a trusted global channel plugin when the caller scopes to it", () => {
    useNoBundledPlugins();
    const marker = path.join(makePluginLoaderTempDir(), "trusted-global-channel-imported.txt");
    withStateDir((stateDir) => {
      const globalDir = path.join(stateDir, "extensions", "trusted-global-channel");
      mkdirSafe(globalDir);
      writeFixtureText(
        globalDir,
        "index.cjs",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
${channelPluginSource({
  pluginId: "trusted-global-channel",
  label: "Trusted Global Channel",
  docsPath: "/channels/trusted-global-channel",
  blurb: "trusted global setup gate",
})}`,
      );
      writeFixtureJson(
        globalDir,
        "openclaw.plugin.json",
        pluginManifest("trusted-global-channel", ["trusted-global-channel"]),
      );
      writeFixtureJson(globalDir, "package.json", {
        name: "@openclaw/trusted-global-channel",
        version: "0.0.0-test",
        main: "./index.cjs",
        openclaw: {
          extensions: ["./index.cjs"],
        },
      });

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
    const marker = path.join(
      makePluginLoaderTempDir(),
      "auto-enabled-load-path-channel-imported.txt",
    );
    const plugin = writePlugin({
      id: "auto-enabled-load-path-channel",
      filename: "auto-enabled-load-path-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
${channelPluginSource({
  pluginId: "auto-enabled-load-path-channel",
  label: "Auto Enabled Load Path Channel",
  docsPath: "/channels/auto-enabled-load-path-channel",
  blurb: "auto-enabled load-path setup gate",
})}`,
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
      loadOptions: {
        setupIntent: true,
        setupOnly: true,
        scopePlugin: true,
        disableEntry: true,
      },
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
      loadOptions: {
        setupIntent: true,
        setupOnly: true,
        scopePlugin: true,
        disableEntry: true,
      },
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
      loadOptions: { setupIntent: true },
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
      loadOptions: { setupIntent: true },
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
      loadOptions: { setupIntent: true },
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
        bundledSetupRuntimeMarker: path.join(
          makePluginLoaderTempDir(),
          "setup-runtime-applied.txt",
        ),
      },
      loadOptions: { setupIntent: true },
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectSetupRuntimeLoaded: true,
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
        bundledFullRuntimeMarker: path.join(
          makePluginLoaderTempDir(),
          "bundled-runtime-applied.txt",
        ),
      },
      loadOptions: { setupIntent: true },
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectBundledFullRuntimeLoaded: true,
    },
    {
      name: "defaults ordinary unconfigured channel loads to the full runtime",
      fixture: {
        id: "setup-runtime-default-full-test",
        label: "Setup Runtime Default Full Test",
        packageName: "@openclaw/setup-runtime-default-full-test",
        fullBlurb: "ordinary full runtime",
        setupBlurb: "setup runtime should not load by default",
        configured: false,
      },
      expectFullLoaded: true,
      expectSetupLoaded: false,
      expectedChannels: 1,
    },
  ] satisfies SetupEntryScenario[])(
    "$name",
    ({
      fixture,
      loadOptions,
      expectFullLoaded,
      expectSetupLoaded,
      expectedChannelSetups,
      expectedChannels,
      expectedSetupSecretId,
      expectSetupRuntimeLoaded,
      expectBundledFullRuntimeLoaded,
    }: SetupEntryScenario) => {
      const built = createSetupEntryChannelPluginFixture(fixture);
      const registry = loadOpenClawPlugins({
        cache: false,
        ...(loadOptions?.setupIntent ? { channelPluginLoadIntent: "setup" as const } : {}),
        config: {
          plugins: {
            load: { paths: [built.pluginDir] },
            allow: [fixture.id],
            ...(loadOptions?.disableEntry ? { entries: { [fixture.id]: { enabled: false } } } : {}),
          },
        },
        ...(loadOptions?.setupOnly ? { includeSetupOnlyChannelPlugins: true } : {}),
        ...(loadOptions?.scopePlugin ? { onlyPluginIds: [fixture.id] } : {}),
      });

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
    },
  );

  it("applies the bundled runtime setter before loading the merged setup-runtime plugin", () => {
    const runtimeMarker = path.join(makePluginLoaderTempDir(), "setup-runtime-before-load.txt");
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

    const registry = loadSetupPlugins({
      paths: [built.pluginDir],
      ids: ["setup-runtime-order-test"],
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

    const registry = loadSetupPlugins({
      paths: [built.pluginDir, helperPlugin.file],
      ids: ["setup-runtime-error-test", "setup-runtime-helper-test"],
    });

    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-error-test")).toMatchObject(
      {
        status: "error",
        failurePhase: "load",
        error: expect.stringContaining("broken setup runtime setter"),
      },
    );
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "setup-runtime-error-test",
        code: "channel-setup-failure",
      }),
    );
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
      configured: false,
      useBundledSetupEntryContract: true,
      bundledSetupRuntimeRoutePath: "/setup-runtime-route-error",
      bundledSetupRuntimeRegisterError: "broken setup-runtime registrar",
    });
    const helperPlugin = writePlugin({
      id: "setup-runtime-route-helper-test",
      filename: "setup-runtime-route-helper-test.cjs",
      body: `module.exports = { id: "setup-runtime-route-helper-test", register() {} };`,
    });

    const registry = loadSetupPlugins({
      paths: [built.pluginDir, helperPlugin.file],
      ids: ["setup-runtime-route-error-test", "setup-runtime-route-helper-test"],
    });

    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-route-error-test"),
    ).toMatchObject({
      status: "error",
      failurePhase: "register",
      error: expect.stringContaining("broken setup-runtime registrar"),
    });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "setup-runtime-route-error-test",
        code: "channel-setup-failure",
      }),
    );
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
      configured: false,
      useBundledSetupEntryContract: true,
      bundledSetupRuntimeRoutePath: "/setup-runtime-sync-route",
      bundledSetupRuntimeLateRoutePath: "/setup-runtime-late-route",
    });

    const registry = loadSetupPlugins({
      paths: [built.pluginDir],
      ids: ["setup-runtime-late-route-test"],
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
    const runtimeMarker = path.join(makePluginLoaderTempDir(), "setup-runtime-mismatch.txt");
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

    const registry = loadSetupPlugins({
      paths: [built.pluginDir],
      ids: ["setup-runtime-mismatch-test"],
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
    const runtimeMarker = path.join(makePluginLoaderTempDir(), "setup-runtime-mismatch.txt");
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

    const registry = loadSetupPlugins({
      paths: [built.pluginDir],
      ids: ["setup-export-mismatch-test"],
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
    const pluginDir = createSetupFailureFixture({
      id: "setup-entry-throws-test",
      setupEntrySource: THROWING_SETUP_ENTRY_SOURCE,
    });
    const registry = loadSetupPlugins({
      paths: [pluginDir],
      ids: ["setup-entry-throws-test"],
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
    const brokenDir = createSetupFailureFixture({
      id: "setup-entry-throws-sibling-test",
      channelId: "broken-chat",
      setupEntrySource: THROWING_SETUP_ENTRY_SOURCE,
    });

    const healthy = writePlugin({
      id: "healthy-channel",
      filename: "healthy-channel.cjs",
      body: channelPluginSource({
        pluginId: "healthy-channel",
        channelId: "healthy-chat",
        label: "Healthy Chat",
        docsPath: "/channels/healthy-chat",
        blurb: "healthy sibling channel",
      }),
    });

    const registry = loadSetupPlugins({
      paths: [brokenDir, healthy.file],
      ids: ["setup-entry-throws-sibling-test", "healthy-channel"],
      enabled: true,
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

  it("rolls back setup registrations and records a diagnostic when registerChannel throws", () => {
    useNoBundledPlugins();
    const brokenDir = createSetupFailureFixture({
      id: "register-channel-throws-test",
      setupEntrySource: `const configObj = {
    resolveAccount: () => ({ accountId: "default" }),
  };
  Object.defineProperty(configObj, "listAccountIds", {
    get() { throw new Error("boom: registerChannel exploded"); },
    enumerable: true,
    configurable: true,
  });
  module.exports = {
    kind: "bundled-channel-setup-entry",
    registerSetupRuntime(api) {
      api.registerHttpRoute({
        path: "/register-channel-throws-route",
        auth: "gateway",
        handler: async () => true,
      });
    },
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
    });

    const healthy = writePlugin({
      id: "healthy-after-register-throw",
      filename: "healthy-after-register-throw.cjs",
      body: channelPluginSource({
        pluginId: "healthy-after-register-throw",
        channelId: "healthy-after-register-throw-chat",
        label: "Healthy After Register Throw",
        docsPath: "/channels/healthy-after-register-throw",
        blurb: "survives sibling registerChannel throw",
      }),
    });

    const registry = loadSetupPlugins({
      paths: [brokenDir, healthy.file],
      ids: ["register-channel-throws-test", "healthy-after-register-throw"],
      enabled: true,
    });

    // The broken plugin should be recorded as a diagnostic, not crash the loop.
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "register-channel-throws-test",
      message: "failed to register setup channel",
    });
    expect(
      registry.httpRoutes.some((route) => route.path === "/register-channel-throws-route"),
    ).toBe(false);
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
    expect(
      loadBuiltArtifactScenario({
        id: "startup-artifact-test",
        origin: "bundled",
        sourceEntry: "index.ts",
        sourceBody: 'throw new Error("source TS should not load during gateway startup");\n',
        artifactLocation: "core",
        artifactEntry: "index.js",
        artifactBody: 'module.exports = { id: "startup-artifact-test", register() {} };\n',
      }),
    ).toBe("loaded");
  });

  it("prefers package-local dist artifacts for bundled source checkout plugins", () => {
    expect(
      loadBuiltArtifactScenario({
        id: "startup-package-artifact-test",
        origin: "bundled",
        sourceEntry: "index.ts",
        sourceBody: 'throw new Error("source TS should not load during gateway startup");\n',
        artifactLocation: "package",
        artifactEntry: "index.js",
        artifactBody: 'module.exports = { id: "startup-package-artifact-test", register() {} };\n',
        packageEntry: "./index.ts",
      }),
    ).toBe("loaded");
  });

  it("ignores package-local dist when a bundled source plugin opts out of core dist", () => {
    expect(
      loadSourceExternalArtifactScenario({
        sourceBody: 'export default { id: "source-external-artifact-test", register() {} };\n',
        packageLocalBody: 'throw new Error("stale package-local dist should not load");\n',
      }),
    ).toBe("loaded");
  });

  it("prefers the root build when a bundled source plugin opts out of core dist", () => {
    expect(
      loadSourceExternalArtifactScenario({
        sourceBody: 'throw new Error("source should not load when root build exists");\n',
        packageLocalBody: 'throw new Error("stale package-local dist should not load");\n',
        rootBuildBody: 'module.exports = { id: "source-external-artifact-test", register() {} };\n',
        runtimeOverlayBody:
          'throw new Error("staged runtime should canonicalize to the root build");\n',
      }),
    ).toBe("loaded");
  });

  it("prefers package-local dist artifacts over workspace source TS when requested", () => {
    useNoBundledPlugins();
    expect(
      loadBuiltArtifactScenario({
        id: "workspace-artifact-test",
        origin: "workspace",
        sourceEntry: "src/index.mts",
        sourceBody:
          'throw new Error("workspace source TS should not load during gateway startup");\n',
        artifactLocation: "package",
        artifactEntry: "index.mjs",
        artifactBody: 'export default { id: "workspace-artifact-test", register() {} };\n',
        packageBeforeManifest: true,
        packageEntry: "./src/index.mts",
      }),
    ).toBe("loaded");
  });

  it("probes supported package-local dist artifact extensions before source TS", () => {
    useNoBundledPlugins();
    expect(
      loadBuiltArtifactScenario({
        id: "workspace-artifact-extension-test",
        origin: "workspace",
        sourceEntry: "src/index.ts",
        sourceBody:
          'throw new Error("workspace source TS should not load during gateway startup");\n',
        artifactLocation: "package",
        artifactEntry: "index.mjs",
        artifactBody:
          'export default { id: "workspace-artifact-extension-test", register() {} };\n',
        packageBeforeManifest: true,
        packageEntry: "./src/index.ts",
      }),
    ).toBe("loaded");
  });

  it("does not replace explicit JavaScript entries with package-local dist artifacts", () => {
    useNoBundledPlugins();
    expect(
      loadBuiltArtifactScenario({
        id: "workspace-explicit-js-test",
        origin: "workspace",
        sourceEntry: "index.js",
        sourceBody: 'export default { id: "workspace-explicit-js-test", register() {} };\n',
        artifactLocation: "package",
        artifactEntry: "index.js",
        artifactBody: 'throw new Error("explicit JS entry should not be replaced by dist");\n',
        packageBeforeManifest: true,
        packageEntry: "./index.js",
      }),
    ).toBe("loaded");
  });

  it("keeps package-local dist artifacts inside the plugin root boundary", () => {
    useNoBundledPlugins();
    const pluginDir = makePluginLoaderTempDir();
    const outsideDistDir = makePluginLoaderTempDir();
    writeFixtureJson(pluginDir, "package.json", {
      openclaw: { extensions: ["./src/index.mts"] },
    });
    writeFixtureJson(
      pluginDir,
      "openclaw.plugin.json",
      pluginManifest("workspace-artifact-symlink-test"),
    );
    writeFixtureText(
      pluginDir,
      "src/index.mts",
      'throw new Error("workspace source TS should not load during gateway startup");\n',
    );
    writeFixtureText(
      outsideDistDir,
      "index.mjs",
      'export default { id: "workspace-artifact-symlink-test", register() {} };\n',
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

  it("blocks before_prompt_build but preserves model resolution overrides when prompt injection is disabled", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy",
      filename: "hook-policy.cjs",
      body: `module.exports = { id: "hook-policy", register(api) {
    api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
    api.on("before_model_resolve", () => ({
      modelOverride: "demo-model",
      providerOverride: "demo-provider",
    }));
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
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeModelResolve({ prompt: "hello" }, {});
    expect(result).toEqual({
      modelOverride: "demo-model",
      providerOverride: "demo-provider",
    });
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(1);
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
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy-default"],
        entries: {
          "hook-policy-default": {
            hooks: {
              allowConversationAccess: true,
            },
          },
        },
      },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_prompt_build"]);
  });

  it("applies configured typed hook timeout overrides", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-timeouts",
      filename: "hook-timeouts.cjs",
      body: `module.exports = { id: "hook-timeouts", register(api) {
    api.on("before_prompt_build", () => ({ prependContext: "prepend" }), { timeoutMs: 5000 });
    api.on("before_model_resolve", () => ({ providerOverride: "demo-provider" }));
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
    api.on("agent_turn_prepare", () => undefined);
    api.on("before_prompt_build", () => undefined);
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
    expect(blockedDiagnostics).toHaveLength(9);
  });

  it("allows conversation typed hooks for non-bundled plugins when explicitly enabled", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "conversation-hooks-allowed",
      filename: "conversation-hooks-allowed.cjs",
      body: `module.exports = { id: "conversation-hooks-allowed", register(api) {
    api.on("before_model_resolve", () => undefined);
    api.on("agent_turn_prepare", () => undefined);
    api.on("before_prompt_build", () => undefined);
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
      "agent_turn_prepare",
      "before_prompt_build",
      "before_agent_reply",
      "llm_input",
      "llm_output",
      "before_agent_finalize",
      "agent_end",
      "before_agent_run",
    ]);
  });

  it("stores only valid before_agent_reply trigger eligibility", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "reply-hook-trigger-eligibility",
      filename: "reply-hook-trigger-eligibility.cjs",
      body: `module.exports = { id: "reply-hook-trigger-eligibility", register(api) {
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: ["heartbeat", "cron", "heartbeat"] });
    api.on("before_agent_reply", () => undefined);
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: [] });
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: ["heartbeat", "unknown"] });
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: ["manual"] });
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: "heartbeat" });
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: Array(1) });
    api.on("before_agent_reply", () => undefined, { eligibleTriggers: [, "heartbeat"] });
    api.on("before_tool_call", () => undefined, { eligibleTriggers: ["heartbeat"] });
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["reply-hook-trigger-eligibility"],
        entries: {
          "reply-hook-trigger-eligibility": {
            hooks: { allowConversationAccess: true },
          },
        },
      },
    });

    expect(registry.typedHooks.map((entry) => entry.eligibleTriggers)).toEqual([
      ["heartbeat", "cron"],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
