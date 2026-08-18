import { describe, expect, it } from "vitest";
import { loadCodexAppServerModelCatalog } from "./model-catalog.js";

describe("Codex app-server model catalog", () => {
  it("projects picker models onto the ChatGPT Codex route", async () => {
    expect(
      await loadCodexAppServerModelCatalog(
        {
          config: {},
          agentId: "main",
          agentDir: "/tmp/main-agent",
          workspaceDir: "/tmp/workspace",
        },
        undefined,
        async () => ({
          models: [
            {
              id: "gpt-5.6-terra",
              model: "gpt-5.6-terra",
              displayName: "GPT-5.6 Terra",
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
        }),
      ),
    ).toEqual([
      {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        providerOrder: 0,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text", "image"],
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
      },
    ]);
  });
});
