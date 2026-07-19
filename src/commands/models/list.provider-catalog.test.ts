import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOwner: vi.fn(),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogOwnerSnapshot: mocks.loadOwner,
}));

import {
  hasProviderRuntimeCatalogForFilter,
  hasProviderStaticCatalogForFilter,
  loadProviderCatalogModelsForList,
} from "./list.provider-catalog.js";

const emptyMetadataSnapshot = { manifestRegistry: { plugins: [] } } as never;

function ownerSnapshot(modelCatalog: unknown, metadataSnapshot = emptyMetadataSnapshot) {
  return {
    agentDir: "/tmp/agent",
    metadataSnapshot,
    modelCatalog,
  };
}

describe("lifecycle-owned model-list provider catalog", () => {
  beforeEach(() => {
    mocks.loadOwner.mockReset();
  });

  it("projects a provider from the lifecycle owner", async () => {
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [
          { provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" },
          { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
          { provider: "ollama", id: "local-model", name: "Local Model" },
        ],
        staticEntries: [{ provider: "moonshot", id: "kimi-static", name: "Kimi Static" }],
        routeVariants: [],
      }),
    );

    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "moonshot",
      }),
    ).resolves.toEqual([{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }]);
    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).resolves.not.toContainEqual(expect.objectContaining({ provider: "ollama" }));
  });

  it("keeps static provider-hook rows separate from the full runtime catalog", async () => {
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [{ provider: "moonshot", id: "kimi-runtime", name: "Kimi Runtime" }],
        staticEntries: [{ provider: "nvidia", id: "nemotron-static", name: "Nemotron Static" }],
        routeVariants: [],
      }),
    );

    await expect(
      hasProviderRuntimeCatalogForFilter({
        cfg: {},
        agentId: "worker",
        agentDir: "/tmp/agent",
        providerFilter: "nvidia",
      }),
    ).resolves.toBe(false);
    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "nvidia",
      }),
    ).resolves.toBe(true);
    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe(true);
    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
        staticOnly: true,
      }),
    ).resolves.toEqual([{ provider: "nvidia", id: "nemotron-static", name: "Nemotron Static" }]);
    expect(mocks.loadOwner).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  it("activates one prepared owner when no generation is published", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/model-list-state" };
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }],
        routeVariants: [],
      }),
    );

    await expect(
      hasProviderRuntimeCatalogForFilter({
        cfg: {},
        agentId: "worker",
        agentDir: "/tmp/agent",
        env,
        providerFilter: "moonshot",
      }),
    ).resolves.toBe(true);
    expect(mocks.loadOwner).toHaveBeenCalledWith({
      config: {},
      agentId: "worker",
      agentDir: "/tmp/agent",
      env,
    });
  });

  it("derives the matching directory for an explicit agent", async () => {
    const cfg = {
      agents: {
        list: [{ id: "worker", agentDir: "/tmp/model-list-worker-agent" }],
      },
    };
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [],
        staticEntries: [{ provider: "nvidia", id: "worker-model", name: "Worker Model" }],
        routeVariants: [],
      }),
    );

    await expect(
      hasProviderStaticCatalogForFilter({
        cfg,
        agentId: "worker",
        providerFilter: "nvidia",
      }),
    ).resolves.toBe(true);
    expect(mocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        agentDir: "/tmp/model-list-worker-agent",
      }),
    );
  });

  it("matches provider aliases from the captured metadata generation", async () => {
    const metadataSnapshot = {
      manifestRegistry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: {
              aliases: { kimi: { provider: "moonshot" } },
            },
          },
        ],
      },
    } as never;
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot(
        {
          entries: [{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }],
          staticEntries: [{ provider: "moonshot", id: "kimi-static", name: "Kimi Static" }],
          routeVariants: [],
        },
        metadataSnapshot,
      ),
    );

    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "kimi",
      }),
    ).resolves.toEqual([{ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }]);
  });
});
