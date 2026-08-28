import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";

vi.mock("./models.js", () => ({
  listAllCodexAppServerModels: vi.fn(),
}));

const listModelsMock = vi.mocked(listAllCodexAppServerModels);

const catalogParams = {
  config: {},
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

describe("Codex app-server model catalog", () => {
  beforeEach(() => {
    listModelsMock.mockReset();
  });

  it("projects picker models onto the ChatGPT Codex route", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "gpt-5.6-sol",
          model: "codex-execution-model",
          displayName: "GPT-5.6 Sol",
          inputModalities: ["text", "image", "unknown"],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    const catalog = await loadCodexAppServerModelCatalog(catalogParams, undefined);
    expect(catalog).toEqual([
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerOrder: 0,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text", "image"],
        params: { codexAppServerRuntimeModel: "codex-execution-model" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      },
      {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        providerOrder: 1,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: false,
        input: ["text"],
        compat: {
          supportsReasoningEffort: false,
          supportedReasoningEfforts: [],
        },
      },
    ]);
    expect(listModelsMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 2500 }),
    );
  });

  it("returns no rows without a live call when discovery is disabled", async () => {
    expect(
      await loadCodexAppServerModelCatalog(catalogParams, { discovery: { enabled: false } }),
    ).toEqual([]);
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("bounds the live call with the configured discovery timeout", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    await loadCodexAppServerModelCatalog(catalogParams, { discovery: { timeoutMs: 750 } });
    expect(listModelsMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 750 }),
    );
  });
});
