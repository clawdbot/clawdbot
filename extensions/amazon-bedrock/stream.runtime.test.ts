// Amazon Bedrock tests cover stream plugin behavior.
import { describe, expect, it } from "vitest";
import { testing } from "./stream.runtime.js";

function bedrockModel(overrides: Record<string, unknown>) {
  return {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    id: "amazon.nova-micro-v1:0",
    name: "Nova Micro",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as never;
}

function signedThinkingContext(modelId: string) {
  const highSurrogate = String.fromCharCode(0xd83d);
  return {
    messages: [
      {
        role: "assistant",
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: modelId,
        content: [
          {
            type: "thinking",
            thinking: `private${highSurrogate}reasoning`,
            thinkingSignature: "sig-1",
          },
        ],
      },
    ],
  } as never;
}

describe("Bedrock reasoning replay", () => {
  it("preserves signed reasoning for Claude profile descriptors", () => {
    const modelId =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc";
    const messages = testing.convertMessages(
      signedThinkingContext(modelId),
      bedrockModel({
        id: modelId,
        name: "Claude Sonnet application profile",
      }),
      "none",
    );

    expect(messages[0]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: {
            text: `private${String.fromCharCode(0xd83d)}reasoning`,
            signature: "sig-1",
          },
        },
      },
    ]);
  });

  it("replays signed reasoning as plain text for non-Claude models", () => {
    const modelId = "amazon.nova-micro-v1:0";
    const messages = testing.convertMessages(
      signedThinkingContext(modelId),
      bedrockModel({ id: modelId, name: "Nova Micro" }),
      "none",
    );

    expect(messages[0]?.content).toEqual([{ text: "privatereasoning" }]);
  });
});

describe("Bedrock profile endpoint resolution", () => {
  it("treats request profiles as configured profiles for standard endpoints", () => {
    const endpoint = "https://bedrock-runtime.us-west-2.amazonaws.com";

    expect(testing.hasConfiguredBedrockProfile({ profile: "prod-bedrock" })).toBe(true);
    expect(
      testing.shouldUseExplicitBedrockEndpoint(
        endpoint,
        undefined,
        testing.hasConfiguredBedrockProfile({ profile: "prod-bedrock" }),
      ),
    ).toBe(false);
  });
});

describe("Bedrock thinking effort mapping", () => {
  it("clamps max effort for Claude models without native max support", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "anthropic.claude-sonnet-4-6-v1:0",
          name: "Claude Sonnet 4.6",
        }),
        "max",
      ),
    ).toBe("high");
  });

  it("preserves max effort for Claude Opus 4.8", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "anthropic.claude-opus-4.8-v1:0",
          name: "Claude Opus 4.8",
        }),
        "max",
      ),
    ).toBe("max");
  });
});
