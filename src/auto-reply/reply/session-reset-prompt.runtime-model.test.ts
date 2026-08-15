import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const inventoryMocks = vi.hoisted(() => {
  const runtimeModel = {
    id: "dynamic-chat",
    name: "dynamic-chat",
    provider: "dynamic-provider",
    api: "openai-responses",
    baseUrl: "https://example.invalid/v1",
  };
  return {
    runtimeModel,
    resolveRuntimeModelContext: vi.fn(async () => ({
      modelApi: runtimeModel.api,
      runtimeModel,
    })),
    resolveInventory: vi.fn((params: Record<string, unknown>) => {
      if (!Object.hasOwn(params, "modelApi") || !Object.hasOwn(params, "runtimeModel")) {
        throw new Error("runtime model facts must be explicitly owner-published");
      }
      return {
        agentId: "main",
        profile: "coding",
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [
              {
                id: "read",
                label: "Read",
                description: "Read files",
                rawDescription: "Read files",
                source: "core",
              },
            ],
          },
        ],
      };
    }),
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: inventoryMocks.resolveInventory,
  resolveEffectiveToolInventoryRuntimeModelContextAsync: inventoryMocks.resolveRuntimeModelContext,
}));

describe("resolveBareResetBootstrapFileAccess runtime model ownership", () => {
  beforeEach(() => {
    inventoryMocks.resolveInventory.mockClear();
    inventoryMocks.resolveRuntimeModelContext.mockClear();
  });

  it("resolves runtime model context once and passes explicit facts to sync inventory", async () => {
    const { resolveBareResetBootstrapFileAccess } = await import("./session-reset-prompt.js");
    const cfg = {} as OpenClawConfig;
    const params = {
      cfg,
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/workspace-main",
      modelProvider: "dynamic-provider",
      modelId: "dynamic-chat",
    };

    await expect(resolveBareResetBootstrapFileAccess(params)).resolves.toBe(true);

    expect(inventoryMocks.resolveRuntimeModelContext).toHaveBeenCalledTimes(1);
    expect(inventoryMocks.resolveRuntimeModelContext).toHaveBeenCalledWith({
      cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    });
    expect(inventoryMocks.resolveInventory).toHaveBeenCalledTimes(1);
    const inventoryParams = inventoryMocks.resolveInventory.mock.calls[0]?.[0];
    expect(inventoryParams).toMatchObject({
      ...params,
      modelApi: inventoryMocks.runtimeModel.api,
      runtimeModel: inventoryMocks.runtimeModel,
    });
    expect(Object.hasOwn(inventoryParams ?? {}, "modelApi")).toBe(true);
    expect(Object.hasOwn(inventoryParams ?? {}, "runtimeModel")).toBe(true);
  });
});
