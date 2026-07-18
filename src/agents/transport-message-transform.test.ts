// Transport message transform tests cover replay cleanup for provider-specific
// tool-call/result sequencing before messages are sent back to transports.
import type { Api, Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { transformTransportMessages } from "./transport-message-transform.js";

function makeModel(api: Api, provider: string, id: string, canonicalModelId?: string): Model {
  return {
    api,
    provider,
    id,
    name: id,
    ...(canonicalModelId ? { params: { canonicalModelId } } : {}),
    input: [],
    output: [],
  } as unknown as Model;
}

type ToolResultMessage = Extract<Context["messages"][number], { role: "toolResult" }>;

function requireToolResultMessage(
  message: Context["messages"][number] | undefined,
): ToolResultMessage {
  if (!message || message.role !== "toolResult") {
    throw new Error(`expected toolResult message, got ${message?.role ?? "missing"}`);
  }
  return message;
}

function toolResultSummaries(messages: Context["messages"]) {
  return messages.map((message) => {
    const toolResult = requireToolResultMessage(message);
    return {
      role: toolResult.role,
      toolCallId: toolResult.toolCallId,
      content: toolResult.content,
    };
  });
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
  it.each([
    {
      source: { provider: "anthropic", model: "claude-fable-5" },
      target: { provider: "anthropic-vertex", model: "claude-opus-4-8" },
    },
    {
      source: { provider: "anthropic", model: "claude-mythos-5" },
      target: { provider: "anthropic", model: "claude-opus-4-8" },
    },
    {
      source: { provider: "anthropic", model: "claude-fable-5" },
      target: { provider: "anthropic-vertex", model: "claude-mythos-5" },
    },
    {
      source: { provider: "anthropic", model: "claude-mythos-5" },
      target: { provider: "anthropic", model: "claude-fable-5" },
    },
    {
      source: { provider: "anthropic", model: "claude-sonnet-4-6" },
      target: { provider: "anthropic", model: "claude-fable-5" },
    },
    {
      source: {
        provider: "microsoft-foundry",
        model: "prod-primary",
        responseModel: "claude-fable-5",
      },
      target: { provider: "anthropic", model: "claude-opus-4-8" },
    },
    {
      source: { provider: "legacy-provider", model: "prod-primary" },
      target: {
        provider: "microsoft-foundry",
        model: "prod-primary",
        canonicalModelId: "claude-fable-5",
      },
    },
    {
      source: {
        provider: "anthropic",
        model: "claude-fable-5",
        responseModel: "claude-opus-4-8",
      },
      target: { provider: "anthropic", model: "claude-fable-5" },
    },
    {
      source: {
        provider: "microsoft-foundry",
        model: "prod-primary",
        responseModel: "claude-opus-4-8",
      },
      target: {
        provider: "microsoft-foundry",
        model: "prod-primary",
        canonicalModelId: "claude-fable-5",
      },
    },
  ])("drops model-bound thinking for Fable/Mythos switches", ({ source, target }) => {
    const result = transformTransportMessages(
      [
        {
          role: "assistant",
          provider: source.provider,
          api: "anthropic-messages",
          model: source.model,
          responseModel: source.responseModel,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "model-bound thought",
              thinkingSignature: "sig_model_bound",
            },
            { type: "text", text: "visible answer" },
          ],
        },
      ] as Context["messages"],
      makeModel("anthropic-messages", target.provider, target.model, target.canonicalModelId),
    );

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
    });
  });

  it.each([
    {
      sourceProvider: "anthropic",
      sourceModel: "claude-fable-5",
      sourceResponseModel: undefined,
      targetProvider: "anthropic",
      targetApi: "openclaw-anthropic-messages-transport" as const,
      targetModel: "claude-fable-5",
      targetCanonicalModelId: undefined,
    },
    {
      sourceProvider: "microsoft-foundry",
      sourceModel: "prod-primary",
      sourceResponseModel: undefined,
      targetProvider: "microsoft-foundry",
      targetApi: "anthropic-messages" as const,
      targetModel: "prod-primary",
      targetCanonicalModelId: "claude-fable-5",
    },
    {
      sourceProvider: "microsoft-foundry",
      sourceModel: "prod-primary",
      sourceResponseModel: "prod-primary",
      targetProvider: "microsoft-foundry",
      targetApi: "anthropic-messages" as const,
      targetModel: "prod-primary",
      targetCanonicalModelId: "claude-fable-5",
    },
    {
      sourceProvider: "anthropic",
      sourceModel: "claude-fable-5",
      sourceResponseModel: undefined,
      targetProvider: "anthropic-vertex",
      targetApi: "anthropic-messages" as const,
      targetModel: "claude-fable-5",
      targetCanonicalModelId: undefined,
    },
    {
      sourceProvider: "microsoft-foundry",
      sourceModel: "prod-primary",
      sourceResponseModel: "claude-fable-5",
      targetProvider: "anthropic",
      targetApi: "anthropic-messages" as const,
      targetModel: "claude-fable-5",
      targetCanonicalModelId: "claude-fable-5",
    },
    {
      sourceProvider: "anthropic",
      sourceModel: "claude-fable-5",
      sourceResponseModel: undefined,
      targetProvider: "microsoft-foundry",
      targetApi: "anthropic-messages" as const,
      targetModel: "prod-primary",
      targetCanonicalModelId: "claude-fable-5",
    },
    {
      sourceProvider: "anthropic",
      sourceModel: "claude-mythos-5",
      sourceResponseModel: undefined,
      targetProvider: "anthropic-vertex",
      targetApi: "anthropic-messages" as const,
      targetModel: "claude-mythos-5",
      targetCanonicalModelId: undefined,
    },
  ])(
    "preserves Fable/Mythos thinking across compatible Anthropic transports",
    ({
      sourceProvider,
      sourceModel,
      sourceResponseModel,
      targetProvider,
      targetApi,
      targetModel,
      targetCanonicalModelId,
    }) => {
      const result = transformTransportMessages(
        [
          {
            role: "assistant",
            provider: sourceProvider,
            api: "anthropic-messages",
            model: sourceModel,
            responseModel: sourceResponseModel,
            stopReason: "stop",
            timestamp: Date.now(),
            content: [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: "sig_omitted",
              },
            ],
          },
        ] as Context["messages"],
        makeModel(targetApi, targetProvider, targetModel, targetCanonicalModelId),
      );

      expect(result[0]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: "sig_omitted",
          },
        ],
      });
    },
  );

  it("drops Fable thinking across unrelated API overrides", () => {
    const result = transformTransportMessages(
      [
        {
          role: "assistant",
          provider: "anthropic",
          api: "openai-completions",
          model: "claude-fable-5",
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "adapter reasoning",
              thinkingSignature: "reasoning_content",
            },
            { type: "text", text: "visible answer" },
          ],
        },
      ] as Context["messages"],
      makeModel("anthropic-messages", "anthropic", "claude-fable-5"),
    );

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
    });
  });

  it("normalizes malformed assistant content before transport conversion", () => {
    const objectContentMessages = [
      {
        ...assistantToolCall("call_object"),
        stopReason: "stop",
        content: { type: "text", text: "legacy object" },
      },
      { role: "user", content: "continue", timestamp: Date.now() },
    ] as unknown as Context["messages"];
    const objectResult = transformTransportMessages(
      objectContentMessages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );
    expect(objectResult[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "legacy object" }],
    });

    const nullContentMessages = [
      {
        ...assistantToolCall("call_null"),
        stopReason: "stop",
        content: null,
      },
      { role: "user", content: "continue", timestamp: Date.now() },
    ] as unknown as Context["messages"];
    const nullResult = transformTransportMessages(
      nullContentMessages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );
    expect(nullResult[0]).toMatchObject({ role: "assistant", content: [] });
    expect(nullResult[1]).toMatchObject({ role: "user" });
  });

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
    const toolResult = requireToolResultMessage(result[1]);
    expect(toolResult.toolCallId).toBe("call_openai_1");
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toEqual([{ type: "text", text: "aborted" }]);
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
    expect(toolResultSummaries(result.slice(1, 3))).toEqual([
      { role: "toolResult", toolCallId: "call_keep", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_missing",
        content: [{ type: "text", text: "aborted" }],
      },
    ]);
  });

  it("moves displaced OpenAI transport results before synthesizing missing siblings", () => {
    // OpenAI requires tool results immediately after the assistant tool call;
    // displaced results are moved back before any missing siblings are aborted.
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
    expect(toolResultSummaries(result.slice(1, 3))).toEqual([
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

  it("drops max-token reasoning-only transport assistant turns before replay", () => {
    const messages: Context["messages"] = [
      {
        role: "assistant",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
        model: "global.anthropic.claude-sonnet-4-6",
        stopReason: "length",
        timestamp: Date.now(),
        content: [
          {
            type: "thinking",
            thinking: "partial hidden reasoning",
            thinkingSignature: "partial-signature",
          },
        ],
      } as Extract<Context["messages"][number], { role: "assistant" }>,
      { role: "user", content: "retry after max token thinking", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel(
        "bedrock-converse-stream" as Api,
        "amazon-bedrock",
        "global.anthropic.claude-sonnet-4-6",
      ),
    );

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
    expect(JSON.stringify(result)).not.toContain("partial-signature");
  });

  it("keeps max-token transport turns with visible or tool content", () => {
    const messages: Context["messages"] = [
      {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        stopReason: "length",
        timestamp: Date.now(),
        content: [
          { type: "thinking", thinking: "partial", thinkingSignature: "sig-visible" },
          { type: "text", text: "partial visible answer" },
        ],
      },
      assistantToolCall("call_length", "exec", "length"),
    ] as Context["messages"];

    const result = transformTransportMessages(
      messages,
      makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-6"),
    );

    expect(result[0]).toMatchObject({ role: "assistant", stopReason: "length" });
    expect(result[1]).toMatchObject({ role: "assistant", stopReason: "length" });
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

  it("does not reassign a dropped errored turn's repeated-id result to an older turn", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_repeated"),
      assistantToolCall("call_repeated", "exec", "error"),
      {
        role: "toolResult",
        toolCallId: "call_repeated",
        toolName: "exec",
        content: [{ type: "text", text: "failed turn output" }],
        isError: true,
        timestamp: Date.now(),
      },
      { role: "user", content: "retry after error", timestamp: Date.now() },
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("anthropic-messages", "anthropic", "claude-opus-4-6"),
    );

    expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(requireToolResultMessage(result[1])).toMatchObject({
      toolCallId: "call_repeated",
      isError: true,
      content: [{ type: "text", text: "No result provided" }],
    });
    expect(JSON.stringify(result)).not.toContain("failed turn output");
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
    const toolResult = requireToolResultMessage(result[1]);
    expect(toolResult.toolCallId).toBe("call_anthropic_1");
    expect(toolResult.isError).toBe(true);
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
    const googleToolResult = requireToolResultMessage(googleAlias[1]);
    expect(googleToolResult.content).toEqual([{ type: "text", text: "No result provided" }]);

    const bedrockCanonical = transformTransportMessages(
      messages,
      makeModel("bedrock-converse-stream" as Api, "bedrock", "anthropic.claude-opus-4-6"),
    );
    expect(bedrockCanonical.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
  });
});
