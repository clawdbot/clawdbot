import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  repairToolUseResultPairing,
  stripToolResultDetails,
} from "./session-transcript-repair.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

function getAssistantToolCallBlocks(messages: AgentMessage[]) {
  const assistant = messages[0] as Extract<AgentMessage, { role: "assistant" }> | undefined;
  if (!assistant || !Array.isArray(assistant.content)) {
    return [] as Array<{ type?: unknown; id?: unknown; name?: unknown }>;
  }
  return assistant.content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" && TOOL_CALL_BLOCK_TYPES.has(type);
  }) as Array<{ type?: unknown; id?: unknown; name?: unknown }>;
}

describe("sanitizeToolUseResultPairing", () => {
  const buildDuplicateToolResultInput = (opts?: {
    middleMessage?: unknown;
    secondText?: string;
  }): AgentMessage[] =>
    castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      ...(opts?.middleMessage ? [castAgentMessage(opts.middleMessage)] : []),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: opts?.secondText ?? "second" }],
        isError: false,
      },
    ]);

  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "user message that should come after tool use" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("repairs blank tool result names from matching tool calls", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "   ",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    const toolResult = out.find((message) => message.role === "toolResult") as {
      toolName?: string;
    };

    expect(toolResult?.toolName).toBe("read");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = castAgentMessages([
      ...buildDuplicateToolResultInput(),
      { role: "user", content: "ok" },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = buildDuplicateToolResultInput({
      middleMessage: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      secondText: "second (duplicate)",
    });

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("skips tool call extraction for assistant messages with stopReason 'error'", () => {
    // When an assistant message has stopReason: "error", its tool_use blocks may be
    // incomplete/malformed. We should NOT create synthetic tool_results for them,
    // as this causes API 400 errors: "unexpected tool_use_id found in tool_result blocks"
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_error", name: "exec", arguments: {} }],
        stopReason: "error",
      },
      { role: "user", content: "something went wrong" },
    ]);

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for errored messages
    expect(result.added).toHaveLength(0);
    // The assistant message should be passed through unchanged
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    expect(result.messages).toHaveLength(2);
  });

  it("skips tool call extraction for assistant messages with stopReason 'aborted'", () => {
    // When a request is aborted mid-stream, the assistant message may have incomplete
    // tool_use blocks (with partialJson). We should NOT create synthetic tool_results.
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "Bash", arguments: {} }],
        stopReason: "aborted",
      },
      { role: "user", content: "retrying after abort" },
    ]);

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for aborted messages
    expect(result.added).toHaveLength(0);
    // Messages should be passed through without synthetic insertions
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
  });

  it("still repairs tool results for normal assistant messages with stopReason 'toolUse'", () => {
    // Normal tool calls (stopReason: "toolUse" or "stop") should still be repaired
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_normal", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
      { role: "user", content: "user message" },
    ]);

    const result = repairToolUseResultPairing(input);

    // Should add a synthetic tool result for the missing result
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.toolCallId).toBe("call_normal");
  });

  it("retains matching tool results that follow an aborted assistant message", () => {
    // Aborted assistant turns do not synthesize missing tool results, but real
    // matching results in the same span remain part of the repaired transcript.
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "exec", arguments: {} }],
        stopReason: "aborted",
      },
      {
        role: "toolResult",
        toolCallId: "call_aborted",
        toolName: "exec",
        content: [{ type: "text", text: "partial result" }],
        isError: false,
      },
      { role: "user", content: "retrying" },
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.droppedOrphanCount).toBe(0);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("toolResult");
    expect(result.messages[2]?.role).toBe("user");
    expect(result.added).toHaveLength(0);
  });

  it("drops matching tool results for aborted assistant messages when requested", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "exec", arguments: {} }],
        stopReason: "aborted",
      },
      {
        role: "toolResult",
        toolCallId: "call_aborted",
        toolName: "exec",
        content: [{ type: "text", text: "partial result" }],
        isError: false,
      },
      { role: "user", content: "retrying" },
    ]);

    const result = repairToolUseResultPairing(input, {
      erroredAssistantResultPolicy: "drop",
    });

    expect(result.droppedOrphanCount).toBe(0);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    expect(result.added).toHaveLength(0);
  });
});

