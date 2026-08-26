import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
  };
  const manifest = {
    id: params.pluginId,
    name: params.pluginId,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    rootDir,
    source: `${rootDir}/index.js`,
    origin,
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

    const catalog = await listManagedPlugins({ config: {}, env: {} });
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

  it("checks external dependency health once per immutable metadata lifecycle", async () => {
    mocks.metadata.mockImplementation(() =>
      dependencyMetadataSnapshot({
        pluginId: "lifecycle-missing-runtime",
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

    await listManagedPlugins({ config: {}, env: {} });
    expect(dependencyProbeCount()).toBe(initialProbes);

    clearPluginMetadataLifecycleCaches();
    await listManagedPlugins({ config: {}, env: {} });
    expect(dependencyProbeCount()).toBeGreaterThan(initialProbes);
    existsSync.mockRestore();
  });
});
