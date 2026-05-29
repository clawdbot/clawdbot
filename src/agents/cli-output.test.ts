import { describe, expect, it } from "vitest";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliJson,
  parseCliJsonl,
  type CliToolUseStartDelta,
} from "./cli-output.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

describe("parseCliJson", () => {
  it("recovers mixed-output Claude session metadata from embedded JSON objects", () => {
    const result = parseCliJson(
      [
        "Claude Code starting...",
        '{"type":"init","session_id":"session-789"}',
        '{"type":"result","result":"Claude says hi","usage":{"input_tokens":9,"output_tokens":4}}',
      ].join("\n"),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Claude says hi",
      sessionId: "session-789",
      usage: {
        input: 9,
        output: 4,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses Gemini CLI response text and stats payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-123",
        response: "Gemini says hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session-123",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 8,
        cacheWrite: undefined,
        total: 21,
      },
    });
  });

  it("falls back to input_tokens minus cached when Gemini stats omit input", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-456",
        response: "Hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result?.usage?.input).toBe(5);
    expect(result?.usage?.cacheRead).toBe(8);
  });

  it("falls back to Gemini stats when usage exists without token fields", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-789",
        response: "Gemini says hello",
        usage: {},
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session-789",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 8,
        cacheWrite: undefined,
        total: 21,
      },
    });
  });

  it("unwraps nested Claude result JSON from JSON output", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "session-nested-json",
        result: JSON.stringify({
          type: "result",
          result: JSON.stringify({
            type: "result",
            subtype: "success",
            result: "actual response text",
          }),
        }),
      }),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "actual response text",
      sessionId: "session-nested-json",
      usage: undefined,
    });
  });

  it("does not unwrap nested result-shaped JSON for non-claude json backends", () => {
    const nestedResult = JSON.stringify({
      type: "result",
      result: JSON.stringify({
        type: "result",
        result: "actual response text",
      }),
    });
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-nested-json",
        result: nestedResult,
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "gemini",
    );

    expect(result).toEqual({
      text: nestedResult,
      sessionId: "gemini-session-nested-json",
      usage: undefined,
    });
  });

  it("parses nested OpenAI-style cached token details from CLI json payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "openai-session-123",
        response: "OpenAI says hello",
        usage: {
          input_tokens: 15,
          output_tokens: 4,
          input_tokens_details: {
            cached_tokens: 6,
          },
        },
      }),
      {
        command: "codex",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "OpenAI says hello",
      sessionId: "openai-session-123",
      usage: {
        input: 9,
        output: 4,
        cacheRead: 6,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });
});

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses Claude stream-json result events for an explicit backend dialect", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-dialect" }),
        JSON.stringify({
          type: "result",
          session_id: "session-dialect",
          result: "dialect says hello",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ].join("\n"),
      {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "local-cli",
    );

    expect(result).toEqual({
      text: "dialect says hello",
      sessionId: "session-dialect",
      usage: {
        input: 5,
        output: 2,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("preserves Claude cache creation tokens instead of flattening them to zero", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-cache-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-cache-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 7,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-cache-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: 7,
        total: undefined,
      },
    });
  });

  it("does not let cumulative Claude result usage overwrite assistant usage", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-stream" }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-2",
            usage: { input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 125 },
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-stream",
          result: "done",
          usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 300 },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result?.usage).toEqual({
      input: 11,
      output: 6,
      cacheRead: 125,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("preserves Claude session metadata even when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-456" }),
        JSON.stringify({
          type: "result",
          session_id: "session-456",
          result: "   ",
          usage: {
            input_tokens: 18,
            output_tokens: 0,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-456",
      usage: {
        input: 18,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("unwraps nested Claude agent result JSON from stream-json output", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-nested-jsonl" }),
        JSON.stringify({
          type: "result",
          session_id: "session-nested-jsonl",
          result: JSON.stringify({
            type: "result",
            result: JSON.stringify({
              type: "result",
              subtype: "success",
              result: "actual response text",
            }),
          }),
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "actual response text",
      sessionId: "session-nested-jsonl",
      usage: undefined,
    });
  });

  it("parses multiple JSON objects embedded on the same line", () => {
    const result = parseCliJsonl(
      '{"type":"init","session_id":"session-999"} {"type":"result","session_id":"session-999","result":"done"}',
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "done",
      sessionId: "session-999",
      usage: undefined,
    });
  });

  it("extracts nested Claude API errors from failed stream-json output", () => {
    const { message, jsonl } = createClaudeApiErrorFixture();
    const result = extractCliErrorMessage(jsonl);

    expect(result).toBe(message);
  });
});

describe("createCliJsonlStreamingParser", () => {
  it("streams Claude stream-json deltas for an explicit backend dialect", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
    });

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-stream" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hello" },
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "hello", delta: "hello", sessionId: "session-stream", usage: undefined },
    ]);
  });

  it("ignores cumulative usage from result events to avoid cache_read inflation", () => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-stream" }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-2",
            usage: { input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 125 },
          },
        }),
        JSON.stringify({
          type: "result",
          result: "done",
          usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 300 },
        }),
      ].join("\n"),
    );
    parser.finish();

    const output = parser.getOutput();
    expect(output?.usage).toEqual({
      input: 11,
      output: 6,
      cacheRead: 125,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("surfaces Claude tool_use start and result events", () => {
    const starts: CliToolUseStartDelta[] = [];
    const results: Array<{ toolCallId: string; name: string; isError: boolean; result?: unknown }> =
      [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "total 0\n",
                is_error: false,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([{ toolCallId: "toolu_1", name: "Bash", args: { command: "ls -la" } }]);
    expect(results).toEqual([
      { toolCallId: "toolu_1", name: "Bash", isError: false, result: "total 0\n" },
    ]);
  });

  it("reassembles streamed tool args from input_json_delta chunks", () => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_chunked", name: "Bash", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command":' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: ' "echo hi"}' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      { toolCallId: "toolu_chunked", name: "Bash", args: { command: "echo hi" } },
    ]);
  });

  it("emits empty args when streamed tool args are malformed", () => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_bad", name: "Bash", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command": "ls' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([{ toolCallId: "toolu_bad", name: "Bash", args: {} }]);
  });

  it.each(["server_tool_use", "mcp_tool_use"])("recognizes %s blocks", (type) => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type, id: "toolu_hosted", name: "web_search", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":"openclaw"}' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      { toolCallId: "toolu_hosted", name: "web_search", args: { query: "openclaw" } },
    ]);
  });

  it.each([
    {
      useType: "server_tool_use",
      resultType: "web_search_tool_result",
      toolCallId: "srvtoolu_1",
      name: "web_search",
      input: { query: "openclaw" },
      result: [{ type: "web_search_result", title: "OpenClaw", url: "https://example.com" }],
      isError: false,
    },
    {
      useType: "mcp_tool_use",
      resultType: "mcp_tool_result",
      toolCallId: "mcptoolu_1",
      name: "echo",
      input: { value: "hello" },
      result: [{ type: "text", text: "hello" }],
      isError: false,
    },
  ])("emits hosted result events for $useType", (fixture) => {
    const starts: CliToolUseStartDelta[] = [];
    const results: Array<{ toolCallId: string; name: string; isError: boolean; result?: unknown }> =
      [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: fixture.useType,
                id: fixture.toolCallId,
                name: fixture.name,
                input: fixture.input,
              },
              {
                type: fixture.resultType,
                tool_use_id: fixture.toolCallId,
                content: fixture.result,
                is_error: fixture.isError,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      { toolCallId: fixture.toolCallId, name: fixture.name, args: fixture.input },
    ]);
    expect(results).toEqual([
      {
        toolCallId: fixture.toolCallId,
        name: fixture.name,
        isError: fixture.isError,
        result: fixture.result,
      },
    ]);
  });

  it("emits streamed server tool result blocks", () => {
    const results: Array<{ toolCallId: string; name: string; isError: boolean; result?: unknown }> =
      [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: () => undefined,
      onToolResult: (delta) => results.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "server_tool_use", id: "srvtoolu_stream", name: "web_search" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_stream",
              content: { type: "web_search_tool_result_error", error_code: "unavailable" },
            },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(results).toEqual([
      {
        toolCallId: "srvtoolu_stream",
        name: "web_search",
        isError: true,
        result: { type: "web_search_tool_result_error", error_code: "unavailable" },
      },
    ]);
  });
});
