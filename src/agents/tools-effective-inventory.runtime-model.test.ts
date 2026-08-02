import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => {
  class OwnerNotPublishedError extends Error {}
  return {
    OwnerNotPublishedError,
    resolveModelAsync: vi.fn(async () => ({
      model: {
        id: "chat-latest",
        name: "chat-latest",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    })),
  };
});

vi.mock("./prepared-model-runtime.js", () => ({
  PreparedModelRuntimeOwnerNotPublishedError: runtimeMocks.OwnerNotPublishedError,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModel: () => {
    throw new runtimeMocks.OwnerNotPublishedError("owner missing");
  },
  resolveModelAsync: runtimeMocks.resolveModelAsync,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: () => undefined,
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agents/main/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
  resolveSessionAgentId: () => "main",
}));

describe("resolveEffectiveToolInventoryRuntimeModelContextAsync", () => {
  it("prepares dynamic model context when no lifecycle owner exists", async () => {
    const { resolveEffectiveToolInventoryRuntimeModelContextAsync } =
      await import("./tools-effective-inventory.js");

    await expect(
      resolveEffectiveToolInventoryRuntimeModelContextAsync({
        cfg: {},
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
      {},
      { agentId: "main", workspaceDir: "/tmp/workspace-main" },
    );
  });
});
