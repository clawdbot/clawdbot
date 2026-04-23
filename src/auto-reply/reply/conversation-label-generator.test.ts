import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.hoisted(() => vi.fn());
const getRuntimeAuthForModel = vi.hoisted(() => vi.fn());
const requireApiKey = vi.hoisted(() => vi.fn());
const resolveDefaultModelForAgent = vi.hoisted(() => vi.fn());
const resolveModelAsync = vi.hoisted(() => vi.fn());
const prepareModelForSimpleCompletion = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    completeSimple,
  };
});

vi.mock("../../agents/model-auth.js", () => ({ requireApiKey }));

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
});
