import { afterEach, describe, expect, it } from "vitest";
import { convertMessages } from "../../packages/ai/src/openai-completions-messages.js";
import { streamSimpleAnthropic } from "../../packages/ai/src/providers/anthropic.js";
import { extractToolResultText } from "../../packages/ai/src/providers/tool-result-text.js";
import { resolveOpenAICompletionsCompat } from "../../packages/ai/src/transports/openai-completions-compat.js";
import type { Context, Model } from "../../packages/ai/src/types.js";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import "./ai-transport-host.js";

afterEach(resetSecretRedactionRegistryForTest);

describe("OpenClaw provider error redaction", () => {
  it("redacts registered opaque secrets from ordinary provider error messages", () => {
    const secret = "opaque-configured-provider-value";
    registerSecretValueForRedaction(secret);

    const projected = projectProviderError({
      message: `provider rejected configured value ${secret}`,
    });

    expect(projected.errorMessage).toContain("provider rejected configured value");
    expect(projected.errorMessage).not.toContain(secret);
  });
});

describe("OpenClaw provider tool-result redaction", () => {
  const toolResultContent = [
    {
      type: "resource" as const,
      source: "if let token = timeObserverToken {",
      api_key: "provider-secret-value",
    },
  ];

  it("preserves source assignments while masking structured credentials", () => {
    const text = extractToolResultText(toolResultContent);

    expect(text).toContain("if let token = timeObserverToken {");
    expect(text).not.toContain("provider-secret-value");
  });

  it("carries the redacted result into Anthropic and OpenAI-compatible payloads", async () => {
    const providerText = extractToolResultText(toolResultContent);
    const context: Context = {
      messages: [
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-test",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: providerText }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    const anthropicModel = {
      id: "claude-test",
      name: "Claude test",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_024,
    } satisfies Model<"anthropic-messages">;
    let anthropicPayload: unknown;
    const stream = streamSimpleAnthropic(anthropicModel, context, {
      apiKey: "test-provider-key",
      reasoning: "off",
      onPayload: (payload) => {
        anthropicPayload = payload;
        throw new Error("payload captured");
      },
    });
    await stream.result();

    const openAiModel = {
      ...anthropicModel,
      id: "openai-compatible-test",
      name: "OpenAI-compatible test",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    } satisfies Model<"openai-completions">;
    const openAiPayload = convertMessages(
      openAiModel,
      context,
      resolveOpenAICompletionsCompat(openAiModel),
    );

    for (const payload of [anthropicPayload, openAiPayload]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).toContain("if let token = timeObserverToken {");
      expect(serialized).not.toContain("provider-secret-value");
    }
  });
});
