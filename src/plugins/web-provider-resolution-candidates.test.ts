import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(),
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: (...args: unknown[]) => mocks.loadPluginRegistrySnapshot(...args),
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex({
      ...(args[0] && typeof args[0] === "object" ? args[0] : {}),
      index: mocks.loadPluginRegistrySnapshot(...args),
    }),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex(...args),
}));

let resolveManifestDeclaredWebProviderCandidatePluginIds: typeof import("./web-provider-resolution-shared.js").resolveManifestDeclaredWebProviderCandidatePluginIds;

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestDeclaredWebProviderCandidatePluginIds } =
      await import("./web-provider-resolution-shared.js"));
  });

  beforeEach(() => {
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "bundled",
          configSchema: {
            properties: {
              webSearch: {},
            },
          },
        },
        {
          id: "beta",
          origin: "bundled",
          contracts: {
            webSearchProviders: ["beta-search"],
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: [],
      }),
    ).toEqual([]);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("keeps scoped plugins with no declared web candidates scoped-empty", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: ["missing-plugin"],
      }),
    ).toEqual([]);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["missing-plugin"],
      }),
    );
  });

  it("keeps origin filters with no declared web candidates scoped-empty", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-tool",
          origin: "workspace",
          configSchema: {
            properties: {},
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        origin: "bundled",
      }),
    ).toEqual([]);
  });

  it("derives provider candidates from a single manifest-registry read", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
      }),
    ).toEqual(["alpha", "beta"]);
    expect(mocks.loadPluginRegistrySnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(1);
  });
});
