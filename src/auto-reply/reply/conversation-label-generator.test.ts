/** Tests generated conversation labels for reply sessions. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());
const logVerbose = vi.hoisted(() => vi.fn());
const prepareSimpleCompletionModelForAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
}));

vi.mock("../../globals.js", () => ({ logVerbose }));

import { generateConversationLabel } from "./conversation-label-generator.js";

function firstCompletionArgs() {
  const call = completeWithPreparedSimpleCompletionModel.mock.calls.at(0);
  if (!call) {
    throw new Error("expected simple completion call");
  }
  return call[0];
}

describe("generateConversationLabel", () => {
  beforeEach(() => {
    completeWithPreparedSimpleCompletionModel.mockReset();
    logVerbose.mockReset();
    prepareSimpleCompletionModelForAgent.mockReset();

    prepareSimpleCompletionModelForAgent.mockResolvedValue({
      selection: {
        provider: "openai",
        modelId: "gpt-test",
        agentDir: "/tmp/openclaw-agent",
      },
      model: { provider: "openai", id: "gpt-test", maxTokens: 8192 },
      auth: { apiKey: "resolved-key", mode: "api-key" },
    });
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "Topic label" }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepares the configured utility model in the routed agent directory", async () => {
    const cfg = { agents: { defaults: { utilityModel: "openai/gpt-test" } } };

    await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "prompt",
      cfg,
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
    });

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
      useUtilityModel: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("passes the label prompt and a reasoning-safe bounded completion budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_710_000_000_000);
    const cfg = {};

    await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "Generate a label",
      cfg,
    });

    expect(firstCompletionArgs()).toMatchObject({
      model: { provider: "openai", id: "gpt-test" },
      auth: { apiKey: "resolved-key", mode: "api-key" },
      cfg,
      context: {
        systemPrompt: "Generate a label",
        messages: [
          {
            role: "user",
            content: "Need help with invoices",
            timestamp: 1_710_000_000_000,
          },
        ],
      },
      options: {
        maxTokens: 4_096,
        temperature: 0.3,
      },
    });
    expect(firstCompletionArgs().options.signal).toBeInstanceOf(AbortSignal);
  });

  it("caps the completion budget at the model output limit", async () => {
    prepareSimpleCompletionModelForAgent.mockResolvedValue({
      selection: {
        provider: "openai",
        modelId: "gpt-test",
        agentDir: "/tmp/openclaw-agent",
      },
      model: { provider: "openai", id: "gpt-test", maxTokens: 1_024 },
      auth: { apiKey: "resolved-key", mode: "api-key" },
    });

    await generateConversationLabel({
      userMessage: "test topic creation",
      prompt: "Generate a label",
      cfg: {},
    });

    expect(firstCompletionArgs().options.maxTokens).toBe(1_024);
  });

  it("omits temperature for Codex Responses simple completions", async () => {
    prepareSimpleCompletionModelForAgent.mockResolvedValue({
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        agentDir: "/tmp/openclaw-agent",
      },
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        maxTokens: 8192,
      },
      auth: { apiKey: "resolved-key", mode: "api-key" },
    });

    await generateConversationLabel({
      userMessage: "test topic creation",
      prompt: "Generate a label",
      cfg: {},
    });

    expect(firstCompletionArgs().options).not.toHaveProperty("temperature");
  });

  it("returns null when utility model preparation fails", async () => {
    prepareSimpleCompletionModelForAgent.mockResolvedValue({
      error: 'No API key resolved for provider "openai".',
    });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
      }),
    ).resolves.toBeNull();

    expect(logVerbose).toHaveBeenCalledWith(
      'conversation-label-generator: No API key resolved for provider "openai".',
    );
    expect(completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("logs completion errors instead of treating them as empty labels", async () => {
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
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

  it("bounds the generated label length", async () => {
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "A very long generated topic label" }],
    });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
        maxLength: 12,
      }),
    ).resolves.toBe("A very long ");
  });

  it("drops a split emoji instead of returning a lone surrogate", async () => {
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: `${"a".repeat(11)}😀tail` }],
    });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
        maxLength: 12,
      }),
    ).resolves.toBe("a".repeat(11));
  });

  it("returns null when the length cap cannot retain the first emoji", async () => {
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "😀 label" }],
    });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
        maxLength: 1,
      }),
    ).resolves.toBeNull();
  });
});
