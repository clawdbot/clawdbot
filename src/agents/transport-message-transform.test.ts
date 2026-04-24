import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { transformTransportMessages } from "./transport-message-transform.js";

function makeModel(api: Api, provider: string, id: string): Model<Api> {
  return { api, provider, id, input: [], output: [] } as unknown as Model<Api>;
}

function assistantToolCall(
  id: string,
  name = "read",
): Extract<Context["messages"][number], { role: "assistant" }> {
  return {
    role: "assistant",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.4",
    stopReason: "toolUse",
    timestamp: Date.now(),
    content: [{ type: "toolCall", id, name, arguments: {} }],
  } as Extract<Context["messages"][number], { role: "assistant" }>;
}

describe("transformTransportMessages synthetic tool-result policy", () => {
  it("does not synthesize missing tool results for OpenAI-compatible transports", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_openai_1"),
      { role: "user", content: "continue", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "user"]);
  });

  it("still synthesizes missing tool results for Anthropic transports", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_anthropic_1"),
      { role: "user", content: "continue", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("anthropic-messages", "anthropic", "claude-opus-4-6"),
    );

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(result[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_anthropic_1",
      isError: true,
    });
  });

  it("still synthesizes missing tool results for transport alias apis that own replay repair", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_transport_1"),
      { role: "user", content: "continue", timestamp: Date.now() },
    ];

    const anthropicAlias = transformTransportMessages(
      messages,
      makeModel("openclaw-anthropic-messages-transport" as Api, "anthropic", "claude-opus-4-6"),
    );
    expect(anthropicAlias.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);

    const googleAlias = transformTransportMessages(
      messages,
      makeModel("openclaw-google-generative-ai-transport" as Api, "google", "gemini-2.5-pro"),
    );
    expect(googleAlias.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);

    const bedrockCanonical = transformTransportMessages(
      messages,
      makeModel("bedrock-converse-stream" as Api, "bedrock", "anthropic.claude-opus-4-6"),
    );
    expect(bedrockCanonical.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
  });
});
