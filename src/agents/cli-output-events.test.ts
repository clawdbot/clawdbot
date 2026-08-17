import { describe, expect, it, vi } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function claudeMessageStop() {
  return claudeStreamEvent({ type: "message_stop" });
}

function claudeBlockStart(contentBlock: Record<string, unknown>, index?: number) {
  return claudeStreamEvent({
    type: "content_block_start",
    ...(index === undefined ? {} : { index }),
    content_block: contentBlock,
  });
}

function claudeTextDelta(text: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "text_delta", text },
  });
}

describe("createCliJsonlStreamingParser events", () => {
  it("streams Gemini message deltas and tool events", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const starts: CliToolUseStartDelta[] = [];
    const results: CliToolResultDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "google-gemini-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "init",
          timestamp: "2026-06-16T19:36:46.000Z",
          session_id: "gemini-session-stream",
          model: "gemini-3.1-pro-preview",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-16T19:36:47.000Z",
          role: "assistant",
          content: "Checking tools. ",
          delta: true,
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: "2026-06-16T19:36:48.000Z",
          tool_name: "mcp_openclaw_create_goal",
          tool_id: "tool-1",
          parameters: { objective: "Update files" },
        }),
        JSON.stringify({
          type: "tool_result",
          timestamp: "2026-06-16T19:36:49.000Z",
          tool_id: "tool-1",
          status: "success",
          output: "created",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-16T19:36:50.000Z",
          role: "assistant",
          content: "Done.",
          delta: true,
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:51.000Z",
          status: "success",
          stats: { total_tokens: 9, input_tokens: 4, output_tokens: 5 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(deltas).toEqual([
      {
        text: "Checking tools. ",
        delta: "Checking tools. ",
        sessionId: "gemini-session-stream",
        usage: undefined,
      },
      {
        text: "Checking tools. Done.",
        delta: "Done.",
        sessionId: "gemini-session-stream",
        usage: undefined,
      },
    ]);
    expect(starts).toEqual([
      {
        toolCallId: "tool-1",
        name: "mcp_openclaw_create_goal",
        kind: "tool_use",
        args: { objective: "Update files" },
      },
    ]);
    expect(results).toEqual([
      { toolCallId: "tool-1", name: "mcp_openclaw_create_goal", isError: false, result: "created" },
    ]);
    expect(parser.getOutput()).toEqual({
      text: "Checking tools. Done.",
      sessionId: "gemini-session-stream",
      usage: {
        input: 4,
        output: 5,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 9,
      },
    });
  });

  it("streams plugin-owned JSONL events through normalized core projections", () => {
    const assistantDeltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const thinkingDeltas: Array<{ text: string; delta: string }> = [];
    const displayStarts: CliToolUseStartDelta[] = [];
    const displayResults: CliToolResultDelta[] = [];
    const parsedStarts: CliToolUseStartDelta[] = [];
    const sessionIds: string[] = [];
    const usageEvents: Array<{ usage: unknown; isTerminal: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) => {
        const event = JSON.parse(line) as {
          type: string;
          text?: string;
          session?: string;
          id?: string;
          name?: string;
          result?: unknown;
        };
        if (event.type === "session") {
          return { kind: "sessionId", sessionId: event.session ?? "" };
        }
        if (event.type === "thinking") {
          return { kind: "thinking", text: event.text ?? "" };
        }
        if (event.type === "text") {
          return { kind: "text", text: event.text ?? "" };
        }
        if (event.type === "tool-start") {
          return {
            kind: "toolStart",
            toolCallId: event.id ?? "",
            name: event.name ?? "",
            args: { query: "weather" },
          };
        }
        if (event.type === "tool-result") {
          return {
            kind: "toolResult",
            toolCallId: event.id ?? "",
            name: event.name,
            result: event.result,
          };
        }
        return {
          kind: "result",
          text: event.text,
          sessionId: event.session,
          usage: { input: 3, output: 2, total: 5 },
        };
      },
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onToolUseStart: (delta) => parsedStarts.push(delta),
      onDisplayToolUseStart: (delta) => displayStarts.push(delta),
      onDisplayToolResult: (delta) => displayResults.push(delta),
      onSessionId: (sessionId) => sessionIds.push(sessionId),
      onUsage: (usage, isTerminal) => usageEvents.push({ usage, isTerminal }),
    });

    parser.push(
      [
        JSON.stringify({ type: "session", session: "custom-session" }),
        JSON.stringify({ type: "thinking", text: "Checking " }),
        JSON.stringify({ type: "thinking", text: "facts." }),
        JSON.stringify({ type: "text", text: "Hello " }),
        JSON.stringify({ type: "text", text: "world" }),
        JSON.stringify({ type: "tool-start", id: "call-1", name: "search" }),
        JSON.stringify({
          type: "tool-result",
          id: "call-1",
          name: "search",
          result: "sunny",
        }),
        JSON.stringify({ type: "result", text: "Hello world", session: "custom-successor" }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(assistantDeltas).toEqual([
      { text: "Hello ", delta: "Hello ", sessionId: "custom-session", usage: undefined },
      { text: "Hello world", delta: "world", sessionId: "custom-session", usage: undefined },
    ]);
    expect(thinkingDeltas).toEqual([
      { text: "Checking ", delta: "Checking ", isReasoningSnapshot: true },
      { text: "Checking facts.", delta: "facts.", isReasoningSnapshot: true },
    ]);
    expect(displayStarts).toEqual([
      {
        toolCallId: "call-1",
        name: "search",
        kind: "tool_use",
        args: { query: "weather" },
      },
    ]);
    expect(displayResults).toEqual([
      { toolCallId: "call-1", name: "search", isError: false, result: "sunny" },
    ]);
    expect(parsedStarts).toEqual([]);
    expect(sessionIds).toEqual(["custom-session", "custom-successor"]);
    expect(usageEvents).toEqual([{ usage: { input: 3, output: 2, total: 5 }, isTerminal: true }]);
    expect(parser.getOutput()).toEqual({
      text: "Hello world",
      sessionId: "custom-successor",
      usage: { input: 3, output: 2, total: 5 },
    });
  });

  it("lets plugin parsers own their frames before lazily parsing fallback JSON", () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    const parseCountsAtPluginEntry: number[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) => {
        parseCountsAtPluginEntry.push(parseSpy.mock.calls.length);
        if (line === "plain provider frame") {
          return { kind: "text", text: "plain" };
        }
        if (line.includes('"item.completed"')) {
          return null;
        }
        const event = JSON.parse(line) as { text: string };
        return { kind: "text", text: event.text };
      },
      onAssistantDelta: () => {},
    });

    try {
      parser.push("plain provider frame\n");
      expect(parseSpy).not.toHaveBeenCalled();

      parser.push(`${JSON.stringify({ text: " provider JSON" })}\n`);
      expect(parseSpy).toHaveBeenCalledTimes(1);

      parser.push(
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "fallback" },
        })}\n`,
      );
      expect(parseCountsAtPluginEntry).toEqual([0, 0, 1]);
      expect(parseSpy).toHaveBeenCalledTimes(2);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("streams detailed Gemini error events over generic result errors", () => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      providerId: "google-gemini-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      [
        JSON.stringify({
          type: "error",
          timestamp: "2026-06-16T19:36:48.000Z",
          severity: "error",
          message: "Invalid stream payload",
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          stats: { total_tokens: 1 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: undefined,
      usage: {
        input: undefined,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 1,
      },
      errorText: "Invalid stream payload",
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

    expect(starts).toEqual([
      { toolCallId: "toolu_1", name: "Bash", kind: "tool_use", args: { command: "ls -la" } },
    ]);
    expect(results).toEqual([
      { toolCallId: "toolu_1", name: "Bash", isError: false, result: "total 0\n" },
    ]);
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
      {
        toolCallId: "toolu_hosted",
        name: "web_search",
        kind: type,
        args: { query: "openclaw" },
      },
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
      {
        toolCallId: fixture.toolCallId,
        name: fixture.name,
        kind: fixture.useType,
        args: fixture.input,
      },
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

  it.each([
    {
      name: "fires onCommentaryText with accumulated text before a tool_use block",
      frames: [
        { type: "init", session_id: "session-commentary" },
        claudeTextDelta("Let me check "),
        claudeTextDelta("that for you."),
        claudeBlockStart({ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }, 1),
      ],
      expectedCommentary: ["Let me check that for you."],
      expectedDeltas: [],
    },
    {
      name: "flushes Claude text as an assistant delta when no tool follows",
      frames: [
        { type: "init", session_id: "session-answer" },
        claudeTextDelta("Final "),
        claudeTextDelta("answer."),
        claudeMessageStop(),
      ],
      expectedCommentary: [],
      expectedDeltas: [{ text: "Final answer.", delta: "Final answer." }],
    },
  ])("$name", ({ frames, expectedCommentary, expectedDeltas }) => {
    const commentaryTexts: string[] = [];
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: (delta) => deltas.push({ text: delta.text, delta: delta.delta }),
      onCommentaryText: (text) => commentaryTexts.push(text),
    });

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(commentaryTexts).toEqual(expectedCommentary);
    expect(deltas).toEqual(expectedDeltas);
  });
});
