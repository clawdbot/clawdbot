import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function augmentConfiguredLmstudioCompat(compat: Record<string, unknown>) {
  const provider = capturePluginRegistration(plugin).providers[0];
  const config = {
    models: {
      providers: {
        lmstudio: {
          models: [{ id: "qwen3-8b-instruct", compat }],
        },
      },
    },
  } as unknown as OpenClawConfig;

  expect(provider?.id).toBe("lmstudio");
  return provider?.augmentModelCatalog?.({
    config,
    agentDir: "/tmp/openclaw",
    env: {},
    entries: [],
  });
}

describe("LM Studio configured model tool capabilities", () => {
  it.each([
    { label: "enabled", supportsTools: true },
    { label: "disabled", supportsTools: false },
    { label: "unknown", supportsTools: undefined },
  ])("preserves $label tool support during provider catalog augmentation", ({ supportsTools }) => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const config = {
      models: {
        providers: {
          lmstudio: {
            models: [
              {
                id: "qwen3-8b-instruct",
                compat: {
                  ...(supportsTools === undefined ? {} : { supportsTools }),
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: ["off", "on"],
                  reasoningEffortMap: { off: "off", high: "on" },
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(provider?.id).toBe("lmstudio");
    expect(
      provider?.augmentModelCatalog?.({
        config,
        agentDir: "/tmp/openclaw",
        env: {},
        entries: [],
      }),
    ).toEqual([
      {
        provider: "lmstudio",
        id: "qwen3-8b-instruct",
        name: "qwen3-8b-instruct",
        compat: {
          supportsUsageInStreaming: true,
          ...(supportsTools === undefined ? {} : { supportsTools }),
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: {
            off: "none",
            none: "none",
            adaptive: "xhigh",
            max: "xhigh",
          },
        },
        contextWindow: undefined,
        contextTokens: undefined,
        reasoning: undefined,
        input: undefined,
      },
    ]);
  });

  it.each([
    {
      label: "all schema-approved compatibility fields",
      configuredCompat: {
        supportsStore: false,
        supportsPromptCacheKey: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsTemperature: false,
        supportsUsageInStreaming: false,
        supportsTools: false,
        supportsStrictMode: false,
        supportsJsonSchemaResponseFormat: false,
        requiresStringContent: true,
        strictMessageKeys: true,
        visibleReasoningDetailTypes: ["reasoning.summary"],
        supportedReasoningEfforts: ["low", "high"],
        reasoningEffortMap: { off: "none", high: "high" },
        maxTokensField: "max_tokens",
        thinkingFormat: "qwen",
        requiresToolResultName: true,
        requiresAssistantAfterToolResult: true,
        requiresThinkingAsText: true,
        requiresReasoningContentOnAssistantMessages: true,
        toolSchemaProfile: "lmstudio",
        unsupportedToolSchemaKeywords: ["additionalProperties"],
        toolCallArgumentsEncoding: "string",
        requiresOpenAiAnthropicToolPayload: true,
      },
      expectedOverride: { supportsUsageInStreaming: true },
    },
    {
      label: "explicit false flags and empty schema-approved lists",
      configuredCompat: {
        supportsStore: false,
        supportsPromptCacheKey: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsTemperature: false,
        supportsUsageInStreaming: false,
        supportsTools: false,
        supportsStrictMode: false,
        supportsJsonSchemaResponseFormat: false,
        requiresStringContent: false,
        strictMessageKeys: false,
        visibleReasoningDetailTypes: [],
        maxTokensField: "max_completion_tokens",
        thinkingFormat: "qwen-chat-template",
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: false,
        toolSchemaProfile: "",
        unsupportedToolSchemaKeywords: [],
        toolCallArgumentsEncoding: "",
        requiresOpenAiAnthropicToolPayload: false,
      },
      expectedOverride: { supportsUsageInStreaming: true },
    },
  ])(
    "preserves $label through the registered provider catalog",
    async ({ configuredCompat, expectedOverride }) => {
      const entries = await augmentConfiguredLmstudioCompat(configuredCompat);

      if (!Array.isArray(entries)) {
        throw new Error("Expected LM Studio provider catalog augmentation to return model entries");
      }

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        provider: "lmstudio",
        id: "qwen3-8b-instruct",
      });
      expect(entries[0]?.compat).toEqual({ ...configuredCompat, ...expectedOverride });
    },
  );
});
