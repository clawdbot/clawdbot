import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeOpenClawConfigFixture } from "./embedded-agent-runner/model.test-harness.js";

const runtimeMocks = vi.hoisted(() => {
  const createLease = (owner: string) => {
    const authStorage = { owner };
    const modelRegistry = { owner };
    return {
      authStorage,
      modelRegistry,
      snapshot: {
        createStores: vi.fn(() => ({ authStorage, modelRegistry })),
      },
      release: vi.fn(),
    };
  };
  const requestLease = createLease("request");
  const publishedLease = createLease("published");
  return {
    acquire: vi.fn(async () => requestLease),
    publishedLease,
    requestLease,
    resolveModelAsync: vi.fn(async () => ({
      model: {
        id: "chat-latest",
        name: "chat-latest",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    })),
    staticCatalogModel: vi.fn(),
  };
});

vi.mock("./prepared-model-runtime.js", () => ({
  acquireReadOnlyPreparedModelRuntime: runtimeMocks.acquire,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: runtimeMocks.resolveModelAsync,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: runtimeMocks.staticCatalogModel,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: () => undefined,
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agents/main/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
  resolveDefaultAgentDir: () => "/tmp/agents/main/agent",
  resolveSessionAgentId: () => "main",
}));

describe("resolveEffectiveToolInventoryRuntimeModelContextAsync", () => {
  beforeEach(() => {
    runtimeMocks.acquire.mockReset().mockResolvedValue(runtimeMocks.requestLease);
    runtimeMocks.requestLease.snapshot.createStores.mockClear();
    runtimeMocks.publishedLease.snapshot.createStores.mockClear();
    runtimeMocks.resolveModelAsync.mockClear();
    runtimeMocks.requestLease.release.mockClear();
    runtimeMocks.publishedLease.release.mockClear();
    runtimeMocks.staticCatalogModel.mockReset();
  });

  it.each([
    { owner: "request-owned", lease: runtimeMocks.requestLease },
    { owner: "published", lease: runtimeMocks.publishedLease },
  ])("prepares dynamic model context with a $owner runtime lease", async ({ lease }) => {
    runtimeMocks.acquire.mockResolvedValueOnce(lease);
    const { resolveEffectiveToolInventoryRuntimeModelContextAsync } =
      await import("./tools-effective-inventory.js");
    const cfg = makeOpenClawConfigFixture();

    await expect(
      resolveEffectiveToolInventoryRuntimeModelContextAsync({
        cfg,
        agentId: "main",
        agentDir: "/tmp/agents/main/agent",
        workspaceDir: "/tmp/workspace-main",
        modelProvider: "openai",
        modelId: "chat-latest",
      }),
    ).resolves.toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: "chat-latest", provider: "openai" },
    });
    expect(runtimeMocks.resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "chat-latest",
      "/tmp/agents/main/agent",
      cfg,
      {
        agentId: "main",
        workspaceDir: "/tmp/workspace-main",
        authStorage: lease.authStorage,
        modelRegistry: lease.modelRegistry,
        preparedModelRuntime: lease.snapshot,
      },
    );
    expect(runtimeMocks.acquire).toHaveBeenCalledWith({
      agentId: "main",
      agentDir: "/tmp/agents/main/agent",
      config: cfg,
      workspaceDir: "/tmp/workspace-main",
    });
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { modelProvider: "", modelId: "chat-latest" },
    { modelProvider: "openai", modelId: " " },
  ])("skips runtime preparation for invalid model input", async (input) => {
    const { resolveEffectiveToolInventoryRuntimeModelContextAsync } =
      await import("./tools-effective-inventory.js");

    await expect(
      resolveEffectiveToolInventoryRuntimeModelContextAsync({
        cfg: {},
        ...input,
      }),
    ).resolves.toEqual({});
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease.release).not.toHaveBeenCalled();
  });

  it("uses configured model context without acquiring a runtime lease", async () => {
    const { resolveEffectiveToolInventoryRuntimeModelContextAsync } =
      await import("./tools-effective-inventory.js");
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          custom: {
            api: "anthropic-messages",
            models: [
              {
                id: "configured",
                name: "Configured",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    });

    await expect(
      resolveEffectiveToolInventoryRuntimeModelContextAsync({
        cfg,
        modelProvider: "custom",
        modelId: "configured",
      }),
    ).resolves.toMatchObject({
      modelApi: "anthropic-messages",
      runtimeModel: { id: "configured", provider: "custom" },
    });
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease.release).not.toHaveBeenCalled();
  });

  it("uses bundled model context without acquiring a runtime lease", async () => {
    runtimeMocks.staticCatalogModel.mockReturnValue({
      id: "bundled",
      name: "Bundled",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    const { resolveEffectiveToolInventoryRuntimeModelContextAsync } =
      await import("./tools-effective-inventory.js");

    await expect(
      resolveEffectiveToolInventoryRuntimeModelContextAsync({
        cfg: {},
        modelProvider: "openai",
        modelId: "bundled",
      }),
    ).resolves.toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: "bundled", provider: "openai" },
    });
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease.release).not.toHaveBeenCalled();
  });

  it("releases the runtime lease when dynamic model resolution fails", async () => {
    const failure = new Error("dynamic model failed");
    runtimeMocks.resolveModelAsync.mockRejectedValueOnce(failure);
    const { resolveEffectiveToolInventoryRuntimeModelContextAsync } =
      await import("./tools-effective-inventory.js");

    await expect(
      resolveEffectiveToolInventoryRuntimeModelContextAsync({
        cfg: {},
        modelProvider: "openai",
        modelId: "chat-latest",
      }),
    ).rejects.toBe(failure);
    expect(runtimeMocks.requestLease.release).toHaveBeenCalledTimes(1);
  });
});
