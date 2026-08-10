import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { parseCliOutput } from "./cli-output.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

function parseCliJsonl(raw: string, backend: ParseCliOutputParams["backend"], providerId: string) {
  return parseCliOutput({ raw, backend, providerId, outputMode: "jsonl" });
}

function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function claudeMessageStart(id?: string) {
  return claudeStreamEvent({ type: "message_start", ...(id ? { message: { id } } : {}) });
}

function claudeTextDelta(text: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "text_delta", text },
  });
}

function claudeThinkingDelta(thinking: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "thinking_delta", thinking },
  });
}

function claudeAssistantSnapshot(id: string, content: unknown[]) {
  return { type: "assistant", message: { id, content } };
}

function normalizedUsage(values: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}) {
  return {
    input: values.input,
    output: values.output,
    cacheRead: values.cacheRead,
    cacheWrite: values.cacheWrite,
    total: values.total,
  };
}

describe("parseCliJsonl", () => {
  it.each([
    {
      name: "parses Claude stream-json result events",
      command: "claude",
      jsonlDialect: undefined,
      providerId: "claude-cli",
      frames: [
        { type: "init", session_id: "session-123" },
        {
          type: "result",
          session_id: "session-123",
          result: "Claude says hello",
          usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
        },
      ],
      expected: {
        text: "Claude says hello",
        sessionId: "session-123",
        usage: normalizedUsage({ input: 12, output: 3, cacheRead: 4 }),
      },
    },
    {
      name: "parses Claude stream-json result events for an explicit backend dialect",
      command: "local-cli",
      jsonlDialect: "claude-stream-json" as const,
      providerId: "local-cli",
      frames: [
        { type: "init", session_id: "session-dialect" },
        {
          type: "result",
          session_id: "session-dialect",
          result: "dialect says hello",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      ],
      expected: {
        text: "dialect says hello",
        sessionId: "session-dialect",
        usage: normalizedUsage({ input: 5, output: 2 }),
      },
    },
  ])("$name", ({ command, jsonlDialect, providerId, frames, expected }) => {
    const result = parseCliJsonl(
      joinJsonlFrames(...frames),
      {
        command,
        output: "jsonl",
        ...(jsonlDialect ? { jsonlDialect } : {}),
        sessionIdFields: ["session_id"],
      },
      providerId,
    );

    expect(result).toEqual(expected);
  });

  it("keeps streamed pre-tool text over the final-message result in transcript reparses", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-reparse" }),
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Marker caribou-lampion-473 explanation." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-1", name: "session_status" },
          },
        }),
        JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "TEST DONE" },
          },
        }),
        JSON.stringify({ type: "result", session_id: "session-reparse", result: "TEST DONE" }),
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
      text: "Marker caribou-lampion-473 explanation.\n\nTEST DONE",
      sessionId: "session-reparse",
      usage: undefined,
    });
  });

  it("continues transcript reparses past an interim result", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-interim-reparse" }),
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Interim answer." },
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-interim-reparse",
          result: "Interim answer.",
        }),
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Pre-tool follow-up." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-2", name: "session_status" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "DONE" },
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-interim-reparse",
          result: "DONE",
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

    expect(result?.text).toBe("Interim answer.\nPre-tool follow-up.\n\nDONE");
  });

  it.each([
    {
      name: "parses Gemini stream-json message and result events",
      frames: [
        {
          type: "init",
          timestamp: "2026-06-16T19:36:46.000Z",
          session_id: "gemini-session-123",
          model: "gemini-3.1-pro-preview",
        },
        {
          type: "message",
          timestamp: "2026-06-16T19:36:47.000Z",
          role: "assistant",
          content: "Gemini says ",
          delta: true,
        },
        {
          type: "message",
          timestamp: "2026-06-16T19:36:48.000Z",
          role: "assistant",
          content: "hello",
          delta: true,
        },
        {
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "success",
          stats: { total_tokens: 21, input_tokens: 13, output_tokens: 5, cached: 8, input: 5 },
        },
      ],
      sessionIdFields: ["session_id"],
      expected: {
        text: "Gemini says hello",
        sessionId: "gemini-session-123",
        usage: normalizedUsage({ input: 5, output: 5, cacheRead: 8, total: 21 }),
      },
    },
    {
      name: "keeps Gemini tool-only stream-json output structured instead of raw JSONL",
      frames: [
        {
          type: "init",
          timestamp: "2026-06-16T19:36:46.000Z",
          session_id: "gemini-session-123",
          model: "gemini-3.1-pro-preview",
        },
        {
          type: "tool_use",
          timestamp: "2026-06-16T19:36:47.000Z",
          tool_name: "mcp_openclaw_create_goal",
          tool_id: "tool-1",
          parameters: { objective: "Update files" },
        },
        {
          type: "tool_result",
          timestamp: "2026-06-16T19:36:48.000Z",
          tool_id: "tool-1",
          status: "success",
          output: "created",
        },
        {
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "success",
          stats: { total_tokens: 2, input_tokens: 1, output_tokens: 1 },
        },
      ],
      sessionIdFields: ["session_id"],
      expected: {
        text: "",
        sessionId: "gemini-session-123",
        usage: normalizedUsage({ input: 1, output: 1, total: 2 }),
      },
    },
    {
      name: "parses Gemini stream-json result errors as provider errors",
      frames: [
        {
          type: "message",
          timestamp: "2026-06-16T19:36:47.000Z",
          role: "assistant",
          content: "partial output",
          delta: true,
        },
        {
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          error: { message: "Gemini stream failed" },
        },
      ],
      sessionIdFields: undefined,
      expected: {
        text: "",
        sessionId: undefined,
        usage: undefined,
        errorText: "Gemini stream failed",
      },
    },
    {
      name: "keeps detailed Gemini stream-json error events over generic result errors",
      frames: [
        {
          type: "error",
          timestamp: "2026-06-16T19:36:48.000Z",
          severity: "error",
          message: "Invalid stream payload",
        },
        {
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          stats: { total_tokens: 1 },
        },
      ],
      sessionIdFields: undefined,
      expected: {
        text: "",
        sessionId: undefined,
        usage: normalizedUsage({ total: 1 }),
        errorText: "Invalid stream payload",
      },
    },
  ])("$name", ({ frames, sessionIdFields, expected }) => {
    const result = parseCliJsonl(
      joinJsonlFrames(...frames),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
        ...(sessionIdFields ? { sessionIdFields } : {}),
      },
      "google-gemini-cli",
    );

    expect(result).toEqual(expected);
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

  it("captures the last Claude assistant transcript UUID as a resume checkpoint", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "session-checkpoint" }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-checkpoint-1",
          message: {
            id: "provider-message-1",
            role: "assistant",
            content: [{ type: "text", text: "first" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-checkpoint-2",
          message: {
            id: "provider-message-2",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "subagent-checkpoint",
          parent_tool_use_id: "tool-use-1",
          message: {
            id: "provider-subagent-message",
            role: "assistant",
            content: [{ type: "text", text: "nested" }],
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-checkpoint",
          result: "done",
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result?.resumeCheckpointId).toBe("assistant-checkpoint-2");
  });

  it.each([
    {
      name: "preserves Claude session metadata even when the final result text is empty",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-456" },
        {
          type: "result",
          session_id: "session-456",
          result: "   ",
          usage: { input_tokens: 18, output_tokens: 0 },
        },
      ),
      expected: {
        text: "",
        sessionId: "session-456",
        usage: normalizedUsage({ input: 18 }),
      },
    },
    {
      name: "preserves streamed Claude text when the final result text is empty",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-456" },
        claudeTextDelta("Hello"),
        claudeTextDelta(" world"),
        {
          type: "result",
          session_id: "session-456",
          result: "",
          usage: { input_tokens: 18, output_tokens: 4 },
        },
      ),
      expected: {
        text: "Hello world",
        sessionId: "session-456",
        usage: normalizedUsage({ input: 18, output: 4 }),
      },
    },
    {
      name: "unwraps nested Claude agent result JSON from stream-json output",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-nested-jsonl" },
        {
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
        },
      ),
      expected: {
        text: "actual response text",
        sessionId: "session-nested-jsonl",
        usage: undefined,
      },
    },
    {
      name: "parses multiple JSON objects embedded on the same line",
      raw: '{"type":"init","session_id":"session-999"} {"type":"result","session_id":"session-999","result":"done"}',
      expected: { text: "done", sessionId: "session-999", usage: undefined },
    },
  ])("$name", ({ raw, expected }) => {
    const result = parseCliJsonl(
      raw,
      { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
      "claude-cli",
    );

    expect(result).toEqual(expected);
  });

  it("captures the last Claude session_id when an ephemeral id precedes the canonical one", () => {
    // claude-cli emits ephemeral session_ids from SessionStart hooks before the
    // canonical resumed session_id surfaces in the init event and the terminal
    // result event. First-wins capture would bind to the ephemeral id whose
    // transcript JSONL never lands on disk; last-wins captures the canonical id.
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "session-ephemeral" }),
        JSON.stringify({ type: "system", subtype: "init", session_id: "session-canonical" }),
        JSON.stringify({
          type: "result",
          session_id: "session-canonical",
          result: "rotated reply",
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result?.sessionId).toBe("session-canonical");
    expect(result?.text).toBe("rotated reply");
  });

  it("preserves terminal cumulative usage when reparsing completed Claude JSONL", () => {
    const output = parseCliJsonl(
      readFileSync("test/fixtures/cli/claude-2.1-thinking-progress.jsonl", "utf8"),
      {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(output.usage).toEqual({
      input: 4418,
      output: 5,
      cacheRead: undefined,
      cacheWrite: 36955,
      total: undefined,
    });
    expect(output.diagnosticUsage).toEqual({
      input: 4418,
      output: 534,
      cacheRead: undefined,
      cacheWrite: 36955,
      total: undefined,
    });
  });

  it.each([
    {
      name: "resets per-index thinking state on a new message within the same turn (tool round-trip)",
      frames: [
        claudeMessageStart("msg-A"),
        claudeThinkingDelta("Hello ", 0),
        claudeThinkingDelta("world", 0),
        claudeAssistantSnapshot("msg-A", [{ type: "thinking", thinking: "Hello world" }]),
        claudeMessageStart("msg-B"),
        claudeThinkingDelta("New ", 0),
        claudeThinkingDelta("thought", 0),
        claudeAssistantSnapshot("msg-B", [{ type: "thinking", thinking: "New thought" }]),
      ],
      expected: [
        { text: "Hello ", delta: "Hello ", isReasoningSnapshot: true },
        { text: "Hello world", delta: "world", isReasoningSnapshot: true },
        { text: "New ", delta: "New ", isReasoningSnapshot: true },
        { text: "New thought", delta: "thought", isReasoningSnapshot: true },
      ],
    },
    {
      name: "ignores indexless thinking deltas without content block framing",
      frames: [claudeThinkingDelta("orphaned"), claudeThinkingDelta("also orphaned", "0")],
      expected: [],
    },
  ])("$name", ({ frames, expected }) => {
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: () => {},
      onThinkingDelta: (delta) => thinking.push(delta),
    });

    parser.push(joinJsonlFrames(...frames));
    parser.finish();

    expect(thinking).toEqual(expected);
  });
});
