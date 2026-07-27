import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadCatalog: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  getPreparedModelCatalogSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
  loadPreparedModelCatalog: (...args: unknown[]) => mocks.loadCatalog(...args),
}));

import { loadModelCatalog } from "./agent-runtime.js";

describe("agent-runtime model catalog compatibility", () => {
  beforeEach(() => {
    mocks.getSnapshot.mockReset();
    mocks.loadCatalog.mockReset();
  });

  it("keeps legacy cache-only reads nonblocking", async () => {
    mocks.getSnapshot.mockReturnValue({
      entries: [{ provider: "test", id: "cached", name: "Cached" }],
      routeVariants: [],
    });

    await expect(loadModelCatalog({ cacheOnly: true, useCache: true })).resolves.toEqual([
      { provider: "test", id: "cached", name: "Cached" },
    ]);
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

  it("accepts legacy options without overriding lifecycle metadata", async () => {
    mocks.loadCatalog.mockResolvedValue([]);
    const config = {};
    const env = { OPENCLAW_STATE_DIR: "/tmp/plugin-state" };

    await loadModelCatalog({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      metadataSnapshot: {} as never,
      readOnly: true,
      useCache: false,
      workspaceDir: "/tmp/plugin-workspace",
    });

    expect(mocks.loadCatalog).toHaveBeenCalledWith({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      readOnly: true,
      workspaceDir: "/tmp/plugin-workspace",
    });
  });
});
