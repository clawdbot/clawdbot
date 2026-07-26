import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OwnerNotPublishedError extends Error {}
  return {
    OwnerNotPublishedError,
    activateSnapshot: vi.fn(),
    getSnapshot: vi.fn(),
    loadSnapshot: vi.fn(),
    releaseSnapshot: vi.fn(),
    prepareSnapshot: vi.fn(),
    normalizeModel: vi.fn((model: { id: string }) => ({
      ...model,
      name: `normalized:${model.id}`,
    })),
  };
});

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: (_config: unknown, agentId: string) => `/agents/${agentId}`,
  resolveAgentWorkspaceDir: (_config: unknown, agentId: string) => `/workspaces/${agentId}`,
  resolveDefaultAgentDir: () => "/agents/main",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("./agent-model-discovery.js", () => ({
  normalizeDiscoveredAgentModel: mocks.normalizeModel,
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireReadOnlyPreparedModelRuntime: async (input: Record<string, unknown>) => ({
    snapshot: await mocks.loadSnapshot({ ...input, readOnly: true }),
    release: mocks.releaseSnapshot,
  }),
  activateStandalonePreparedModelRuntime: mocks.activateSnapshot,
  getPreparedModelRuntimeSnapshot: mocks.getSnapshot,
  loadPreparedModelRuntimeSnapshot: mocks.loadSnapshot,
  preparedModelRuntimeConfigsMatch: (left: object, right: object) =>
    JSON.stringify(left) === JSON.stringify(right),
  prepareModelRuntimeSnapshot: mocks.prepareSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError: mocks.OwnerNotPublishedError,
}));

const { loadPreparedAgentModelRegistry } = await import("./prepared-model-registry.js");

function createSnapshot(
  models = [
    { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai-responses" },
    { provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic-messages" },
  ],
) {
  const registry = {
    fork: vi.fn(),
    getAll: vi.fn(() => models),
    getAvailable: vi.fn(() => models),
    find: vi.fn((provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    ),
  };
  registry.fork.mockReturnValue(registry);
  return {
    registry,
    snapshot: {
      agentDir: "/agents/main",
      config: {},
      createStores: () => ({ modelRegistry: registry }),
    },
  };
}

describe("prepared agent model registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeModel.mockImplementation((model: { id: string }) => ({
      ...model,
      name: `normalized:${model.id}`,
    }));
  });

  it("forks and filters the published lifecycle generation", async () => {
    const { registry, snapshot } = createSnapshot();
    mocks.prepareSnapshot.mockResolvedValue(snapshot);
    mocks.getSnapshot.mockReturnValue(snapshot);

    const loaded = await loadPreparedAgentModelRegistry(
      {},
      { agentId: "worker", providerFilter: "OPENAI", workspaceDir: "/workspace" },
    );

    expect(mocks.prepareSnapshot).toHaveBeenCalledWith({
      agentId: "worker",
      agentDir: "/agents/worker",
      config: {},
      inheritedAuthDir: "/agents/main",
      workspaceDir: "/workspace",
    });
    expect(mocks.activateSnapshot).not.toHaveBeenCalled();
    expect(loaded.registry.getAll()).toEqual([
      expect.objectContaining({ provider: "openai", name: "normalized:gpt-test" }),
    ]);
    expect(registry.find("anthropic", "claude-test")).toEqual(
      expect.objectContaining({ provider: "anthropic", name: "normalized:claude-test" }),
    );
  });

  it("accepts the committed owner when config replacement wins a read race", async () => {
    const { snapshot } = createSnapshot();
    const committedSnapshot = {
      ...snapshot,
      config: { agents: { defaults: { model: "openai/committed" } } },
    };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    const loaded = await loadPreparedAgentModelRegistry({ logging: { level: "debug" } });

    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
    expect(loaded.config).toBe(committedSnapshot.config);
  });

  it("loads a read-only generation when no owner is published", async () => {
    const { snapshot } = createSnapshot();
    mocks.prepareSnapshot.mockRejectedValue(new mocks.OwnerNotPublishedError());
    mocks.loadSnapshot.mockImplementation(async () => {
      mocks.getSnapshot.mockImplementation((input: { readOnly?: boolean }) =>
        input.readOnly ? snapshot : undefined,
      );
      return snapshot;
    });

    const loaded = await loadPreparedAgentModelRegistry({}, { normalizeModels: false });

    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir: "/agents/main",
        readOnly: true,
      }),
    );
    expect(loaded.registry.getAll()).toHaveLength(2);
    expect(mocks.normalizeModel).not.toHaveBeenCalled();
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it("finds identities produced by normalization", async () => {
    const { registry, snapshot } = createSnapshot([
      {
        provider: "legacy-openai",
        id: "raw-gpt-test",
        name: "Raw GPT Test",
        api: "openai-responses",
      },
    ]);
    const rawFind = registry.find;
    mocks.normalizeModel.mockImplementation((model) => ({
      ...model,
      provider: "openai",
      id: "gpt-test",
      name: "Normalized GPT Test",
    }));
    mocks.prepareSnapshot.mockResolvedValue(snapshot);

    const loaded = await loadPreparedAgentModelRegistry({}, { providerFilter: "openai" });
    const [normalized] = loaded.registry.getAll();

    expect(normalized).toMatchObject({ provider: "openai", id: "gpt-test" });
    expect(loaded.registry.find("openai", "gpt-test")).toBe(normalized);
    expect(rawFind).toHaveBeenCalledWith("openai", "gpt-test");
  });

  it("prepares a distinct credential-free lifecycle owner", async () => {
    const { snapshot } = createSnapshot();
    mocks.prepareSnapshot.mockRejectedValue(new mocks.OwnerNotPublishedError());
    mocks.loadSnapshot.mockResolvedValue(snapshot);

    await loadPreparedAgentModelRegistry({}, { normalizeModels: false, skipCredentials: true });

    expect(mocks.prepareSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ skipCredentials: true }),
    );
    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, skipCredentials: true }),
    );
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it("forks empty auth storage when availability loading is disabled", async () => {
    const { registry, snapshot } = createSnapshot();
    mocks.prepareSnapshot.mockRejectedValue(new mocks.OwnerNotPublishedError());
    mocks.loadSnapshot.mockImplementation(async () => {
      mocks.getSnapshot.mockImplementation((input: { readOnly?: boolean }) =>
        input.readOnly ? snapshot : undefined,
      );
      return snapshot;
    });

    await loadPreparedAgentModelRegistry({}, { loadAvailability: false });

    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, skipCredentials: true }),
    );
    expect(registry.fork).toHaveBeenCalledOnce();
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });
});
