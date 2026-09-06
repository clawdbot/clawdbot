import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertMessages } from "../../packages/ai/src/openai-completions-messages.js";
import { streamSimpleAnthropic } from "../../packages/ai/src/providers/anthropic.js";
import { extractToolResultText } from "../../packages/ai/src/providers/tool-result-text.js";
import { resolveOpenAICompletionsCompat } from "../../packages/ai/src/transports/openai-completions-compat.js";
import type { Context, Model } from "../../packages/ai/src/types.js";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import { createOpenClawReadTool } from "../agents/agent-tools.read.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
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
      jsonSource: '{"token":"timeObserverToken"}',
      api_key: "provider-secret-value",
    },
  ];

  it("preserves source assignments while masking structured credentials", () => {
    const text = extractToolResultText(toolResultContent);

    expect(text).toContain("if let token = timeObserverToken {");
    expect(text).toContain(String.raw`\"token\":\"timeObserverToken\"`);
    expect(text).not.toContain("provider-secret-value");
  });

  it("carries the redacted result into Anthropic and OpenAI-compatible payloads", async () => {
    const configCredential = "unquoted-provider-config-credential-1234567890";
    const envCredential = "provider-env-credential-1234567890";
    const sourceLines = [
      "API_TOKEN = computeToken()",
      "API_KEY: str = computeKey()",
      "api_key: ConfigValue",
    ];
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_toolCallId, args: { path: string }) => {
        const text = args.path.endsWith(".yaml")
          ? `api_key: ${configCredential}`
          : args.path.endsWith(".env")
            ? `API_KEY=${envCredential}`
            : sourceLines.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { kind: "text", content: text },
        };
      },
    });
    const configResult = await readTool.execute("read-config", { path: "settings.yaml" });
    const envResult = await readTool.execute("read-env", { path: "production.env" });
    const sourceResult = await readTool.execute("read-source", { path: "settings.py" });
    const providerText = [
      extractToolResultText(toolResultContent),
      extractToolResultText(configResult.content),
      extractToolResultText(envResult.content),
      extractToolResultText(sourceResult.content),
    ].join("\n");
    const context: Context = {
      messages: [
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-test",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          usage: createZeroUsageFixture(),
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
      expect(serialized).toContain(String.raw`\\\"token\\\":\\\"timeObserverToken\\\"`);
      for (const sourceLine of sourceLines) {
        expect(serialized).toContain(sourceLine);
      }
      expect(serialized).not.toContain("provider-secret-value");
      expect(serialized).toContain(configCredential);
      expect(serialized).not.toContain(envCredential);
    }
  });
});