describe("sanitizeToolCallInputs", () => {
  function sanitizeAssistantContent(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return sanitizeToolCallInputs(
      castAgentMessages([
        {
          role: "assistant",
          content,
        },
      ]),
      options,
    );
  }

  function sanitizeAssistantToolCalls(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return getAssistantToolCallBlocks(sanitizeAssistantContent(content, options));
  }

  it("drops tool calls missing input or arguments", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it.each([
    {
      name: "drops tool calls with missing or blank name/id",
      content: [
        { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
        { type: "toolCall", id: "call_empty_name", name: "", arguments: {} },
        { type: "toolUse", id: "call_blank_name", name: "   ", input: {} },
        { type: "functionCall", id: "", name: "exec", arguments: {} },
      ],
      options: undefined,
      expectedIds: ["call_ok"],
    },
    {
      name: "drops tool calls with malformed or overlong names",
      content: [
        { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
        {
          type: "toolCall",
          id: "call_bad_chars",
          name: 'toolu_01abc <|tool_call_argument_begin|> {"command"',
          arguments: {},
        },
        {
          type: "toolUse",
          id: "call_too_long",
          name: `read_${"x".repeat(80)}`,
          input: {},
        },
      ],
      options: undefined,
      expectedIds: ["call_ok"],
    },
    {
      name: "accepts punctuation-safe tool names during transcript repair",
      content: [
        { type: "toolCall", id: "call_ns", name: "vigil-harbor__memory_status", arguments: {} },
        { type: "toolUse", id: "call_dotted", name: "my.server:some_tool", input: {} },
      ],
      options: undefined,
      expectedIds: ["call_ns", "call_dotted"],
    },
    {
      name: "drops unknown tool names when an allowlist is provided",
      content: [
        { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
        { type: "toolCall", id: "call_unknown", name: "write", arguments: {} },
      ],
      options: { allowedToolNames: ["read"] },
      expectedIds: ["call_ok"],
    },
  ])("$name", ({ content, options, expectedIds }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const ids = toolCalls
      .map((toolCall) => (toolCall as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");

    expect(ids).toEqual(expectedIds);
  });

  it("keeps valid tool calls and preserves text blocks", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolUse", id: "call_ok", name: "read", input: { path: "a" } },
          { type: "toolCall", id: "call_drop", name: "read" },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text", "toolUse"]);
  });

  it("drops signed-thinking assistant turns when sibling tool calls are not replay-safe", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me check the gateway config.",
            thinkingSignature: "sig_gateway",
          },
          {
            type: "toolCall",
            id: "call_gateway",
            name: "gateway",
            arguments: {
              action: "config.get",
              path: "channels.telegram",
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([]);
  });

  it("drops signed-thinking assistant turns when sibling tool calls reuse an id", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me reuse the tool id.",
            thinkingSignature: "sig_duplicate",
          },
          { type: "toolCall", id: "call_shared", name: "read", arguments: { path: "a" } },
          { type: "toolUse", id: "call_shared", name: "read", input: { path: "b" } },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([]);
  });

  it("drops later signed-thinking assistant turns that reuse an earlier signed tool id", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "First signed replay turn.",
            thinkingSignature: "sig_first",
          },
          { type: "toolCall", id: "call_shared", name: "read", arguments: { path: "a" } },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Second signed replay turn.",
            thinkingSignature: "sig_second",
          },
          { type: "toolUse", id: "call_shared", name: "read", input: { path: "b" } },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([input[0]]);
  });

  it("drops signed-thinking assistant turns that would require attachment redaction", () => {
    const secret = "SIGNED_THINKING_ATTACHMENT_SECRET"; // pragma: allowlist secret
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me spawn a helper.",
            thinkingSignature: "sig_spawn",
          },
          {
            type: "toolUse",
            id: "call_spawn",
            name: "sessions_spawn",
            input: {
              task: "inspect attachment",
              attachments: [{ name: "snapshot.txt", content: secret }],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["sessions_spawn"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("keeps signed-thinking assistant turns when sessions_spawn attachments are already redacted", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me replay the helper turn.",
            thinkingSignature: "sig_spawn_safe",
          },
          {
            type: "toolUse",
            id: "call_spawn",
            name: "sessions_spawn",
            input: {
              task: "inspect attachment",
              attachments: [
                {
                  name: "snapshot.txt",
                  mimeType: "text/plain",
                  content: "__OPENCLAW_REDACTED__",
                },
              ],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["sessions_spawn"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual(input);
  });

  it("keeps generic thinking turns mutable when immutable preservation is disabled", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me normalize this tool name.",
            thinkingSignature: "sig_generic",
          },
          {
            type: "toolCall",
            id: "call_read",
            name: " read ",
            arguments: { path: "README.md" },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, { allowedToolNames: ["read"] });
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([
      {
        type: "thinking",
        thinking: "Let me normalize this tool name.",
        thinkingSignature: "sig_generic",
      },
      {
        type: "toolCall",
        id: "call_read",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
  });

  it.each([
    {
      name: "trims leading whitespace from tool names",
      content: [{ type: "toolCall", id: "call_1", name: " read", arguments: {} }],
      options: undefined,
      expectedNames: ["read"],
    },
    {
      name: "trims trailing whitespace from tool names",
      content: [{ type: "toolUse", id: "call_1", name: "exec ", input: { command: "ls" } }],
      options: undefined,
      expectedNames: ["exec"],
    },
    {
      name: "trims both leading and trailing whitespace from tool names",
      content: [
        { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
        { type: "toolUse", id: "call_2", name: "  exec  ", input: {} },
      ],
      options: undefined,
      expectedNames: ["read", "exec"],
    },
    {
      name: "trims tool names and matches against allowlist",
      content: [
        { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
        { type: "toolCall", id: "call_2", name: " write ", arguments: {} },
      ],
      options: { allowedToolNames: ["read"] },
      expectedNames: ["read"],
    },
  ])("$name", ({ content, options, expectedNames }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const names = toolCalls
      .map((toolCall) => (toolCall as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    expect(names).toEqual(expectedNames);
  });

  it("preserves toolUse input shape for sessions_spawn when no attachments are present", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_1",
            name: "sessions_spawn",
            input: { task: "hello" },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out) as Array<Record<string, unknown>>;

    expect(toolCalls).toHaveLength(1);
    expect(Object.hasOwn(toolCalls[0] ?? {}, "input")).toBe(true);
    expect(Object.hasOwn(toolCalls[0] ?? {}, "arguments")).toBe(false);
    expect((toolCalls[0] ?? {}).input).toEqual({ task: "hello" });
  });

  it("redacts sessions_spawn attachments for mixed-case and padded tool names", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_1",
            name: "  SESSIONS_SPAWN  ",
            input: {
              task: "hello",
              attachments: [{ name: "a.txt", content: "SECRET" }],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out) as Array<Record<string, unknown>>;

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] ?? {}).name).toBe("SESSIONS_SPAWN");
    const inputObj = (toolCalls[0]?.input ?? {}) as Record<string, unknown>;
    const attachments = (inputObj.attachments ?? []) as Array<Record<string, unknown>>;
    expect(attachments[0]?.content).toBe("__OPENCLAW_REDACTED__");
  });
  it("preserves other block properties when trimming tool names", () => {
    const toolCalls = sanitizeAssistantToolCalls([
      { type: "toolCall", id: "call_1", name: " read ", arguments: { path: "/tmp/test" } },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
    expect((toolCalls[0] as { id?: unknown }).id).toBe("call_1");
    expect((toolCalls[0] as { arguments?: unknown }).arguments).toEqual({ path: "/tmp/test" });
  });
});

describe("stripToolResultDetails", () => {
  it("removes details only from toolResult messages", () => {
    const input = castAgentMessages([
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        details: { internal: true },
      },
      { role: "assistant", content: [{ type: "text", text: "keep me" }], details: { no: "touch" } },
      { role: "user", content: "hello" },
    ]);

    const out = stripToolResultDetails(input) as unknown as Array<Record<string, unknown>>;

    expect(Object.hasOwn(out[0] ?? {}, "details")).toBe(false);
    expect((out[0] ?? {}).role).toBe("toolResult");

    // Non-toolResult messages are preserved as-is.
    expect(Object.hasOwn(out[1] ?? {}, "details")).toBe(true);
    expect((out[1] ?? {}).role).toBe("assistant");
    expect((out[2] ?? {}).role).toBe("user");
  });

  it("returns the same array reference when there are no toolResult details", () => {
    const input = castAgentMessages([
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
      { role: "user", content: "b" },
    ]);

    const out = stripToolResultDetails(input);
    expect(out).toBe(input);
  });
});
