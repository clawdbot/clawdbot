import { describe, expect, it } from "vitest";
import {
  resolveMergedModelProviderModels,
  resolveModelProviderRouteOverridePresence,
} from "./model-provider-config.js";
import type { ModelDefinitionConfig } from "./types.models.js";

function model(id: string, fields: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return { id, ...fields } as ModelDefinitionConfig;
}

describe("resolveMergedModelProviderModels", () => {
  it("keeps first-row fields and fills only omissions from canonical duplicates", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("openai/gpt-5.5", {
          api: "openai-responses",
          headers: {},
        }),
        model("gpt-5.5", {
          api: "openai-completions",
          baseUrl: "https://relay.example.test/v1",
          headers: { "x-route": "custom" },
          params: { azureApiVersion: "2025-01-01" },
        }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")).toEqual({
      id: "openai/gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      headers: {},
      params: { azureApiVersion: "2025-01-01" },
    });
  });

  it("fills headers when the first canonical row omits them", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("gpt-5.5", { api: "openai-responses" }),
        model("openai/gpt-5.5", { headers: { "x-route": "custom" } }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")?.headers).toEqual({ "x-route": "custom" });
  });
});

describe("resolveModelProviderRouteOverridePresence", () => {
  it.each([
    ["empty metadata", {}, "none"],
    ["affirmative reasoning support", { supportsReasoningEffort: true }, "none"],
    [
      "native reasoning efforts",
      { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      "none",
    ],
    [
      "combined reasoning metadata",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] },
      "none",
    ],
    ["disabled reasoning", { supportsReasoningEffort: false }, "present"],
    ["malformed reasoning support", { supportsReasoningEffort: "true" }, "present"],
    ["empty effort list", { supportedReasoningEfforts: [] }, "present"],
    ["non-native effort", { supportedReasoningEfforts: ["high", "custom"] }, "present"],
    ["disabled effort", { supportedReasoningEfforts: ["none"] }, "present"],
    ["malformed effort", { supportedReasoningEfforts: ["high", false] }, "present"],
    ["store behavior", { supportsStore: false }, "present"],
    [
      "mixed metadata and behavior",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["high"], supportsStore: false },
      "present",
    ],
  ])("classifies %s without discarding request behavior", (_label, compat, expected) => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.6-sol", compat }],
          },
        },
      },
    } as never;

    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        authoredConfig: config,
      }),
    ).toBe(expected);
  });

  it("treats a provider request timeout as authored behavior", () => {
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.5",
        authoredConfig: {
          models: {
            providers: {
              openai: { baseUrl: "", timeoutSeconds: 90, models: [model("gpt-5.5")] },
            },
          },
        },
      }),
    ).toBe("present");
  });
});
