import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {} as object,
  agentIds: ["main"],
  agentDirs: new Map<string, string>(),
  activateSnapshot: vi.fn(),
  acquireSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  prepareSnapshot: vi.fn(),
  prepareScopedCatalog: vi.fn(),
  refreshStaleCatalog: vi.fn(),
  isFullCatalog: vi.fn(),
  releaseSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => mocks.agentIds,
  resolveAgentDir: (_config: object, agentId: string, env?: NodeJS.ProcessEnv) =>
    env?.OPENCLAW_STATE_DIR
      ? `${env.OPENCLAW_STATE_DIR}/${agentId}`
      : (mocks.agentDirs.get(agentId) ?? "/tmp/prepared-model-catalog-agent"),
  resolveAgentWorkspaceDir: (_config: object, agentId: string, env?: NodeJS.ProcessEnv) =>
    env?.OPENCLAW_STATE_DIR
      ? `${env.OPENCLAW_STATE_DIR}/workspace-${agentId}`
      : "/tmp/prepared-model-catalog-workspace",
  resolveAmbientOwnerAgentId: () => "main",
  resolveDefaultAgentDir: () => "/tmp/prepared-model-catalog-agent",
  resolveDefaultAgentId: () => "main",
  tryResolveLegacyCompatibilityAgentId: () => "main",
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
    refreshStalePreparedModelRuntimeCatalog: (...args: unknown[]) =>
      mocks.refreshStaleCatalog(...args),
  };
});

vi.mock("./prepared-model-runtime.full-catalog.js", () => ({
  isPreparedModelCatalogFull: (...args: unknown[]) => mocks.isFullCatalog(...args),
}));

vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: (...args: unknown[]) => mocks.prepareScopedCatalog(...args),
}));

import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  getPreparedModelCatalogSnapshot,
  loadPreparedModelCatalogOwnerSnapshot,
  loadPreparedModelCatalogSnapshot,
  loadResolvedPublishedModelCatalogOwner,
  loadPublishedPreparedModelCatalog,
  loadPublishedPreparedModelCatalogOwnerSnapshot,
} from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelFullCatalogAuth,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.js";

