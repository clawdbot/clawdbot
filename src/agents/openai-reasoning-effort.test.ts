import { describe, expect, it } from "vitest";
import {
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAISupportedReasoningEfforts,
} from "./openai-reasoning-effort.js";

describe("OpenAI reasoning effort support", () => {
  it.each([
    { provider: "openai", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.5" },
  ])("preserves xhigh for $provider/$id", (model) => {
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("xhigh");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });

  it("preserves reasoning_effort metadata for gpt-5.4-mini in Chat Completions", () => {
    const model = { provider: "openai", id: "gpt-5.4-mini", api: "openai-completions" };
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("medium");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "medium" })).toBe("medium");
  });

  it("preserves reasoning_effort for gpt-5.4-mini in Responses", () => {
    const model = { provider: "openai", id: "gpt-5.4-mini", api: "openai-responses" };
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("medium");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "medium" })).toBe("medium");
  });

  it("does not downgrade xhigh when Pi compat metadata declares it explicitly", () => {
    const model = {
      provider: "openai-codex",
      id: "gpt-5.5",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });

  it("allows provider-native compat values when explicitly declared", () => {
    const model = {
      provider: "groq",
      id: "qwen/qwen3-32b",
      compat: {
        supportedReasoningEfforts: ["none", "default"],
        reasoningEffortMap: {
          off: "none",
          low: "default",
          medium: "default",
          high: "default",
        },
      },
    };

    expect(resolveOpenAISupportedReasoningEfforts(model)).toEqual(["none", "default"]);
    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "medium",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("default");
    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "off",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("none");
  });

  it("omits unsupported disabled reasoning instead of falling back to enabled effort", () => {
    expect(
      resolveOpenAIReasoningEffortForModel({
        model: { provider: "groq", id: "openai/gpt-oss-120b" },
        effort: "off",
      }),
    ).toBeUndefined();
  });

  it("honors compat metadata that disables reasoning effort payloads", () => {
    const model = {
      provider: "xai",
      id: "grok-4.20-beta-latest-reasoning",
      compat: { supportsReasoningEffort: false },
    };

    expect(resolveOpenAISupportedReasoningEfforts(model)).toEqual([]);
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "high" })).toBeUndefined();
  });

  it("does not turn disabled reasoning into a fallback effort when compat omits none", () => {
    const model = {
      provider: "xai",
      id: "grok-4.3",
      compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "none" })).toBeUndefined();
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "high" })).toBe("high");
  });
});
