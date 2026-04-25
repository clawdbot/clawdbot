import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { transformTransportMessages } from "./transport-message-transform.js";

function makeModel(api: Api, provider: string, id: string): Model<Api> {
  return { api, provider, id, input: [], output: [] } as unknown as Model<Api>;
}

function assistantToolCall(
  id: string,
  name = "read",
  stopReason: Extract<Context["messages"][number], { role: "assistant" }>["stopReason"] = "toolUse",
): Extract<Context["messages"][number], { role: "assistant" }> {
  return {
    role: "assistant",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.4",
    stopReason,
    timestamp: Date.now(),
    content: [{ type: "toolCall", id, name, arguments: {} }],
  } as Extract<Context["messages"][number], { role: "assistant" }>;
}

describe("transformTransportMessages synthetic tool-result policy", () => {
  it("synthesizes Codex-style aborted tool results for OpenAI Responses transports", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_openai_1"),
      { role: "user", content: "continue", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(result[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_openai_1",
      isError: true,
      content: [{ type: "text", text: "aborted" }],
    });
  });

  it("preserves real OpenAI transport results and aborts missing parallel siblings", () => {
    const messages: Context["messages"] = [
      {
        ...assistantToolCall("call_keep"),
        content: [
          { type: "toolCall", id: "call_keep", name: "read", arguments: {} },
          { type: "toolCall", id: "call_missing", name: "exec", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_keep",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: Date.now(),
      },
      { role: "user", content: "continue", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("openclaw-openai-responses-transport" as Api, "openai", "gpt-5.4"),
    );

    expect(result.map((msg) => msg.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(result.slice(1, 3)).toMatchObject([
      { role: "toolResult", toolCallId: "call_keep", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_missing",
        content: [{ type: "text", text: "aborted" }],
      },
    ]);
  });

  it("moves displaced OpenAI transport results before synthesizing missing siblings", () => {
    const messages: Context["messages"] = [
      {
        ...assistantToolCall("call_keep"),
        content: [
          { type: "toolCall", id: "call_keep", name: "read", arguments: {} },
          { type: "toolCall", id: "call_missing", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "continue", timestamp: Date.now() },
      {
        role: "toolResult",
        toolCallId: "call_keep",
        toolName: "read",
        content: [{ type: "text", text: "late ok" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );

    expect(result.map((msg) => msg.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(result.slice(1, 3)).toMatchObject([
      { role: "toolResult", toolCallId: "call_keep", content: [{ type: "text", text: "late ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_missing",
        content: [{ type: "text", text: "aborted" }],
      },
    ]);
  });

  it("drops aborted OpenAI transport assistant tool calls before replay", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_aborted", "exec", "aborted"),
      { role: "user", content: "retry after abort", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
    expect(JSON.stringify(result)).not.toContain("call_aborted");
  });

  it("drops text-only aborted and errored transport assistant turns before replay", () => {
    const messages: Context["messages"] = [
      {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        stopReason: "aborted",
        timestamp: Date.now(),
        content: [{ type: "text", text: "partial aborted output" }],
      } as Extract<Context["messages"][number], { role: "assistant" }>,
      {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        stopReason: "error",
        timestamp: Date.now(),
        content: [{ type: "text", text: "partial error output" }],
      } as Extract<Context["messages"][number], { role: "assistant" }>,
      { role: "user", content: "retry after failed text turns", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
    expect(JSON.stringify(result)).not.toContain("partial aborted output");
    expect(JSON.stringify(result)).not.toContain("partial error output");
  });

  it("drops errored Anthropic transport assistant tool calls and matching results before replay", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_error", "exec", "error"),
      {
        role: "toolResult",
        toolCallId: "call_error",
        toolName: "exec",
        content: [{ type: "text", text: "partial" }],
        isError: true,
        timestamp: Date.now(),
      },
      { role: "user", content: "retry after error", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("anthropic-messages", "anthropic", "claude-opus-4-6"),
    );

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
    expect(JSON.stringify(result)).not.toContain("call_error");
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
    expect(googleAlias[1]).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "No result provided" }],
    });

    const bedrockCanonical = transformTransportMessages(
      messages,
      makeModel("bedrock-converse-stream" as Api, "bedrock", "anthropic.claude-opus-4-6"),
    );
    expect(bedrockCanonical.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
  });
});
