// Verifies model-specific OpenAI reasoning-effort normalization and disablement.
import { describe, expect, it } from "vitest";
import {
  isOpenAIGpt56Model,
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAISupportedReasoningEfforts,
  supportsOpenAIReasoningEffort,
  supportsOpenAITemperature,
} from "./openai-reasoning-effort.js";

describe("OpenAI reasoning effort support", () => {
  it("recognizes GPT-5.6 model ids and deployment names", () => {
    expect(isOpenAIGpt56Model({ id: "gpt-5.6-luna" })).toBe(true);
    expect(isOpenAIGpt56Model({ id: "prod-luna", name: "GPT-5.6 (Azure)" })).toBe(true);
    expect(isOpenAIGpt56Model({ id: "gpt-5.5" })).toBe(false);
  });

  it("preserves disabled and max effort for the GPT-5.6 series", () => {
    const sol = { provider: "openai", id: "gpt-5.6-sol" };
    const terra = { provider: "openai", id: "gpt-5.6-terra" };
    const luna = { provider: "openai", id: "gpt-5.6-luna" };

    expect(resolveOpenAIReasoningEffortForModel({ model: sol, effort: "max" })).toBe("max");
    expect(resolveOpenAIReasoningEffortForModel({ model: terra, effort: "max" })).toBe("max");
    expect(resolveOpenAIReasoningEffortForModel({ model: luna, effort: "max" })).toBe("max");
    expect(resolveOpenAIReasoningEffortForModel({ model: sol, effort: "off" })).toBe("none");
    expect(resolveOpenAIReasoningEffortForModel({ model: terra, effort: "none" })).toBe("none");
    expect(resolveOpenAIReasoningEffortForModel({ model: luna, effort: "off" })).toBe("none");
  });

  it.each([
    { provider: "openai", id: "gpt-5.5" },
    { provider: "openai", id: "gpt-5.5" },
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

  it("matches canonical reasoning efforts case-insensitively", () => {
    const model = { provider: "openai", id: "gpt-5.6-sol" };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "HIGH" })).toBe("high");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: " XHIGH " })).toBe("xhigh");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "MAX" })).toBe("max");
  });

  it("does not downgrade xhigh when model compat metadata declares it explicitly", () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });

  it("allows provider-native compat values when explicitly declared", () => {
    // Some OpenAI-compatible providers expose their own reasoning effort labels.
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

  it("preserves provider-native compat values mapped from canonical efforts", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["ProviderDefault"],
        reasoningEffortMap: {
          high: "ProviderDefault",
        },
      },
    };

    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "HIGH",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("ProviderDefault");
  });

  it("matches canonical fallback map keys case-insensitively", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
        reasoningEffortMap: {
          HIGH: "ProviderHigh",
        },
      },
    };

    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "HIGH",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("ProviderHigh");
  });

  it("preserves canonical-looking provider-native compat values mapped from canonical efforts", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["LOW", "MEDIUM", "HIGH"],
        reasoningEffortMap: {
          high: "HIGH",
        },
      },
    };

    expect(resolveOpenAISupportedReasoningEfforts(model)).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "HIGH",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("HIGH");
  });

  it("requires an explicit map for canonical-looking provider casing", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["NONE", "HIGH"],
      },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "none" })).toBeUndefined();
    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "none",
        fallbackMap: { none: "NONE" },
      }),
    ).toBe("NONE");
  });

  it("does not fold provider-native compat values", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["ProviderDefault"],
      },
    };

    expect(supportsOpenAIReasoningEffort(model, "ProviderDefault")).toBe(true);
    expect(supportsOpenAIReasoningEffort(model, "providerdefault")).toBe(false);
  });

  it("omits unsupported disabled reasoning instead of falling back to enabled effort", () => {
    const model = { provider: "groq", id: "openai/gpt-oss-120b" };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "off" })).toBeUndefined();
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "OFF" })).toBeUndefined();
  });

  it("honors compat metadata that disables reasoning effort payloads", () => {
    const model = {
      provider: "xai",
      id: "grok-4.20-0309-reasoning",
      compat: { supportsReasoningEffort: false },
    };

    expect(resolveOpenAISupportedReasoningEfforts(model)).toEqual([]);
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "high" })).toBeUndefined();
  });

  it("passes disabled reasoning when xAI compat explicitly supports none", () => {
    const model = {
      provider: "xai",
      id: "grok-4.3",
      compat: { supportedReasoningEfforts: ["none", "low", "medium", "high"] },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "none" })).toBe("none");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "high" })).toBe("high");
  });
});

describe("OpenAI temperature support", () => {
  it("rejects temperature for the GPT-5.6 family, including dated snapshots", () => {
    expect(supportsOpenAITemperature({ id: "gpt-5.6" })).toBe(false);
    expect(supportsOpenAITemperature({ id: "gpt-5.6-luna" })).toBe(false);
    expect(supportsOpenAITemperature({ id: "gpt-5.6-terra-2026-04-01" })).toBe(false);
  });

  it("keeps temperature for earlier families and generic models", () => {
    expect(supportsOpenAITemperature({ id: "gpt-5.5" })).toBe(true);
    expect(supportsOpenAITemperature({ id: "gpt-5.4-mini" })).toBe(true);
    expect(supportsOpenAITemperature({ id: "gpt-5.60" })).toBe(true);
    expect(supportsOpenAITemperature({ id: "llama-4-70b" })).toBe(true);
  });

  it("honors catalog compat overrides in both directions", () => {
    expect(
      supportsOpenAITemperature({ id: "gpt-5.6-luna", compat: { supportsTemperature: true } }),
    ).toBe(true);
    expect(
      supportsOpenAITemperature({ id: "gpt-5.5", compat: { supportsTemperature: false } }),
    ).toBe(false);
  });
});
