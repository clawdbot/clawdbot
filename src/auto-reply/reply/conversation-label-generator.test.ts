import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

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

  afterEach(() => {
    vi.useRealTimers();
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
    vi.useFakeTimers();
    vi.setSystemTime(1_710_000_000_000);

    await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "Generate a label",
      cfg: {},
    });

    expect(completeSimple).toHaveBeenCalledOnce();
    const call = requireFirstMockCall(completeSimple, "simple completion");
    expect(call[0]).toStrictEqual({ provider: "openai" });
    expect(call[1]).toStrictEqual({
      systemPrompt: "Generate a label",
      messages: [
        {
          role: "user",
          content: "Need help with invoices",
          timestamp: 1_710_000_000_000,
        },
      ],
    });
    expect(call[2].apiKey).toBe("resolved-key");
    expect(call[2].maxTokens).toBe(100);
    expect(call[2].temperature).toBe(0.3);
    expect(call[2].signal).toBeInstanceOf(AbortSignal);
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

    expect(completeSimple).toHaveBeenCalledOnce();
    const options = requireFirstMockCall(completeSimple, "simple completion")[2];
    if (!options) {
      throw new Error("expected simple completion options");
    }
    expect(Object.hasOwn(options, "temperature")).toBe(false);
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
