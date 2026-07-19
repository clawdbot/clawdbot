import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {} as object,
  activateSnapshot: vi.fn(),
  acquireSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  prepareSnapshot: vi.fn(),
  releaseSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentDir: () => "/tmp/prepared-model-catalog-agent",
  resolveAgentWorkspaceDir: () => "/tmp/prepared-model-catalog-workspace",
  resolveDefaultAgentDir: () => "/tmp/prepared-model-catalog-agent",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("./prepared-model-runtime.js", () => {
  class PreparedModelRuntimeOwnerNotPublishedError extends Error {}
  return {
    PreparedModelRuntimeOwnerNotPublishedError,
    acquireAgentRunPreparedModelRuntime: async (input: Record<string, unknown>) => ({
      snapshot: await mocks.acquireSnapshot(input),
      release: mocks.releaseSnapshot,
    }),
    activateStandalonePreparedModelRuntime: (...args: unknown[]) => mocks.activateSnapshot(...args),
    acquireReadOnlyPreparedModelRuntime: async (input: Record<string, unknown>) => ({
      snapshot: await mocks.loadSnapshot({ ...input, readOnly: true }),
      release: mocks.releaseSnapshot,
    }),
    getPreparedModelRuntimeSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
    loadPreparedModelRuntimeSnapshot: (...args: unknown[]) => mocks.loadSnapshot(...args),
    preparedModelRuntimeConfigsMatch: (left: object, right: object) =>
      JSON.stringify(left) === JSON.stringify(right),
    prepareModelRuntimeSnapshot: (...args: unknown[]) => mocks.prepareSnapshot(...args),
  };
});

import {
  getPreparedModelCatalogSnapshot,
  loadPreparedModelCatalogSnapshot,
} from "./prepared-model-catalog.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.js";

const fullSnapshot = {
  config: mocks.config,
  modelCatalog: { entries: [{ provider: "test", id: "full", name: "Full" }], routeVariants: [] },
};
const readOnlySnapshot = {
  config: mocks.config,
  modelCatalog: {
    entries: [{ provider: "test", id: "read-only", name: "Read only" }],
    routeVariants: [],
  },
};

describe("prepared model catalog access", () => {
  beforeEach(() => {
    mocks.activateSnapshot.mockReset();
    mocks.acquireSnapshot.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.loadSnapshot.mockReset();
    mocks.prepareSnapshot.mockReset();
    mocks.releaseSnapshot.mockReset();
  });

  it("does not return a full nonblocking generation from another config", () => {
    mocks.getSnapshot
      .mockReturnValueOnce({ ...fullSnapshot, config: { logging: { level: "debug" } } })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(readOnlySnapshot);

    expect(getPreparedModelCatalogSnapshot({ readOnly: true })).toBe(readOnlySnapshot.modelCatalog);
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.getSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: mocks.config, readOnly: true }),
    );
  });

  it("prefers the full lifecycle generation for read-only catalog loads", async () => {
    mocks.prepareSnapshot.mockResolvedValue(fullSnapshot);

    await expect(loadPreparedModelCatalogSnapshot({ readOnly: true })).resolves.toBe(
      fullSnapshot.modelCatalog,
    );
    expect(mocks.prepareSnapshot).toHaveBeenCalledOnce();
    expect(mocks.prepareSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
    expect(mocks.releaseSnapshot).not.toHaveBeenCalled();
  });

  it("carries an explicit dynamic workspace into the read-only loader", async () => {
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadPreparedModelCatalogSnapshot({
        workspaceDir: "/tmp/dynamic-workspace",
        readOnly: true,
      }),
    ).resolves.toBe(readOnlySnapshot.modelCatalog);

    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, workspaceDir: "/tmp/dynamic-workspace" }),
    );
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it("rejects a full generation replaced with another config", async () => {
    const committedConfig = { agents: { defaults: { model: "openai/committed" } } };
    const committedSnapshot = { ...fullSnapshot, config: committedConfig };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(loadPreparedModelCatalogSnapshot({ readOnly: true })).rejects.toThrow(
      "config was replaced",
    );
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
  });

  it("prefers the full published generation for read-only access", () => {
    mocks.getSnapshot.mockReturnValue(fullSnapshot);

    expect(getPreparedModelCatalogSnapshot({ readOnly: true })).toBe(fullSnapshot.modelCatalog);
    expect(mocks.getSnapshot).toHaveBeenCalledOnce();
    expect(mocks.getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/prepared-model-catalog-agent",
        config: mocks.config,
      }),
    );
    expect(mocks.getSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("workspaceDir");
    expect(mocks.getSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
  });

  it("activates a persistent full owner for a standalone catalog read", async () => {
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.activateSnapshot.mockResolvedValue(fullSnapshot);

    await expect(loadPreparedModelCatalogSnapshot()).resolves.toBe(fullSnapshot.modelCatalog);

    expect(mocks.activateSnapshot).toHaveBeenCalledWith(
      expect.not.objectContaining({ readOnly: true }),
    );
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
    expect(mocks.releaseSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a standalone catalog owner built from another config", async () => {
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.activateSnapshot.mockResolvedValue({
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/old" } } },
    });

    await expect(loadPreparedModelCatalogSnapshot()).rejects.toThrow("requested config");
  });

  it("leases a full generation for a gateway preflight in a dynamic workspace", async () => {
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.activateSnapshot.mockResolvedValue(undefined);
    mocks.acquireSnapshot.mockResolvedValue(fullSnapshot);

    await expect(
      loadPreparedModelCatalogSnapshot({ workspaceDir: "/tmp/spawned-workspace" }),
    ).resolves.toBe(fullSnapshot.modelCatalog);

    expect(mocks.acquireSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/spawned-workspace" }),
    );
    expect(mocks.acquireSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it("rejects a full fallback lease built from another config", async () => {
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.activateSnapshot.mockResolvedValue(undefined);
    mocks.acquireSnapshot.mockResolvedValue({
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/old" } } },
    });

    await expect(loadPreparedModelCatalogSnapshot()).rejects.toThrow("requested config");
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });
});
