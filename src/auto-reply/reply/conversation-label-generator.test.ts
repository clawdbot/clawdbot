import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.hoisted(() => vi.fn());
const getRuntimeAuthForModel = vi.hoisted(() => vi.fn());
const logVerbose = vi.hoisted(() => vi.fn());
const requireApiKey = vi.hoisted(() => vi.fn());
const resolveDefaultModelForAgent = vi.hoisted(() => vi.fn());
const resolveModelAsync = vi.hoisted(() => vi.fn());
const prepareModelForSimpleCompletion = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...original,
    completeSimple,
  };
});

vi.mock("../../agents/model-auth.js", () => ({ requireApiKey }));

vi.mock("../../globals.js", () => ({ logVerbose }));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent,
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync,
}));

vi.mock("../../agents/simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion,
}));

vi.mock("../../plugins/runtime/runtime-model-auth.runtime.js", () => ({
  getRuntimeAuthForModel,
}));

import { generateConversationLabel } from "./conversation-label-generator.js";

describe("generateConversationLabel", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    getRuntimeAuthForModel.mockReset();
    logVerbose.mockReset();
    requireApiKey.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveModelAsync.mockReset();
    prepareModelForSimpleCompletion.mockReset();

    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-test" });
    resolveModelAsync.mockResolvedValue({
      model: { provider: "openai" },
      authStorage: {},
      modelRegistry: {},
    });
    prepareModelForSimpleCompletion.mockImplementation(({ model }) => model);
    getRuntimeAuthForModel.mockResolvedValue({ apiKey: "resolved-key", mode: "api-key" });
    requireApiKey.mockReturnValue("resolved-key");
    completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "Topic label" }],
    });
  });

  it("uses routed agentDir for model and auth resolution", async () => {
    await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "prompt",
      cfg: {},
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
    });

    expect(resolveDefaultModelForAgent).toHaveBeenCalledWith({
      cfg: {},
      agentId: "billing",
    });
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-test",
      "/tmp/agents/billing/agent",
      {},
    );
    expect(getRuntimeAuthForModel).toHaveBeenCalledWith({
      model: { provider: "openai" },
      cfg: {},
      workspaceDir: "/tmp/agents/billing/agent",
    });
    expect(prepareModelForSimpleCompletion).toHaveBeenCalledWith({
      model: { provider: "openai" },
      cfg: {},
    });
  });

  it("passes the label prompt as systemPrompt and the user text as message content", async () => {
    await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "Generate a label",
      cfg: {},
    });

    expect(completeSimple).toHaveBeenCalledWith(
      { provider: "openai" },
      {
        systemPrompt: "Generate a label",
        messages: [
          {
            role: "user",
            content: "Need help with invoices",
            timestamp: expect.any(Number),
          },
        ],
      },
      expect.objectContaining({
        apiKey: "resolved-key",
        maxTokens: 100,
        temperature: 0.3,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("omits temperature for Codex Responses simple completions", async () => {
    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai-codex", model: "gpt-5.5" });
    resolveModelAsync.mockResolvedValue({
      model: { provider: "openai-codex", api: "openai-codex-responses" },
      authStorage: {},
      modelRegistry: {},
    });

    await generateConversationLabel({
      userMessage: "тест создания топика-треда",
      prompt: "Generate a label",
      cfg: {},
    });

    expect(completeSimple.mock.calls[0]?.[2]).toEqual(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
  });

  it("logs completion errors instead of treating them as empty labels", async () => {
    completeSimple.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "Codex error: Instructions are required",
    });

    const label = await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "Generate a label",
      cfg: {},
    });

    expect(label).toBeNull();
    expect(logVerbose).toHaveBeenCalledWith(
      "conversation-label-generator: completion failed: Codex error: Instructions are required",
    );
  });
});
