import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
  resolveManifestContractPluginIds: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mocks.loadPluginManifestRegistry(...args),
  resolveManifestContractPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestContractPluginIds(...args),
}));

let resolveManifestDeclaredWebProviderCandidatePluginIds: typeof import("./web-provider-resolution-shared.js").resolveManifestDeclaredWebProviderCandidatePluginIds;

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestDeclaredWebProviderCandidatePluginIds } =
      await import("./web-provider-resolution-shared.js"));
  });

  beforeEach(() => {
    mocks.resolveManifestContractPluginIds.mockReset();
    mocks.resolveManifestContractPluginIds.mockReturnValue(["alpha"]);
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue({
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
  });

  it("keeps runtime fallback for scoped plugins with no declared web candidates", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: ["missing-plugin"],
      }),
    ).toBeUndefined();
  });
});
