import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPreparedModelCatalogOwnerSnapshot: vi.fn(),
  loadPreparedModelCatalogSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: mocks.loadPreparedModelCatalogOwnerSnapshot,
  loadPreparedModelCatalogSnapshot: mocks.loadPreparedModelCatalogSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

import { loadPreferredProviderPickerCatalog } from "./model-picker.provider-catalog.js";

describe("loadPreferredProviderPickerCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPreparedModelCatalogOwnerSnapshot.mockImplementation(() => {
      throw new Error("preferred-provider browsing must not load the full catalog owner");
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      manifestRegistry: { plugins: [] },
    });
  });

  it("loads only the canonical preferred provider through scoped live discovery", async () => {
    mocks.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [
        { provider: "nvidia", id: "nvidia/nemotron", name: "Nemotron" },
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      ],
      routeVariants: [
        {
          provider: "nvidia",
          id: "nvidia/nemotron",
          name: "Nemotron API route",
          api: "openai-completions",
        },
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      ],
      staticEntries: [
        { provider: "nvidia", id: "nvidia/nemotron", name: "Static Nemotron" },
        { provider: "openai", id: "gpt-5.4", name: "Static GPT-5.4" },
      ],
    });

    await expect(
      loadPreferredProviderPickerCatalog({
        cfg: {},
        preferredProvider: "NVIDIA",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        env: { NVIDIA_API_KEY: "test-nvidia-api-key" },
      }),
    ).resolves.toEqual({
      entries: [{ provider: "nvidia", id: "nvidia/nemotron", name: "Nemotron" }],
      routeVariants: [
        {
          provider: "nvidia",
          id: "nvidia/nemotron",
          name: "Nemotron API route",
          api: "openai-completions",
        },
      ],
      staticEntries: [{ provider: "nvidia", id: "nvidia/nemotron", name: "Static Nemotron" }],
    });
    expect(mocks.loadPreparedModelCatalogSnapshot).toHaveBeenCalledWith({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env: { NVIDIA_API_KEY: "test-nvidia-api-key" },
      readOnly: true,
      providerDiscoveryProviderIds: ["nvidia"],
      scopedLiveProviderDiscovery: true,
    });
    expect(mocks.loadPreparedModelCatalogOwnerSnapshot).not.toHaveBeenCalled();
  });

  it("canonicalizes provider aliases before scoped discovery", async () => {
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      manifestRegistry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: { aliases: { kimi: { provider: "moonshot" } } },
          },
        ],
      },
    });
    mocks.loadPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }],
      routeVariants: [],
    });

    await expect(
      loadPreferredProviderPickerCatalog({
        cfg: {},
        preferredProvider: "kimi",
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      entries: [{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }],
      routeVariants: [],
    });
    expect(mocks.loadPreparedModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        providerDiscoveryProviderIds: ["moonshot"],
        scopedLiveProviderDiscovery: true,
      }),
    );
  });
});
