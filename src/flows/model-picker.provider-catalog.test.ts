import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadPreparedModelCatalogOwnerSnapshot: vi.fn() }));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogOwnerSnapshot: mocks.loadPreparedModelCatalogOwnerSnapshot,
}));

import { loadPreferredProviderPickerCatalog } from "./model-picker.provider-catalog.js";

describe("loadPreferredProviderPickerCatalog", () => {
  beforeEach(() => {
    mocks.loadPreparedModelCatalogOwnerSnapshot.mockReset();
  });

  it("filters one committed generation by preferred provider", async () => {
    mocks.loadPreparedModelCatalogOwnerSnapshot.mockResolvedValue({
      metadataSnapshot: { manifestRegistry: { plugins: [] } },
      modelCatalog: {
        entries: [
          { provider: "nvidia", id: "nvidia/nemotron", name: "Nemotron" },
          { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
        ],
      },
    });

    await expect(
      loadPreferredProviderPickerCatalog({
        cfg: {},
        preferredProvider: "NVIDIA",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        env: { NVIDIA_API_KEY: "test-nvidia-api-key" },
      }),
    ).resolves.toEqual([{ provider: "nvidia", id: "nvidia/nemotron", name: "Nemotron" }]);
    expect(mocks.loadPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env: { NVIDIA_API_KEY: "test-nvidia-api-key" },
    });
  });

  it("matches preferred provider aliases from the prepared metadata generation", async () => {
    mocks.loadPreparedModelCatalogOwnerSnapshot.mockResolvedValue({
      metadataSnapshot: {
        manifestRegistry: {
          plugins: [
            {
              id: "moonshot",
              modelCatalog: { aliases: { kimi: { provider: "moonshot" } } },
            },
          ],
        },
      },
      modelCatalog: {
        entries: [{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    });

    await expect(
      loadPreferredProviderPickerCatalog({
        cfg: {},
        preferredProvider: "kimi",
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual([{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }]);
  });
});