const fullSnapshot = {
  config: mocks.config,
  catalogOwner: { agentId: "main", workspaceDir: "/tmp/prepared-model-catalog-workspace" },
  authModes: {},
  authStore: { version: 1, profiles: {} },
  metadataSnapshot: { index: { plugins: [] }, plugins: [] },
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
    mocks.agentIds = ["main"];
    mocks.agentDirs.clear();
    mocks.activateSnapshot.mockReset();
    mocks.acquireSnapshot.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.loadSnapshot.mockReset();
    mocks.prepareSnapshot.mockReset();
    mocks.prepareScopedCatalog.mockReset();
    mocks.refreshStaleCatalog.mockReset();
    mocks.isFullCatalog.mockReset();
    mocks.releaseSnapshot.mockReset();
  });

  it("uses the requested environment for directory selection and workspace activation", async () => {
    mocks.agentIds = ["main", "worker"];
    const env = { OPENCLAW_STATE_DIR: "/tmp/selected-catalog-state" };
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadPreparedModelCatalogSnapshot({
        agentDir: "/tmp/selected-catalog-state/worker",
        readOnly: true,
        env,
      }),
    ).resolves.toEqual(readOnlySnapshot.modelCatalog);
    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        workspaceDir: "/tmp/selected-catalog-state/workspace-worker",
        env,
      }),
    );
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

  it("returns the published owner without config matching or catalog materialization", () => {
    const committedSnapshot = {
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/committed" } } },
      loadFullModelCatalog: vi.fn(),
    };
    mocks.getSnapshot.mockReturnValue(committedSnapshot);

    expect(
      getPublishedPreparedModelCatalogOwnerSnapshot({
        config: { agents: { defaults: { model: "openai/requested" } } },
        allowGatewaySubagentBinding: true,
      }),
    ).toBe(committedSnapshot);
    expect(mocks.getSnapshot).toHaveBeenCalledOnce();
    expect(mocks.getSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
    expect(committedSnapshot.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(mocks.prepareSnapshot).not.toHaveBeenCalled();
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

  it("refreshes stale catalog content during an explicit read-only load", async () => {
    const staleCatalog = {
      entries: [{ provider: "test", id: "fresh", name: "Fresh" }],
      routeVariants: [],
    };
    const snapshot = {
      ...fullSnapshot,
      loadFullModelCatalog: vi.fn(),
      readFullModelCatalog: vi.fn(() => fullSnapshot.modelCatalog),
    };
    mocks.getSnapshot.mockReturnValue(snapshot);
    mocks.prepareSnapshot.mockResolvedValue(snapshot);
    mocks.refreshStaleCatalog.mockResolvedValue(staleCatalog);
    setPreparedModelFullCatalogAuth(staleCatalog, {
      authStore: fullSnapshot.authStore,
      authModes: fullSnapshot.authModes,
    });

    await expect(
      loadPreparedModelCatalogOwnerSnapshot({ readOnly: true, refreshFullCatalog: true }),
    ).resolves.toMatchObject({ modelCatalog: staleCatalog });
    expect(mocks.refreshStaleCatalog).toHaveBeenCalledWith(snapshot);
    expect(snapshot.readFullModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps auth-only reads on the current catalog facts", async () => {
    const snapshot = {
      ...fullSnapshot,
      loadFullModelCatalog: vi.fn(),
      readFullModelCatalog: vi.fn(() => fullSnapshot.modelCatalog),
    };
    mocks.getSnapshot.mockReturnValue(snapshot);
    mocks.prepareSnapshot.mockResolvedValue(snapshot);
    setPreparedModelFullCatalogAuth(snapshot.modelCatalog, {
      authStore: fullSnapshot.authStore,
      authModes: fullSnapshot.authModes,
    });

    await expect(
      loadPreparedModelCatalogOwnerSnapshot({ readOnly: true, refreshFullCatalog: false }),
    ).resolves.toMatchObject({ modelCatalog: fullSnapshot.modelCatalog });
    expect(mocks.refreshStaleCatalog).not.toHaveBeenCalled();
    expect(snapshot.readFullModelCatalog).toHaveBeenCalledOnce();
  });

  it("does not await a stale full catalog for read-only request paths", async () => {
    const snapshot = {
      ...fullSnapshot,
      loadFullModelCatalog: vi.fn(),
      readFullModelCatalog: vi.fn(() => fullSnapshot.modelCatalog),
    };
    mocks.getSnapshot.mockReturnValue(snapshot);
    mocks.prepareSnapshot.mockResolvedValue(snapshot);
    mocks.refreshStaleCatalog.mockRejectedValue(new Error("full discovery was awaited"));
    setPreparedModelFullCatalogAuth(snapshot.modelCatalog, {
      authStore: fullSnapshot.authStore,
      authModes: fullSnapshot.authModes,
    });

    await expect(loadPreparedModelCatalogSnapshot({ readOnly: true })).resolves.toBe(
      snapshot.modelCatalog,
    );
    expect(mocks.refreshStaleCatalog).not.toHaveBeenCalled();
  });

  it("reuses a published full generation for a provider-scoped read-only load", async () => {
    mocks.prepareSnapshot.mockResolvedValue(fullSnapshot);
    mocks.isFullCatalog.mockReturnValue(true);

    await expect(
      loadPreparedModelCatalogSnapshot({
        readOnly: true,
        providerDiscoveryProviderIds: ["anthropic"],
      }),
    ).resolves.toBe(fullSnapshot.modelCatalog);

    expect(mocks.isFullCatalog).toHaveBeenCalledWith(fullSnapshot.modelCatalog);
    expect(mocks.prepareScopedCatalog).not.toHaveBeenCalled();
  });

  it("builds a scoped catalog when the published generation is configured-only", async () => {
    const scopedCatalog = {
      entries: [{ provider: "anthropic", id: "claude", name: "Claude" }],
      routeVariants: [],
    };
    mocks.prepareSnapshot.mockResolvedValue(readOnlySnapshot);
    mocks.isFullCatalog.mockReturnValue(false);
    mocks.prepareScopedCatalog.mockResolvedValue(scopedCatalog);

    await expect(
      loadPreparedModelCatalogSnapshot({
        readOnly: true,
        providerDiscoveryProviderIds: ["anthropic"],
      }),
    ).resolves.toBe(scopedCatalog);

    expect(mocks.prepareSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.prepareScopedCatalog).toHaveBeenCalledOnce();
    expect(mocks.prepareScopedCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        workspaceDir: "/tmp/prepared-model-catalog-workspace",
      }),
      ["anthropic"],
    );
  });

  it("keeps read-only catalog reads on configured facts and materializes full reads once", async () => {
    const configuredCatalog = {
      entries: [{ provider: "test", id: "configured", name: "Configured" }],
      routeVariants: [],
    };
    const discoveredCatalog = {
      entries: [{ provider: "test", id: "discovered", name: "Discovered" }],
      routeVariants: [],
    };
    const { authStore, ...snapshotFacts } = fullSnapshot;
    setPreparedModelFullCatalogAuth(discoveredCatalog, { authStore, authModes: {} });
    const loadFullModelCatalog = vi.fn(async () => discoveredCatalog);
    const snapshot = {
      ...snapshotFacts,
      modelCatalog: configuredCatalog,
      loadFullModelCatalog,
    };
    setPreparedModelRuntimeAuthStore(snapshot, authStore);
    mocks.prepareSnapshot.mockResolvedValue(snapshot);

    await expect(loadPreparedModelCatalogSnapshot({ readOnly: true })).resolves.toBe(
      configuredCatalog,
    );
    expect(loadFullModelCatalog).not.toHaveBeenCalled();

    const materialized = await loadPreparedModelCatalogOwnerSnapshot({ readOnly: false });
    expect(materialized.modelCatalog).toBe(discoveredCatalog);
    expect(materialized).not.toHaveProperty("authStore");
    expect(getPreparedModelRuntimeAuthStore(materialized)).toBe(authStore);
    expect(loadFullModelCatalog).toHaveBeenCalledOnce();

    mocks.getSnapshot.mockReturnValue(snapshot);
    expect(getPreparedModelCatalogSnapshot({ readOnly: true })).toBe(configuredCatalog);
    expect(getPreparedModelCatalogSnapshot()).toBe(configuredCatalog);
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
    expect(mocks.refreshStaleCatalog).not.toHaveBeenCalled();
  });

  it("rejects a full generation replaced with another config", async () => {
    const committedConfig = { agents: { defaults: { model: "openai/committed" } } };
    const committedSnapshot = { ...fullSnapshot, config: committedConfig };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(loadPreparedModelCatalogSnapshot({ readOnly: true })).rejects.toThrow(
      "config was replaced",
    );
    await expect(loadPreparedModelCatalogSnapshot({ readOnly: true })).rejects.toBeInstanceOf(
      PreparedModelCatalogConfigReplacedError,
    );
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
  });

  it.each([{ readOnly: true }, { readOnly: false }])(
    "returns the published replacement owner for Gateway reads (readOnly=$readOnly)",
    async ({ readOnly }) => {
      const committedConfig = { agents: { defaults: { model: "openai/committed" } } };
      const committedSnapshot = {
        ...fullSnapshot,
        agentDir: "/tmp/prepared-model-catalog-agent",
        config: committedConfig,
      };
      mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

      await expect(loadPublishedPreparedModelCatalogOwnerSnapshot({ readOnly })).resolves.toBe(
        committedSnapshot,
      );
      expect(mocks.loadSnapshot).not.toHaveBeenCalled();
      expect(mocks.activateSnapshot).not.toHaveBeenCalled();
      expect(mocks.acquireSnapshot).not.toHaveBeenCalled();
    },
  );

  it("restores the unique configured agent identity for a published replacement owner", async () => {
    const committedSnapshot = {
      ...fullSnapshot,
      agentDir: "/tmp/prepared-model-catalog-agent",
      config: { agents: { list: [{ id: "main", default: true }] } },
    };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(
      loadResolvedPublishedModelCatalogOwner({ agentId: "MAIN", readOnly: true }),
    ).resolves.toMatchObject({ agentId: "main", agentDir: committedSnapshot.agentDir });
  });

  it("resolves a complete published owner for runtime consumers", async () => {
    const committedSnapshot = {
      ...fullSnapshot,
      agentDir: "/tmp/prepared-model-catalog-agent",
      config: { agents: { list: [{ id: "main", default: true }] } },
    };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(
      loadResolvedPublishedModelCatalogOwner({ agentId: "MAIN", readOnly: true }),
    ).resolves.toEqual({
      catalogOwner: fullSnapshot.catalogOwner,
      agentId: "main",
      agentDir: "/tmp/prepared-model-catalog-agent",
      workspaceDir: "/tmp/prepared-model-catalog-workspace",
      config: committedSnapshot.config,
      authModes: {},
      authStore: { version: 1, profiles: {} },
      metadataSnapshot: fullSnapshot.metadataSnapshot,
      modelCatalog: committedSnapshot.modelCatalog,
    });
  });

  it("keeps a shared-directory published replacement owner ambiguous", async () => {
    mocks.agentIds = ["main", "worker"];
    mocks.agentDirs.set("main", "/tmp/shared-agent-dir");
    mocks.agentDirs.set("worker", "/tmp/shared-agent-dir");
    const committedSnapshot = {
      ...fullSnapshot,
      agentDir: "/tmp/shared-agent-dir",
      catalogOwner: undefined,
      config: { agents: { list: [{ id: "main", default: true }, { id: "worker" }] } },
    };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(
      loadPublishedPreparedModelCatalogOwnerSnapshot({ agentId: "worker", readOnly: true }),
    ).resolves.not.toHaveProperty("agentId");
    await expect(
      loadResolvedPublishedModelCatalogOwner({ agentId: "worker", readOnly: true }),
    ).rejects.toThrow("did not identify one configured agent");
  });

  it("projects published replacement entries for runtime callers", async () => {
    const committedSnapshot = {
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/committed" } } },
    };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(loadPublishedPreparedModelCatalog({ readOnly: true })).resolves.toBe(
      committedSnapshot.modelCatalog.entries,
    );
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
