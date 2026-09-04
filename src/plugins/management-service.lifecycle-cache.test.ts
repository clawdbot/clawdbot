import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as bundledDiscoveryState from "./bundled-discovery-state.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
} from "./plugin-metadata-lifecycle.js";

const mocks = vi.hoisted(() => ({
  currentMetadata: undefined as unknown,
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => {
    if (mocks.currentMetadata !== undefined) {
      return mocks.currentMetadata;
    }
    const metadata = mocks.metadata(...args);
    mocks.currentMetadata = metadata;
    return metadata;
  },
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { listManagedPlugins } = await import("./management-service.js");

registerPluginMetadataProcessMemoLifecycleClear(() => {
  mocks.currentMetadata = undefined;
});

function metadataSnapshot(pluginId?: string) {
  return {
    index: {
      plugins: pluginId
        ? [{ pluginId, packageName: `community/${pluginId}`, origin: "global", enabled: true }]
        : [],
      installRecords: {},
    },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (rawPluginId: string) => rawPluginId,
  };
}

function dependencyMetadataSnapshot(params: {
  pluginId: string;
  enabled?: boolean;
  origin?: "global" | "bundled";
  enabledByDefault?: boolean;
  providers?: string[];
  channels?: string[];
  packageBuild?: { bundledDist?: boolean };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  existingError?: string;
}) {
  const snapshot = metadataSnapshot(params.pluginId);
  const origin = params.origin ?? "global";
  const rootDir = `/__openclaw_plugin_dependency_health__/${params.pluginId}`;
  const record = {
    ...snapshot.index.plugins[0]!,
    enabled: params.enabled ?? true,
    origin,
    rootDir,
    ...(params.enabledByDefault ? { enabledByDefault: true } : {}),
    contributions: { providers: params.providers, channels: params.channels },
    ...(params.packageBuild ? { packageBuild: params.packageBuild } : {}),
  };
  const manifest = {
    id: params.pluginId,
    name: params.pluginId,
    channels: params.channels ?? [],
    providers: params.providers ?? [],
    cliBackends: [],
    skills: [],
    rootDir,
    source: `${rootDir}/index.js`,
    origin,
    ...(params.enabledByDefault ? { enabledByDefault: true } : {}),
    packageDependencies: params.dependencies ?? {},
    packageOptionalDependencies: params.optionalDependencies ?? {},
  };
  return {
    ...snapshot,
    index: { ...snapshot.index, plugins: [record] },
    byPluginId: new Map([[params.pluginId, manifest]]),
    plugins: [manifest],
    diagnostics: params.existingError
      ? [
          {
            level: "error" as const,
            pluginId: params.pluginId,
            message: params.existingError,
          },
        ]
      : [],
  };
}

describe("plugin management catalog lifecycle", () => {
  beforeEach(() => {
    mocks.metadata.mockReset();
    mocks.officialCatalog.mockReset();
    clearPluginMetadataLifecycleCaches();
  });

  it("serves the first plugins.list load from prewarmed metadata and official catalog caches", async () => {
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot())
      .mockReturnValueOnce(metadataSnapshot("fresh-plugin"));
    mocks.officialCatalog
      .mockResolvedValueOnce({
        source: "hosted",
        entries: [
          {
            id: "@openclaw/diffs",
            title: "Diffs",
            state: "available",
            featured: true,
            publisher: { id: "openclaw", trust: "official" },
            install: {
              candidates: [
                {
                  sourceRef: "public-clawhub",
                  package: "@openclaw/diffs",
                  version: "2026.6.11",
                  integrity: `sha256:${"a".repeat(64)}`,
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ source: "hosted", entries: [] });

    const prewarmed = await listManagedPlugins({ config: {}, env: {} });
    const firstHandlerLoad = await listManagedPlugins({ config: {}, env: {} });

    expect(prewarmed.plugins).toEqual([expect.objectContaining({ id: "diffs" })]);
    expect(firstHandlerLoad.plugins).toEqual(prewarmed.plugins);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();

    const refreshed = await listManagedPlugins({ config: {}, env: {} });

    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(2);
    expect(refreshed.plugins).toEqual([
      expect.objectContaining({ id: "fresh-plugin", installed: true, enabled: true }),
    ]);
  });

  it("retries a failed official catalog prewarm and keeps the recovered catalog process-stable", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot());
    mocks.officialCatalog
      .mockRejectedValueOnce(new Error("transient catalog bootstrap"))
      .mockResolvedValueOnce({ source: "hosted", entries: [] });

    await expect(listManagedPlugins({ config: {}, env: {} })).rejects.toThrow(
      "transient catalog bootstrap",
    );
    await expect(listManagedPlugins({ config: {}, env: {} })).resolves.toMatchObject({
      plugins: [],
    });
    await expect(listManagedPlugins({ config: {}, env: {} })).resolves.toMatchObject({
      plugins: [],
    });
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(2);
  });

  it("uses current config after awaiting the hosted catalog", async () => {
    const config = { plugins: { entries: { "phase-plugin": { enabled: true } } } };
    const hosted = createDeferred<{ source: "hosted"; entries: never[] }>();
    mocks.metadata.mockReturnValue(dependencyMetadataSnapshot({ pluginId: "phase-plugin" }));
    mocks.officialCatalog.mockReturnValue(hosted.promise);

    const pending = listManagedPlugins({ config, env: {} });
    config.plugins.entries["phase-plugin"].enabled = false;
    hosted.resolve({ source: "hosted", entries: [] });
    const catalog = await pending;

    expect(catalog.plugins[0]).toMatchObject({
      id: "phase-plugin",
      enabled: false,
      state: "disabled",
    });
    expect(catalog.diagnostics).toEqual([]);
  });

  it.each<{
    mode: "compat" | "allowlist";
    denyProvider: boolean;
    providerEnabled: boolean;
    selectedMode?: "compat" | "allowlist";
    channelEnabled?: false;
    dependencyError?: true;
  }>([
    { mode: "compat", denyProvider: false, providerEnabled: true },
    { mode: "allowlist", denyProvider: false, providerEnabled: false },
    { mode: "compat", denyProvider: true, providerEnabled: false },
    {
      mode: "compat",
      selectedMode: "allowlist",
      denyProvider: false,
      providerEnabled: false,
      dependencyError: true,
    },
    { mode: "compat", denyProvider: false, providerEnabled: false, channelEnabled: false },
  ])(
    "keeps provider policy in $mode/$selectedMode mode with deny=$denyProvider and channel=$channelEnabled",
    async ({
      mode,
      denyProvider,
      providerEnabled,
      selectedMode,
      channelEnabled,
      dependencyError,
    }) => {
      const env = { OPENCLAW_STATE_DIR: "/__openclaw_management_selected_root__" };
      const readMode = vi
        .spyOn(bundledDiscoveryState, "readBundledDiscoveryModeMemoized")
        .mockImplementation((selectedEnv) =>
          selectedEnv?.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR
            ? (selectedMode ?? mode)
            : mode,
        );
      try {
        const provider = dependencyMetadataSnapshot({
          pluginId: "bundled-provider",
          origin: "bundled",
          enabledByDefault: true,
          providers: ["fixture-provider"],
          channels: ["fixture-chat"],
          ...(dependencyError
            ? { packageBuild: { bundledDist: false }, dependencies: { "missing-runtime": "1.0.0" } }
            : {}),
        });
        const ordinary = dependencyMetadataSnapshot({
          pluginId: "bundled-ordinary",
          origin: "bundled",
          enabledByDefault: true,
        });
        mocks.metadata.mockReturnValue({
          ...provider,
          index: {
            ...provider.index,
            plugins: [...provider.index.plugins, ...ordinary.index.plugins],
          },
          byPluginId: new Map([...provider.byPluginId, ...ordinary.byPluginId]),
          plugins: [...provider.plugins, ...ordinary.plugins],
        });
        mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });

        const catalog = await listManagedPlugins({
          config: {
            plugins: {
              allow: ["listed"],
              ...(denyProvider ? { deny: ["bundled-provider"] } : {}),
              ...(channelEnabled === false
                ? { entries: { "bundled-provider": { enabled: true } } }
                : {}),
            },
            ...(channelEnabled === false
              ? { channels: { "fixture-chat": { enabled: false } } }
              : {}),
          },
          env,
        });

        expect(catalog.plugins.find((plugin) => plugin.id === "bundled-provider")).toMatchObject({
          enabled: providerEnabled,
          state: dependencyError ? "error" : providerEnabled ? "enabled" : "disabled",
          ...(dependencyError ? { error: expect.stringContaining("missing-runtime") } : {}),
        });
        expect(catalog.plugins.find((plugin) => plugin.id === "bundled-ordinary")).toMatchObject({
          enabled: false,
          state: "disabled",
        });
        expect(catalog.diagnostics).toEqual(
          dependencyError
            ? [
                expect.objectContaining({
                  level: "error",
                  pluginId: "bundled-provider",
                  message: expect.stringContaining("missing-runtime"),
                }),
              ]
            : [],
        );
      } finally {
        readMode.mockRestore();
      }
    },
  );

  it("keeps a refreshed catalog when an older lifecycle generation rejects later", async () => {
    const retiredCatalog = createDeferred<{ source: "hosted"; entries: never[] }>();
    mocks.metadata.mockReturnValue(metadataSnapshot());
    mocks.officialCatalog
      .mockReturnValueOnce(retiredCatalog.promise)
      .mockResolvedValueOnce({ source: "hosted", entries: [] });

    const retiredLoad = listManagedPlugins({ config: {}, env: {} });
    const retiredFailure = expect(retiredLoad).rejects.toThrow("retired catalog bootstrap");
    await Promise.resolve();
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();

    await expect(listManagedPlugins({ config: {}, env: {} })).resolves.toMatchObject({
      plugins: [],
    });
    retiredCatalog.reject(new Error("retired catalog bootstrap"));
    await retiredFailure;

    await expect(listManagedPlugins({ config: {}, env: {} })).resolves.toMatchObject({
      plugins: [],
    });
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps a successfully resolved bundled-fallback catalog process-stable", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot());
    mocks.officialCatalog.mockResolvedValueOnce({
      source: "bundled-fallback",
      entries: [],
      error: "hosted feed unavailable",
    });

    const first = await listManagedPlugins({ config: {}, env: {} });
    const second = await listManagedPlugins({ config: {}, env: {} });

    expect(first.diagnostics).toContainEqual({
      level: "warn",
      message: "Official plugin catalog fallback: hosted feed unavailable",
    });
    expect(second).toEqual(first);
    expect(mocks.officialCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "enabled external plugin missing a required dependency",
      pluginId: "missing-required",
      dependencies: { "missing-runtime": "1.0.0" },
      expectedState: "error",
      expectedDiagnostic: true,
    },
    {
      label: "enabled external plugin missing only an optional dependency",
      pluginId: "missing-optional",
      optionalDependencies: { "missing-runtime": "1.0.0" },
      expectedState: "enabled",
      expectedDiagnostic: false,
    },
    {
      label: "disabled external plugin missing a required dependency",
      pluginId: "disabled-missing-required",
      enabled: false,
      dependencies: { "missing-runtime": "1.0.0" },
      expectedState: "disabled",
      expectedDiagnostic: false,
    },
    {
      label: "bundled plugin missing a package-local dependency",
      pluginId: "bundled-missing-required",
      origin: "bundled" as const,
      dependencies: { "missing-runtime": "1.0.0" },
      expectedState: "enabled",
      expectedDiagnostic: false,
    },
    {
      label: "existing plugin failure with a missing required dependency",
      pluginId: "existing-missing-required",
      dependencies: { "missing-runtime": "1.0.0" },
      existingError: "existing manifest failure",
      expectedState: "error",
      expectedDiagnostic: true,
    },
  ])("projects dependency health for $label", async (scenario) => {
    mocks.metadata.mockReturnValue(dependencyMetadataSnapshot(scenario));
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });

    const catalog = await listManagedPlugins({
      config: {
        plugins: { entries: { [scenario.pluginId]: { enabled: scenario.enabled ?? true } } },
      },
      env: {},
    });
    const plugin = catalog.plugins.find((entry) => entry.id === scenario.pluginId);

    expect(plugin?.state).toBe(scenario.expectedState);
    const diagnostics = catalog.diagnostics.filter(
      (diagnostic) =>
        typeof diagnostic === "object" &&
        diagnostic !== null &&
        "pluginId" in diagnostic &&
        diagnostic.pluginId === scenario.pluginId,
    );
    if (scenario.expectedDiagnostic) {
      expect(plugin?.error).toContain("missing-runtime");
      expect(plugin?.error).toContain("reinstall/update the plugin");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toEqual(
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("missing-runtime"),
        }),
      );
      if (scenario.existingError) {
        expect(plugin?.error).toContain(scenario.existingError);
        expect(diagnostics[0]).toEqual(
          expect.objectContaining({
            message: expect.stringContaining(scenario.existingError),
          }),
        );
      }
    } else {
      expect(plugin?.error).toBeUndefined();
      expect(diagnostics).toEqual([]);
    }
  });

  it.each([
    { label: "external", origin: "global" as const, packageBuild: undefined },
    {
      label: "source-external bundled",
      origin: "bundled" as const,
      packageBuild: { bundledDist: false },
    },
  ])(
    "checks $label dependency health once per immutable metadata lifecycle",
    async ({ origin, packageBuild }) => {
      mocks.metadata.mockImplementation(() =>
        dependencyMetadataSnapshot({
          pluginId: "lifecycle-missing-runtime",
          origin,
          packageBuild,
          enabledByDefault: true,
          dependencies: { "missing-runtime": "1.0.0" },
        }),
      );
      mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
      const existsSync = vi.spyOn(fs, "existsSync");
      const dependencyProbeCount = () =>
        existsSync.mock.calls.filter(([candidate]) =>
          String(candidate).includes("node_modules/missing-runtime"),
        ).length;

      const first = await listManagedPlugins({ config: {}, env: {} });
      expect(first.plugins[0]?.state).toBe("error");
      const initialProbes = dependencyProbeCount();
      expect(initialProbes).toBeGreaterThan(0);

      const disabled = await listManagedPlugins({
        config: { plugins: { entries: { "lifecycle-missing-runtime": { enabled: false } } } },
        env: {},
      });
      expect(disabled.plugins[0]).toMatchObject({ enabled: false, state: "disabled" });
      expect(disabled.diagnostics).toEqual([]);
      expect(dependencyProbeCount()).toBe(initialProbes);

      const enabled = await listManagedPlugins({
        config: { plugins: { entries: { "lifecycle-missing-runtime": { enabled: true } } } },
        env: {},
      });
      expect(enabled.plugins[0]).toMatchObject({ enabled: true, state: "error" });
      expect(enabled.diagnostics).toHaveLength(1);
      expect(dependencyProbeCount()).toBe(initialProbes);

      await listManagedPlugins({ config: {}, env: {} });
      expect(dependencyProbeCount()).toBe(initialProbes);

      clearPluginMetadataLifecycleCaches();
      await listManagedPlugins({ config: {}, env: {} });
      expect(dependencyProbeCount()).toBeGreaterThan(initialProbes);
      existsSync.mockRestore();
    },
  );
});
