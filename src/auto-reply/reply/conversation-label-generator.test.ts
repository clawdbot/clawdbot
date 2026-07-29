/** Tests generated conversation labels for reply sessions. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());
const logVerbose = vi.hoisted(() => vi.fn());
const prepareSimpleCompletionModelForAgent = vi.hoisted(() => vi.fn());
const resolveSimpleCompletionSelectionForAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
  resolveSimpleCompletionSelectionForAgent,
}));

vi.mock("../../globals.js", () => ({ logVerbose }));

import {
  generateConversationLabel,
  generateConversationLabelWithFallback,
} from "./conversation-label-generator.js";

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

  it("falls back to the primary model when utility model preparation fails", async () => {
    prepareSimpleCompletionModelForAgent
      .mockResolvedValueOnce({
        error: 'No API key resolved for provider "openai".',
        selection: {
          provider: "openai",
          modelId: "gpt-5.6-luna",
          agentDir: "/tmp/openclaw-agent",
        },
      })
      .mockResolvedValueOnce({
        selection: {
          provider: "openai",
          modelId: "gpt-5.6-sol",
          agentDir: "/tmp/openclaw-agent",
        },
        model: { provider: "openai", id: "gpt-5.6-sol", maxTokens: 8192 },
        auth: { apiKey: "test-api-key", mode: "api-key" },
      });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
      }),
    ).resolves.toBe("Topic label");

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ useUtilityModel: false }),
    );
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
  });

  it("falls back to the primary model when the utility completion fails", async () => {
    prepareSimpleCompletionModelForAgent
      .mockResolvedValueOnce({
        selection: {
          provider: "openai",
          modelId: "gpt-5.6-luna",
          agentDir: "/tmp/openclaw-agent",
        },
        model: { provider: "openai", id: "gpt-5.6-luna", maxTokens: 8192 },
        auth: { apiKey: "test-api-key", mode: "oauth" },
      })
      .mockResolvedValueOnce({
        selection: {
          provider: "openai",
          modelId: "gpt-5.6-sol",
          agentDir: "/tmp/openclaw-agent",
        },
        model: { provider: "openai", id: "gpt-5.6-sol", maxTokens: 8192 },
        auth: { apiKey: "test-api-key", mode: "oauth" },
      });
    completeWithPreparedSimpleCompletionModel
      .mockResolvedValueOnce({
        content: [],
        stopReason: "error",
        errorMessage: "utility unavailable",
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Primary title" }] });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
      }),
    ).resolves.toBe("Primary title");

    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(2);
  });

  it("does not call the same primary model twice when utility routing resolves to it", async () => {
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "primary unavailable",
    });

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg: {},
      }),
    ).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledTimes(2);
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
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

describe("generateConversationLabelWithFallback", () => {
  const params = {
    userMessage: "Need help with invoices",
    prompt: "Generate a label",
    cfg: {},
    agentId: "billing",
    utilityModelRef: "openai/gpt-mini@work",
    regularModelRef: "openai/gpt-main@work",
    preferredProfile: "work",
  };

  beforeEach(() => {
    completeWithPreparedSimpleCompletionModel.mockReset();
    logVerbose.mockReset();
    prepareSimpleCompletionModelForAgent.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockImplementation(({ modelRef }) => {
      const [model, profileId] = modelRef.split("@");
      const slash = model.indexOf("/");
      return {
        provider: model.slice(0, slash),
        modelId: model.slice(slash + 1),
        profileId,
        agentDir: "/tmp/openclaw-agent",
      };
    });
    prepareSimpleCompletionModelForAgent.mockImplementation(async ({ modelRef }) => {
      const [model] = modelRef.split("@");
      const slash = model.indexOf("/");
      return {
        selection: {
          provider: model.slice(0, slash),
          modelId: model.slice(slash + 1),
          profileId: "work",
          agentDir: "/tmp/openclaw-agent",
        },
        model: {
          provider: model.slice(0, slash),
          id: model.slice(slash + 1),
          maxTokens: 8192,
        },
        auth: { apiKey: "resolved-key", mode: "api-key" },
      };
    });
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "Utility title" }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the utility candidate once with the selected auth owner", async () => {
    await expect(generateConversationLabelWithFallback(params)).resolves.toBe("Utility title");

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith({
      cfg: {},
      agentId: "billing",
      agentDir: undefined,
      modelRef: "openai/gpt-mini@work",
      bindAuthOwner: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("locks an inherited profile onto a same-provider utility ref", async () => {
    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "openai/gpt-mini",
      }),
    ).resolves.toBe("Utility title");

    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).toMatchObject({
      modelRef: "openai/gpt-mini@work",
      bindAuthOwner: true,
    });
    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).not.toHaveProperty(
      "preferredProfile",
    );
  });

  it("does not force the regular profile onto a cross-provider utility model", async () => {
    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "anthropic/claude-haiku-4-5",
      }),
    ).resolves.toBe("Utility title");

    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).toEqual({
      cfg: {},
      agentId: "billing",
      agentDir: undefined,
      modelRef: "anthropic/claude-haiku-4-5",
      bindAuthOwner: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("does not inherit profiles across logical providers sharing one runtime", async () => {
    resolveSimpleCompletionSelectionForAgent.mockImplementation(({ modelRef }) => ({
      provider: modelRef.startsWith("anthropic/") ? "anthropic" : "openai",
      runtimeProvider: "openai",
      modelId: modelRef.split("/").slice(1).join("/"),
      agentDir: "/tmp/openclaw-agent",
    }));

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "anthropic/claude-haiku-4-5",
      }),
    ).resolves.toBe("Utility title");

    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).not.toHaveProperty(
      "preferredProfile",
    );
    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]?.modelRef).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("falls back when utility preparation fails", async () => {
    prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({ error: "missing auth" });
    completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: "Regular title" }],
    });

    await expect(generateConversationLabelWithFallback(params)).resolves.toBe("Regular title");

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledTimes(2);
    expect(prepareSimpleCompletionModelForAgent.mock.calls[1]?.[0]?.modelRef).toBe(
      "openai/gpt-main@work",
    );
  });

  it.each([
    {
      name: "error stop reason",
      first: { content: [], stopReason: "error", errorMessage: "utility failed" },
    },
    { name: "empty output", first: { content: [] } },
  ])("falls back after utility $name", async ({ first }) => {
    completeWithPreparedSimpleCompletionModel
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Regular title" }] });

    await expect(generateConversationLabelWithFallback(params)).resolves.toBe("Regular title");

    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(2);
  });

  it("falls back when utility output fails operation-specific normalization", async () => {
    completeWithPreparedSimpleCompletionModel
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Title:" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Regular title" }] });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        normalizeLabel: (label) => (label === "Title:" ? null : label),
      }),
    ).resolves.toBe("Regular title");
  });

  it("falls back after a utility completion exception", async () => {
    completeWithPreparedSimpleCompletionModel
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Regular title" }] });

    await expect(generateConversationLabelWithFallback(params)).resolves.toBe("Regular title");
  });

  it("falls back after the utility attempt times out", async () => {
    vi.useFakeTimers();
    completeWithPreparedSimpleCompletionModel
      .mockImplementationOnce(
        ({ options }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      )
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Regular title" }] });

    const generated = generateConversationLabelWithFallback(params);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(generated).resolves.toBe("Regular title");
  });

  it("returns null when both explicit candidates fail", async () => {
    prepareSimpleCompletionModelForAgent
      .mockResolvedValueOnce({ error: "utility auth failed" })
      .mockResolvedValueOnce({ error: "regular auth failed" });

    await expect(generateConversationLabelWithFallback(params)).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledTimes(2);
    expect(completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("skips a regular candidate that resolves to the same model and profile", async () => {
    resolveSimpleCompletionSelectionForAgent.mockReturnValue({
      provider: "openai",
      modelId: "same-model",
      profileId: "work",
      agentDir: "/tmp/openclaw-agent",
    });
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({ content: [] });

    await expect(generateConversationLabelWithFallback(params)).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
  });

  it("deduplicates candidates after asynchronous preparation resolves them identically", async () => {
    prepareSimpleCompletionModelForAgent.mockResolvedValue({
      selection: {
        provider: "openai",
        modelId: "resolved-same-model",
        profileId: "work",
        agentDir: "/tmp/openclaw-agent",
      },
      model: { provider: "openai", id: "resolved-same-model", maxTokens: 8192 },
      auth: { apiKey: "resolved-key", mode: "api-key" },
    });
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({ content: [] });

    await expect(generateConversationLabelWithFallback(params)).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledTimes(2);
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
  });

  it("inherits the regular profile for unresolved same-provider utility refs", async () => {
    resolveSimpleCompletionSelectionForAgent.mockReturnValue(null);

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "openai/gpt-mini",
      }),
    ).resolves.toBe("Utility title");

    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).toMatchObject({
      modelRef: "openai/gpt-mini@work",
      bindAuthOwner: true,
    });
    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).not.toHaveProperty(
      "preferredProfile",
    );
  });

  it("does not inherit the regular profile for unresolved cross-provider utility refs", async () => {
    resolveSimpleCompletionSelectionForAgent.mockReturnValue(null);

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "anthropic/claude-haiku-4-5",
      }),
    ).resolves.toBe("Utility title");

    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]).not.toHaveProperty(
      "preferredProfile",
    );
  });

  it("deduplicates identical raw refs when selection resolution is unavailable", async () => {
    resolveSimpleCompletionSelectionForAgent.mockReturnValue(null);
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({ content: [] });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: params.regularModelRef,
      }),
    ).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
  });

  it("uses the regular candidate directly when no utility model is available", async () => {
    const { utilityModelRef: _utilityModelRef, ...regularOnlyParams } = params;

    await expect(generateConversationLabelWithFallback(regularOnlyParams)).resolves.toBe(
      "Utility title",
    );

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
    expect(prepareSimpleCompletionModelForAgent.mock.calls[0]?.[0]?.modelRef).toBe(
      "openai/gpt-main@work",
    );
  });
});
