/** Tests generated conversation labels for reply sessions. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runIsolatedCompletion = vi.hoisted(() => vi.fn());
const resolveSimpleCompletionSelectionForAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion }));
vi.mock("../../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent,
}));

import {
  generateConversationLabel,
  generateConversationLabelWithFallback,
} from "./conversation-label-generator.js";

function resolveSelection({ modelRef, useUtilityModel, agentDir }: Record<string, unknown>) {
  const ref =
    typeof modelRef === "string"
      ? modelRef
      : useUtilityModel
        ? "openai/gpt-mini@work"
        : "openai/gpt-main@work";
  const [rawModel, profileId] = ref.split("@");
  const model = rawModel ?? "";
  const slash = model.indexOf("/");
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
    profileId,
    agentDir: typeof agentDir === "string" ? agentDir : "/tmp/openclaw-agent",
  };
}

describe("generateConversationLabel", () => {
  beforeEach(() => {
    runIsolatedCompletion.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockImplementation(resolveSelection);
    runIsolatedCompletion.mockResolvedValue({ text: "Topic label" });
  });

  it("routes the utility model through isolated completion with the selected auth owner", async () => {
    const cfg = { agents: { defaults: { utilityModel: "openai/gpt-mini" } } };

    await expect(
      generateConversationLabel({
        userMessage: "Need help with invoices",
        prompt: "Generate a label",
        cfg,
        agentId: "billing",
        agentDir: "/tmp/agents/billing/agent",
      }),
    ).resolves.toBe("Topic label");

    expect(runIsolatedCompletion).toHaveBeenCalledWith({
      config: cfg,
      provider: "openai",
      model: "gpt-mini",
      authProfileId: "work",
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
      systemPrompt: "Generate a label",
      prompt: "Need help with invoices",
      timeoutMs: 15_000,
      streamParams: { maxTokens: 4_096 },
    });
  });

  it("uses one explicit model and timeout when supplied", async () => {
    await generateConversationLabel({
      userMessage: "Message",
      prompt: "Prompt",
      cfg: {},
      modelRef: "anthropic/claude-haiku@team",
      timeoutMs: 900,
    });

    expect(runIsolatedCompletion).toHaveBeenCalledOnce();
    expect(runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku",
        authProfileId: "team",
        timeoutMs: 900,
      }),
    );
  });

  it("falls back to the primary after a utility failure", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(new Error("utility unavailable"))
      .mockResolvedValueOnce({ text: "Primary title" });

    await expect(
      generateConversationLabel({ userMessage: "Message", prompt: "Prompt", cfg: {} }),
    ).resolves.toBe("Primary title");

    expect(runIsolatedCompletion).toHaveBeenCalledTimes(2);
    expect(runIsolatedCompletion.mock.calls[1]?.[0]?.model).toBe("gpt-main");
  });

  it("throws a sanitized error after every configured attempt fails", async () => {
    runIsolatedCompletion.mockRejectedValue(new Error("secret-bearing provider failure"));

    await expect(
      generateConversationLabel({ userMessage: "Message", prompt: "Prompt", cfg: {} }),
    ).rejects.toThrow("conversation label generation failed (utility, primary fallback)");
  });

  it("deduplicates utility and primary when they resolve to the same owner", async () => {
    resolveSimpleCompletionSelectionForAgent.mockReturnValue({
      provider: "openai",
      modelId: "same-model",
      profileId: "work",
      agentDir: "/tmp/openclaw-agent",
    });
    runIsolatedCompletion.mockResolvedValue({ text: "" });

    await expect(
      generateConversationLabel({ userMessage: "Message", prompt: "Prompt", cfg: {} }),
    ).resolves.toBeNull();
    expect(runIsolatedCompletion).toHaveBeenCalledOnce();
  });

  it("bounds labels without splitting surrogate pairs", async () => {
    runIsolatedCompletion.mockResolvedValue({ text: `${"a".repeat(11)}😀tail` });

    await expect(
      generateConversationLabel({
        userMessage: "Message",
        prompt: "Prompt",
        cfg: {},
        maxLength: 12,
      }),
    ).resolves.toBe("a".repeat(11));
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
    runIsolatedCompletion.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockImplementation(resolveSelection);
    runIsolatedCompletion.mockResolvedValue({ text: "Utility title" });
  });

  it("uses the utility candidate once", async () => {
    await expect(generateConversationLabelWithFallback(params)).resolves.toBe("Utility title");
    expect(runIsolatedCompletion).toHaveBeenCalledOnce();
    expect(runIsolatedCompletion.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-mini",
      authProfileId: "work",
    });
  });

  it("locks an inherited profile onto a same-provider utility ref", async () => {
    await generateConversationLabelWithFallback({ ...params, utilityModelRef: "openai/gpt-mini" });

    expect(resolveSimpleCompletionSelectionForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modelRef: "openai/gpt-mini@work" }),
    );
    expect(runIsolatedCompletion.mock.calls[0]?.[0]?.authProfileId).toBe("work");
  });

  it("does not inherit a profile across providers", async () => {
    await generateConversationLabelWithFallback({
      ...params,
      utilityModelRef: "anthropic/claude-haiku",
    });

    expect(runIsolatedCompletion.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku",
    });
    expect(runIsolatedCompletion.mock.calls[0]?.[0]?.authProfileId).toBeUndefined();
  });

  it("records an exhausted failure after fallback normalization rejects the result", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(new Error("utility unavailable"))
      .mockResolvedValueOnce({ text: "Title:" });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        normalizeLabel: (label) => (label === "Title:" ? null : label),
      }),
    ).rejects.toThrow("conversation label generation failed (utility)");
    expect(runIsolatedCompletion).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit runtime owner across utility and primary attempts", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(new Error("utility unavailable"))
      .mockResolvedValueOnce({ text: "Primary title" });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        agentHarnessRuntimeOverride: "codex",
      }),
    ).resolves.toBe("Primary title");

    expect(
      runIsolatedCompletion.mock.calls.map(([request]) => request.agentHarnessRuntimeOverride),
    ).toEqual(["codex", "codex"]);
  });

  it("uses the regular candidate directly when no utility model exists", async () => {
    const { utilityModelRef: _utilityModelRef, ...regularOnlyParams } = params;
    await generateConversationLabelWithFallback(regularOnlyParams);
    expect(runIsolatedCompletion.mock.calls[0]?.[0]?.model).toBe("gpt-main");
  });
});
