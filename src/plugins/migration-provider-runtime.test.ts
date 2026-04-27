import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

type MockPluginIndex = {
  plugins: Array<{
    pluginId: string;
    origin: string;
    enabled: boolean;
    enabledByDefault?: boolean;
  }>;
  diagnostics: unknown[];
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

function createMockPluginIndex(plugins: MockPluginIndex["plugins"]): MockPluginIndex {
  return { plugins, diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<(params?: unknown) => PluginRegistry | undefined>(
    () => undefined,
  ),
  loadPluginManifestRegistry: vi.fn<(params?: Record<string, unknown>) => MockManifestRegistry>(
    () => createEmptyMockManifestRegistry(),
  ),
  loadPluginRegistrySnapshot: vi.fn<() => MockPluginIndex>(() => createMockPluginIndex([])),
  withBundledPluginAllowlistCompat: vi.fn(
    ({ config }: { config?: OpenClawConfig; pluginIds: string[] }) => config,
  ),
  withBundledPluginEnablementCompat: vi.fn(
    ({ config }: { config?: OpenClawConfig; pluginIds: string[] }) => config,
  ),
  withBundledPluginVitestCompat: vi.fn(
    ({ config }: { config?: OpenClawConfig; pluginIds: string[] }) => config,
  ),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistry,
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: mocks.withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
}));

let resolvePluginMigrationProvider: typeof import("./migration-provider-runtime.js").resolvePluginMigrationProvider;
let resolvePluginMigrationProviders: typeof import("./migration-provider-runtime.js").resolvePluginMigrationProviders;

function createMigrationProvider(id: string) {
  return {
    id,
    label: id,
    plan: vi.fn(),
    apply: vi.fn(),
  };
}

describe("migration provider runtime", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.loadPluginRegistrySnapshot.mockReturnValue(createMockPluginIndex([]));
    const runtime = await import("./migration-provider-runtime.js");
    resolvePluginMigrationProvider = runtime.resolvePluginMigrationProvider;
    resolvePluginMigrationProviders = runtime.resolvePluginMigrationProviders;
  });

  it("loads configured external migration-provider plugins from manifest contracts", () => {
    const cfg = {
      plugins: { entries: { "external-migration": { enabled: true } } },
    } as OpenClawConfig;
    const provider = createMigrationProvider("external-import");
    const active = createEmptyPluginRegistry();
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "external-migration",
      pluginName: "External Migration",
      source: "test",
      provider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "external-migration",
          origin: "installed",
          enabled: true,
        },
        {
          pluginId: "disabled-external-migration",
          origin: "installed",
          enabled: false,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => ({
      diagnostics: [],
      plugins: params?.includeDisabled
        ? [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
            {
              id: "disabled-external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ]
        : [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ],
    }));

    const resolved = resolvePluginMigrationProvider({ providerId: "external-import", cfg });

    expect(resolved).toBe(provider);
    expect(mocks.loadPluginRegistrySnapshot).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
      preferPersisted: false,
    });
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      index: expect.objectContaining({
        plugins: expect.arrayContaining([
          expect.objectContaining({ pluginId: "external-migration" }),
        ]),
      }),
      config: cfg,
      env: process.env,
      includeDisabled: true,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: cfg,
      onlyPluginIds: ["external-migration"],
      activate: false,
    });
  });

  it("derives a fresh manifest registry so newly bundled migration providers are discoverable", () => {
    const provider = createMigrationProvider("hermes");
    const active = createEmptyPluginRegistry();
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "migrate-hermes",
      pluginName: "Hermes Migration",
      source: "test",
      provider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "migrate-hermes",
          origin: "bundled",
          enabled: true,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation(() => ({
      diagnostics: [],
      plugins: [
        {
          id: "migrate-hermes",
          origin: "bundled",
          contracts: { migrationProviders: ["hermes"] },
        },
      ],
    }));

    const resolved = resolvePluginMigrationProvider({ providerId: "hermes" });

    expect(resolved).toBe(provider);
    expect(mocks.loadPluginRegistrySnapshot).toHaveBeenCalledWith({
      config: undefined,
      env: process.env,
      preferPersisted: false,
    });
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      index: expect.objectContaining({
        plugins: [expect.objectContaining({ pluginId: "migrate-hermes" })],
      }),
      config: undefined,
      env: process.env,
      includeDisabled: true,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["migrate-hermes"],
      activate: false,
    });
  });

  it("lists configured external migration providers alongside active providers", () => {
    const activeProvider = createMigrationProvider("active-import");
    const externalProvider = createMigrationProvider("external-import");
    const active = createEmptyPluginRegistry();
    active.migrationProviders.push({
      pluginId: "active-migration",
      pluginName: "Active Migration",
      source: "test",
      provider: activeProvider,
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "external-migration",
      pluginName: "External Migration",
      source: "test",
      provider: externalProvider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "external-migration",
          origin: "installed",
          enabled: true,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => ({
      diagnostics: [],
      plugins: params?.includeDisabled
        ? [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ]
        : [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ],
    }));

    expect(resolvePluginMigrationProviders().map((provider) => provider.id)).toEqual([
      "active-import",
      "external-import",
    ]);
  });
});
