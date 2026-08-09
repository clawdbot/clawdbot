/** Tests CLI JSON/JSONL output parsing, streamed deltas, and error extraction. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  formatCliOutputError,
  parseCliOutput,
  type CliThinkingProgress,
  type CliToolResultDelta,
  type CliToolUseStartDelta,
} from "./cli-output.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

const OPENAI_COMPATIBLE_CLI_USAGE_CASES = [
  {
    name: "standard OpenAI snake_case token fields",
    raw: {
      prompt_tokens: 17,
      completion_tokens: 5,
      total_tokens: 22,
      prompt_tokens_details: { cached_tokens: 6 },
    },
    normalized: { input: 11, output: 5, cacheRead: 6, cacheWrite: undefined, total: 22 },
  },
  {
    name: "camelCase OpenAI-compatible token fields",
    raw: {
      promptTokens: 17,
      completionTokens: 5,
      total_tokens: 22,
      prompt_tokens_details: { cached_tokens: 6 },
    },
    normalized: { input: 11, output: 5, cacheRead: 6, cacheWrite: undefined, total: 22 },
  },
  {
    name: "existing input/output field precedence",
    raw: {
      input_tokens: 19,
      prompt_tokens: 99,
      output_tokens: 7,
      completion_tokens: 77,
      total_tokens: 26,
      prompt_tokens_details: { cached_tokens: 4 },
    },
    normalized: { input: 15, output: 7, cacheRead: 4, cacheWrite: undefined, total: 26 },
  },
  {
    name: "flat Codex cached input is included in input_tokens",
    raw: {
      input_tokens: 15,
      output_tokens: 4,
      cached_input_tokens: 6,
    },
    normalized: { input: 9, output: 4, cacheRead: 6, cacheWrite: undefined, total: undefined },
  },
  {
    name: "flat Codex input includes both cached reads and cache writes",
    raw: {
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 40,
      cache_write_input_tokens: 60,
    },
    normalized: { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: undefined },
  },
  {
    name: "nested Codex input includes both cached reads and cache writes",
    raw: {
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
    },
    normalized: { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: undefined },
  },
] as const;

function parseCliJson(raw: string, backend: ParseCliOutputParams["backend"], providerId = "") {
  return parseCliOutput({ raw, backend, providerId, outputMode: "json" });
}

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

function claudeBlockStop(index?: number) {
  return claudeStreamEvent({
    type: "content_block_stop",
    ...(index === undefined ? {} : { index }),
  });
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

function claudeInputJsonDelta(partialJson: string, index?: number) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "input_json_delta", partial_json: partialJson },
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

describe("parseCliJson", () => {
  it.each([
    {
      name: "preserves Claude max-turn terminal context in JSON mode",
      input: {
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-json-max-turns",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (3)"],
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-max-turns",
        usage: undefined,
        errorText: "Reached maximum number of turns (3)",
        terminalFailure: { reason: "max_turns", limit: 3 },
      },
    },
    {
      name: "classifies Claude is_error JSON results as provider errors",
      input: {
        type: "result",
        subtype: "success",
        is_error: true,
        result: 'API Error: 400 {"error":{"message":"Bad request"}}',
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: undefined,
        usage: undefined,
        errorText: "Bad request",
      },
    },
    {
      name: "classifies generic is_error JSON results as provider errors",
      input: { is_error: true, result: "429 rate limit exceeded" },
      command: "custom",
      sessionIdFields: undefined,
      providerId: "custom-cli",
      expected: {
        text: "",
        sessionId: undefined,
        usage: undefined,
        errorText: "429 rate limit exceeded",
      },
    },
    {
      name: "keeps successful JSON result message payloads as assistant text",
      input: { type: "result", message: "done" },
      command: "custom",
      sessionIdFields: undefined,
      providerId: "custom-cli",
      expected: { text: "done", sessionId: undefined, usage: undefined },
    },
    {
      name: "does not classify null JSON result error fields as provider errors",
      input: { type: "result", error: null, message: "done" },
      command: "custom",
      sessionIdFields: undefined,
      providerId: "custom-cli",
      expected: { text: "done", sessionId: undefined, usage: undefined },
    },
    {
      name: "classifies JSON status error result payloads as provider errors",
      input: { type: "result", status: "error", result: "rate limit" },
      command: "custom",
      sessionIdFields: undefined,
      providerId: "custom-cli",
      expected: {
        text: "",
        sessionId: undefined,
        usage: undefined,
        errorText: "rate limit",
      },
    },
  ])("$name", ({ input, command, sessionIdFields, providerId, expected }) => {
    const result = parseCliJson(
      JSON.stringify(input),
      { command, output: "json", ...(sessionIdFields ? { sessionIdFields } : {}) },
      providerId,
    );

    expect(result).toEqual(expected);
  });

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

  it.each([
    {
      name: "parses Gemini CLI response text and stats payloads",
      input: {
        session_id: "gemini-session-123",
        response: "Gemini says hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      },
      expected: {
        text: "Gemini says hello",
        sessionId: "gemini-session-123",
        usage: normalizedUsage({ input: 5, output: 5, cacheRead: 8, total: 21 }),
      },
    },
    {
      name: "falls back to Gemini stats when usage exists without token fields",
      input: {
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
      },
      expected: {
        text: "Gemini says hello",
        sessionId: "gemini-session-789",
        usage: normalizedUsage({ input: 5, output: 5, cacheRead: 8, total: 21 }),
      },
    },
  ])("$name", ({ input, expected }) => {
    const result = parseCliJson(JSON.stringify(input), {
      command: "gemini",
      output: "json",
      sessionIdFields: ["session_id"],
    });

    expect(result).toEqual(expected);
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

  it.each(OPENAI_COMPATIBLE_CLI_USAGE_CASES)(
    "normalizes $name from CLI JSON output",
    ({ raw, normalized }) => {
      const result = parseCliJson(
        JSON.stringify({
          session_id: "openai-compatible-session",
          response: "OpenAI-compatible response",
          usage: raw,
        }),
        {
          command: "openai-compatible",
          output: "json",
          sessionIdFields: ["session_id"],
        },
        "openai-compatible-cli",
      );

      expect(result).toEqual({
        text: "OpenAI-compatible response",
        sessionId: "openai-compatible-session",
        usage: normalized,
      });
    },
  );
});

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

  it.each(OPENAI_COMPATIBLE_CLI_USAGE_CASES)(
    "normalizes $name from CLI JSONL output",
    ({ raw, normalized }) => {
      const result = parseCliJsonl(
        [
          JSON.stringify({ type: "init", session_id: "openai-compatible-session" }),
          JSON.stringify({
            type: "result",
            session_id: "openai-compatible-session",
            result: "OpenAI-compatible response",
            usage: raw,
          }),
        ].join("\n"),
        {
          command: "openai-compatible",
          output: "jsonl",
          jsonlDialect: "claude-stream-json",
          sessionIdFields: ["session_id"],
        },
        "openai-compatible-cli",
      );

      expect(result).toEqual({
        text: "OpenAI-compatible response",
        sessionId: "openai-compatible-session",
        usage: normalized,
      });
    },
  );

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

  it("keeps detailed Gemini stream-json result errors over generic error events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({
          type: "error",
          timestamp: "2026-06-16T19:36:48.000Z",
          severity: "error",
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          error: { message: "Final Gemini failure" },
        }),
      ].join("\n"),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      "google-gemini-cli",
    );

    expect(result?.errorText).toBe("Final Gemini failure");
  });

  it("does not treat Gemini stream-json warning events as provider errors", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({
          type: "error",
          timestamp: "2026-06-16T19:36:46.000Z",
          severity: "warning",
          message: "Loop detected, stopping execution",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-16T19:36:47.000Z",
          role: "assistant",
          content: "final output",
          delta: true,
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "success",
        }),
      ].join("\n"),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      "google-gemini-cli",
    );

    expect(result).toEqual({
      text: "final output",
      sessionId: undefined,
      usage: undefined,
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

  it("extracts nested Claude API errors from failed stream-json output", () => {
    const { message, jsonl } = createClaudeApiErrorFixture();
    const result = extractCliErrorMessage(jsonl);

    expect(result).toBe(message);
  });

  it("classifies Claude is_error stream-json results as provider errors", () => {
    const { message, jsonl } = createClaudeApiErrorFixture();
    const result = parseCliJsonl(
      jsonl,
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-api-error",
      usage: undefined,
      errorText: message,
    });
  });

  it("preserves Claude max-turn terminal context for actionable run errors", () => {
    const result = parseCliJsonl(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-max-turns",
        num_turns: 2,
        stop_reason: "tool_use",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (1)"],
      }),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-max-turns",
      usage: undefined,
      errorText: "Reached maximum number of turns (1)",
      terminalFailure: {
        reason: "max_turns",
        limit: 1,
      },
    });
    expect(
      formatCliOutputError(result!, {
        runId: "run-max-turns",
        sessionId: "openclaw-session-max-turns",
      }),
    ).toBe(
      "Claude CLI stopped after reaching the maximum number of turns (limit: 1). " +
        "OpenClaw run: run-max-turns. OpenClaw session: openclaw-session-max-turns. " +
        "Claude session: session-max-turns. Tool actions may already have run; verify their effects before retrying. " +
        "Retry with a higher --max-turns value or a narrower task.",
    );
  });

  it("warns that terminal_reason-only max-turn results may have run tools", () => {
    const result = parseCliJsonl(
      JSON.stringify({
        type: "result",
        session_id: "session-terminal-reason-only",
        terminal_reason: "max_turns",
      }),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-terminal-reason-only",
      usage: undefined,
      errorText: "Reached maximum number of turns.",
      terminalFailure: { reason: "max_turns" },
    });
    expect(formatCliOutputError(result!)).toBe(
      "Claude CLI stopped after reaching the maximum number of turns. " +
        "Claude session: session-terminal-reason-only. " +
        "Tool actions may already have run; verify their effects before retrying. " +
        "Retry with a higher --max-turns value or a narrower task.",
    );
  });

  it("does not apply Claude terminal semantics to an explicit Gemini dialect", () => {
    const result = parseCliJsonl(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (1)"],
      }),
      {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      "claude-cli",
    );

    expect(result?.terminalFailure).toBeUndefined();
  });
});

describe("parseCliOutput", () => {
  it.each([
    {
      name: "uses streamed Claude assistant text when the result envelope is missing",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-stream-missing-result" },
        claudeTextDelta("partial answer"),
      ),
      expected: {
        text: "partial answer",
        sessionId: "session-stream-missing-result",
        usage: undefined,
      },
    },
    {
      name: "fails stream-json output without result or assistant text instead of returning raw JSONL",
      raw: JSON.stringify({ type: "init", session_id: "session-empty" }),
      expected: {
        text: "",
        sessionId: "session-empty",
        usage: undefined,
        errorText: "CLI stream-json output ended without a result event.",
      },
    },
  ])("$name", ({ raw, expected }) => {
    const result = parseCliOutput({
      raw,
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      outputMode: "jsonl",
    });

    expect(result).toEqual(expected);
  });
});

describe("createCliJsonlStreamingParser", () => {
  function createClaudeTaggedReasoningHarness() {
    const assistant: Array<{ text: string; delta: string }> = [];
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: (delta) => assistant.push(delta),
      onThinkingDelta: (delta) => thinking.push(delta),
    });
    return { assistant, parser, thinking };
  }

  it.each(OPENAI_COMPATIBLE_CLI_USAGE_CASES)(
    "normalizes $name while incrementally streaming CLI JSONL",
    ({ raw, normalized }) => {
      const parser = createCliJsonlStreamingParser({
        backend: {
          command: "openai-compatible",
          output: "jsonl",
          jsonlDialect: "claude-stream-json",
          sessionIdFields: ["session_id"],
        },
        providerId: "openai-compatible-cli",
        onAssistantDelta: () => {},
      });

      parser.push(
        [
          JSON.stringify({ type: "init", session_id: "openai-compatible-session" }),
          JSON.stringify({
            type: "result",
            session_id: "openai-compatible-session",
            result: "OpenAI-compatible response",
            usage: raw,
          }),
          "",
        ].join("\n"),
      );
      parser.finish();

      expect(parser.getOutput()).toEqual({
        text: "OpenAI-compatible response",
        sessionId: "openai-compatible-session",
        usage: normalized,
      });
    },
  );

  it("surfaces codex-exec todo snapshots as typed plan updates", () => {
    const plans: Array<{ steps: Array<{ step: string; status: string }> }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "codex", output: "jsonl", sessionIdFields: ["thread_id"] },
      providerId: "codex-cli",
      onAssistantDelta: () => {},
      onPlanUpdate: (plan) => plans.push(plan),
    });

    parser.push(
      `${JSON.stringify({
        type: "item.updated",
        item: {
          type: "todo_list",
          items: [
            { text: "Inspect", completed: true },
            { text: "Patch", completed: false },
          ],
        },
      })}\n`,
    );

    expect(plans).toEqual([
      {
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "pending" },
        ],
      },
    ]);
  });

  it("streams Claude stream-json deltas for an explicit backend dialect", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const sessionIds: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
      onSessionId: (sessionId) => sessionIds.push(sessionId),
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
    expect(sessionIds).toEqual(["session-stream"]);
  });

  it.each([
    {
      name: "uses streamed Claude assistant text when no result envelope arrives",
      frames: [
        { type: "init", session_id: "session-stream-no-result" },
        claudeTextDelta("streamed answer"),
      ],
      expected: {
        text: "streamed answer",
        sessionId: "session-stream-no-result",
        usage: undefined,
      },
    },
    {
      name: "preserves streamed Claude text when the final result event is empty",
      frames: [
        { type: "init", session_id: "session-stream" },
        claudeTextDelta("hello"),
        claudeTextDelta(" world"),
        { type: "result", session_id: "session-stream", result: "" },
      ],
      expected: {
        text: "hello world",
        sessionId: "session-stream",
        usage: undefined,
      },
    },
  ])("$name", ({ frames, expected }) => {
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

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(parser.getOutput()).toEqual(expected);
  });

  it("keeps streamed pre-tool text when the result envelope carries only the final message", () => {
    const deltas: Array<{ text: string; delta?: string }> = [];
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
        JSON.stringify({ type: "init", session_id: "session-tool-split" }),
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
        JSON.stringify({ type: "result", session_id: "session-tool-split", result: "TEST DONE" }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "Marker caribou-lampion-473 explanation.\n\nTEST DONE",
      sessionId: "session-tool-split",
      usage: undefined,
    });
    // Cumulative text must stay reconstructible from deltas for preview streams.
    expect(deltas.map((entry) => entry.delta).join("")).toBe(
      "Marker caribou-lampion-473 explanation.\n\nTEST DONE",
    );
    expect(deltas.at(-1)?.text).toBe("Marker caribou-lampion-473 explanation.\n\nTEST DONE");
  });

  it.each([
    {
      name: "keeps pre-tool text when text, tool_use, and text share one assistant message",
      frames: [
        { type: "init", session_id: "session-single-message" },
        claudeMessageStart(),
        claudeTextDelta("Marker caribou-lampion-473 explanation."),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "session_status" }),
        claudeTextDelta("TEST DONE"),
        { type: "result", session_id: "session-single-message", result: "TEST DONE" },
      ],
      expectedText: "Marker caribou-lampion-473 explanation.\n\nTEST DONE",
    },
    {
      name: "keeps pre-tool text when a toolless closer message follows a tool-using message",
      frames: [
        { type: "init", session_id: "session-closer" },
        claudeMessageStart(),
        claudeTextDelta("Pre-tool analysis."),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "session_status" }),
        claudeTextDelta("Post-tool summary."),
        claudeMessageStop(),
        claudeMessageStart(),
        claudeTextDelta("DONE"),
        { type: "result", session_id: "session-closer", result: "DONE" },
      ],
      expectedText: "Pre-tool analysis.\n\nPost-tool summary.\n\nDONE",
    },
  ])("$name", ({ frames, expectedText }) => {
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

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(parser.getOutput()?.text).toBe(expectedText);
  });

  it("judges post-interim-result segments on their own stream state", () => {
    const deltas: Array<{ text: string; delta?: string }> = [];
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
        JSON.stringify({ type: "init", session_id: "session-interim" }),
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
          session_id: "session-interim",
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
        JSON.stringify({ type: "result", session_id: "session-interim", result: "DONE" }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(parser.getOutput()?.text).toBe("Interim answer.\nPre-tool follow-up.\n\nDONE");
    // Preview snapshots stay cumulative across the interim result.
    expect(deltas.at(-1)?.text).toBe("Interim answer.\n\nPre-tool follow-up.\n\nDONE");
    expect(deltas.map((entry) => entry.delta).join("")).toBe(
      "Interim answer.\n\nPre-tool follow-up.\n\nDONE",
    );
  });

  it.each([
    {
      name: "does not duplicate existing newlines at message boundaries",
      frames: [
        { type: "init", session_id: "session-newlines" },
        claudeMessageStart(),
        claudeTextDelta("Pre-tool explanation.\n\n"),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "session_status" }),
        claudeMessageStart(),
        claudeTextDelta("TEST DONE"),
        { type: "result", session_id: "session-newlines", result: "TEST DONE" },
      ],
      expectedText: "Pre-tool explanation.\n\nTEST DONE",
    },
    {
      name: "keeps a later tool split's pre-tool text after an earlier ordinary boundary",
      frames: [
        { type: "init", session_id: "session-mixed" },
        claudeMessageStart(),
        claudeTextDelta("Superseded draft."),
        claudeMessageStop(),
        claudeMessageStart(),
        claudeTextDelta("Important pre-tool text."),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "session_status" }),
        claudeTextDelta("DONE"),
        { type: "result", session_id: "session-mixed", result: "DONE" },
      ],
      expectedText: "Important pre-tool text.\n\nDONE",
    },
    {
      name: "drops an earlier draft when a fresh message starts with a tool call",
      frames: [
        { type: "init", session_id: "session-tool-first" },
        claudeMessageStart(),
        claudeTextDelta("Superseded draft."),
        claudeMessageStop(),
        claudeMessageStart(),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "session_status" }),
        claudeTextDelta("Fresh answer."),
        { type: "result", session_id: "session-tool-first", result: "Fresh answer." },
      ],
      expectedText: "Fresh answer.",
    },
    {
      name: "defers to the result envelope across message boundaries without a tool split",
      frames: [
        { type: "init", session_id: "session-draft" },
        claudeMessageStart(),
        claudeTextDelta("Superseded draft."),
        claudeMessageStop(),
        claudeMessageStart(),
        claudeTextDelta("Final answer."),
        { type: "result", session_id: "session-draft", result: "Final answer." },
      ],
      expectedText: "Final answer.",
    },
  ])("$name", ({ frames, expectedText }) => {
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

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(parser.getOutput()?.text).toBe(expectedText);
  });

  it.each([
    {
      name: "defers to the result envelope on a suffix match inside a single message",
      frames: [
        { type: "init", session_id: "session-suffix" },
        claudeMessageStart(),
        claudeTextDelta("discarded draft authoritative result"),
        { type: "result", session_id: "session-suffix", result: "authoritative result" },
      ],
      expected: {
        text: "authoritative result",
        sessionId: "session-suffix",
        usage: undefined,
      },
    },
    {
      name: "prefers the result envelope when streamed text diverges from it",
      frames: [
        { type: "init", session_id: "session-diverged" },
        claudeTextDelta("draft wording"),
        { type: "result", session_id: "session-diverged", result: "authoritative result" },
      ],
      expected: {
        text: "authoritative result",
        sessionId: "session-diverged",
        usage: undefined,
      },
    },
  ])("$name", ({ frames, expected }) => {
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

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(parser.getOutput()).toEqual(expected);
  });

  it("promotes complete leading tagged Claude reasoning and keeps only the answer visible", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      [
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "<thinking>Private analysis.</thinking>Visible answer.",
            },
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-tagged",
          result: "<thinking>Private analysis.</thinking>Visible answer.",
        }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      {
        text: "Private analysis.",
        delta: "Private analysis.",
        isReasoningSnapshot: true,
      },
    ]);
    expect(assistant).toEqual([
      {
        text: "Visible answer.",
        delta: "Visible answer.",
        sessionId: undefined,
        usage: undefined,
      },
    ]);
    expect(parser.getOutput()).toEqual({
      text: "Visible answer.",
      sessionId: "session-tagged",
      usage: undefined,
    });
  });

  it("holds chunk-split tagged reasoning until its close tag is complete", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();
    const pushText = (text: string) =>
      parser.push(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        })}\n`,
      );

    pushText("<thi");
    pushText("nking>Private ");
    expect(assistant).toEqual([]);
    expect(thinking).toEqual([]);
    pushText("analysis.</think");
    expect(assistant).toEqual([]);
    expect(thinking).toEqual([]);
    pushText("ing>Visible answer.");
    parser.finish();

    expect(thinking.at(-1)?.text).toBe("Private analysis.");
    expect(assistant.at(-1)?.text).toBe("Visible answer.");
    expect(parser.getOutput()?.text).toBe("Visible answer.");
  });

  it("streams rejected angle prefixes while valid split reasoning stays buffered", () => {
    const visible = createClaudeTaggedReasoningHarness();
    const mixed = createClaudeTaggedReasoningHarness();
    const tagged = createClaudeTaggedReasoningHarness();
    const pushText = (parser: ReturnType<typeof createCliJsonlStreamingParser>, text: string) =>
      parser.push(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        })}\n`,
      );

    pushText(visible.parser, "<div>Visible prefix <thi");
    expect(visible.assistant.at(-1)?.text).toBe("<div>Visible prefix <thi");
    expect(visible.parser.getOutput()?.text).toBe("<div>Visible prefix <thi");

    pushText(mixed.parser, "<div>Visible prefix ");
    pushText(mixed.parser, "<thi");
    expect(mixed.assistant.at(-1)?.text).toBe("<div>Visible prefix <thi");
    expect(mixed.parser.getOutput()?.text).toBe("<div>Visible prefix <thi");

    pushText(tagged.parser, "<thi");
    pushText(tagged.parser, "nking>Private analysis.");
    expect(tagged.assistant).toEqual([]);
    expect(tagged.thinking).toEqual([]);
    pushText(tagged.parser, "</thinking>Visible answer.");
    expect(tagged.thinking.at(-1)?.text).toBe("Private analysis.");
    expect(tagged.assistant.at(-1)?.text).toBe("Visible answer.");
  });

  it("promotes consecutive leading blocks but preserves later literal tags", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: [
              "<think>First.</think>",
              "<reasoning>Second.</reasoning>",
              "Answer with <think>literal</think> markup.",
            ].join("\n"),
          },
        },
      })}\n`,
    );
    parser.finish();

    expect(thinking.map((entry) => entry.text)).toEqual(["First.Second."]);
    expect(assistant.at(-1)?.text).toBe("\nAnswer with <think>literal</think> markup.");
    expect(parser.getOutput()?.text).toBe("Answer with <think>literal</think> markup.");
  });

  it("prefers native Claude thinking over a mirrored leading tagged block", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Native analysis." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "text_delta",
              text: "<thinking>Native analysis.</thinking>Visible answer.",
            },
          },
        }),
        JSON.stringify({
          type: "result",
          result: "<thinking>Native analysis.</thinking>Visible answer.",
        }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "Native analysis.", delta: "Native analysis.", isReasoningSnapshot: true },
    ]);
    expect(assistant.at(-1)?.text).toBe("Visible answer.");
    expect(parser.getOutput()?.text).toBe("Visible answer.");
  });

  it.each([
    {
      name: "fenced code example",
      text: "```xml\n<thinking>literal example</thinking>\n```",
    },
    { name: "incomplete leading tag", text: "<thinking>unfinished visible text" },
    { name: "malformed leading tag", text: "<thinking broken visible text" },
  ])("preserves $name on the visible path", ({ text }) => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      })}\n`,
    );
    parser.finish();

    expect(thinking).toEqual([]);
    expect(assistant.map((entry) => entry.delta).join("")).toBe(text);
    expect(parser.getOutput()?.text).toBe(text);
  });

  it("resets tagged reasoning across Claude tool-round assistant messages", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();
    const textEvent = (text: string) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      });

    parser.push(
      [
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        textEvent("<think>First thought.</think>Before tool."),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-1", name: "Read" },
          },
        }),
        JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        textEvent("<reasoning>Second thought.</reasoning>Final answer."),
        JSON.stringify({ type: "result", result: "Final answer." }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking.map((entry) => entry.text)).toEqual(["First thought.", "Second thought."]);
    expect(assistant.at(-1)?.text).toBe("Before tool.\n\nFinal answer.");
    expect(parser.getOutput()?.text).toBe("Before tool.\n\nFinal answer.");
  });

  it.each([
    {
      name: "streams thinking deltas, skips signature deltas, and dedupes the snapshot",
      frames: [
        claudeThinkingDelta("Let me think", 0),
        claudeThinkingDelta(" harder.", 0),
        claudeStreamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "opaque-signature" },
        }),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "Let me think harder.", signature: "opaque-signature" },
          { type: "text", text: "Answer." },
        ]),
      ],
      expected: [
        { text: "Let me think", delta: "Let me think", isReasoningSnapshot: true },
        { text: "Let me think harder.", delta: " harder.", isReasoningSnapshot: true },
      ],
    },
    {
      name: "emits snapshot thinking blocks when no thinking deltas streamed",
      frames: [
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "Snapshot-only reasoning.", signature: "sig" },
          { type: "redacted_thinking", data: "opaque-blob" },
          { type: "text", text: "Answer." },
        ]),
      ],
      expected: [
        {
          text: "Snapshot-only reasoning.",
          delta: "Snapshot-only reasoning.",
          isReasoningSnapshot: true,
        },
      ],
    },
    {
      name: "replaces per-index thinking when assistant snapshots revise non-prefix text",
      frames: [
        claudeThinkingDelta("rough draft", 0),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "revised thought", signature: "sig" },
          { type: "text", text: "Answer." },
        ]),
      ],
      expected: [
        { text: "rough draft", delta: "rough draft", isReasoningSnapshot: true },
        { text: "revised thought", delta: "revised thought", isReasoningSnapshot: true },
      ],
    },
    {
      name: "dedupes per content-block index across multiple thinking blocks",
      frames: [
        claudeThinkingDelta("A", 0),
        claudeThinkingDelta("B", 1),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "A", signature: "sig-a" },
          { type: "thinking", thinking: "B", signature: "sig-b" },
        ]),
      ],
      expected: [
        { text: "A", delta: "A", isReasoningSnapshot: true },
        { text: "AB", delta: "B", isReasoningSnapshot: true },
      ],
    },
    {
      name: "dedupes snapshot thinking after tool-interleaved multi-block streaming",
      frames: [
        claudeThinkingDelta("A", 0),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "Read" }, 1),
        claudeInputJsonDelta('{"file_path":"x"}', 1),
        claudeBlockStop(1),
        claudeThinkingDelta("B", 2),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "A", signature: "sig-a" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } },
          { type: "thinking", thinking: "B", signature: "sig-b" },
        ]),
      ],
      expected: [
        { text: "A", delta: "A", isReasoningSnapshot: true },
        { text: "AB", delta: "B", isReasoningSnapshot: true },
      ],
    },
    {
      name: "streams indexless thinking deltas from content block framing",
      frames: [
        claudeMessageStart("msg-1"),
        claudeBlockStart({ type: "thinking" }),
        claudeThinkingDelta("A"),
        claudeBlockStop(),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "Read" }),
        claudeInputJsonDelta('{"file_path":"x"}'),
        claudeBlockStop(),
        claudeBlockStart({ type: "thinking" }),
        claudeThinkingDelta("B"),
        claudeBlockStop(),
        claudeAssistantSnapshot("msg-1", [{ type: "text", text: "Answer." }]),
      ],
      expected: [
        { text: "A", delta: "A", isReasoningSnapshot: true },
        { text: "AB", delta: "B", isReasoningSnapshot: true },
      ],
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

  it("emits token progress for Claude CLI 2.1 empty thinking deltas", () => {
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const progress: CliThinkingProgress[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onThinkingDelta: (delta) => thinking.push(delta),
      onThinkingProgress: (payload) => progress.push(payload),
    });

    parser.push(readFileSync("test/fixtures/cli/claude-2.1-thinking-progress.jsonl", "utf8"));
    parser.finish();

    expect(thinking).toEqual([]);
    expect(progress).toEqual([
      { progressTokens: 50 },
      { progressTokens: 200 },
      { progressTokens: 300 },
    ]);
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

  it("streams Gemini result errors as provider errors", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      providerId: "google-gemini-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-16T19:36:47.000Z",
          role: "assistant",
          content: "partial output",
          delta: true,
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          error: { message: "Gemini stream failed" },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(deltas).toEqual([
      {
        text: "partial output",
        delta: "partial output",
        sessionId: undefined,
        usage: undefined,
      },
    ]);
    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "Gemini stream failed",
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

  it("turns plugin-owned JSONL parser exceptions into bounded provider errors", () => {
    let calls = 0;
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) => {
        calls += 1;
        if (line.includes("result")) {
          return { kind: "result", text: "must not replace the parser error" };
        }
        throw new Error("invalid custom event");
      },
      onAssistantDelta: () => {},
    });

    parser.push('{"type":"broken"}\n{"type":"result"}\n');
    parser.finish();

    expect(calls).toBe(1);
    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "CLI backend acme-cli JSONL parser failed: invalid custom event",
    });
  });

  it("keeps plugin-owned terminal errors ahead of later result summaries", () => {
    const usageEvents: Array<{ usage: unknown; isTerminal: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) =>
        line === "failed"
          ? { kind: "result", errorText: "provider failed" }
          : {
              kind: "result",
              text: "must not replace the provider error",
              sessionId: "late-successor",
              usage: { input: 2, output: 1, total: 3 },
            },
      onAssistantDelta: () => {},
      onUsage: (usage, isTerminal) => usageEvents.push({ usage, isTerminal }),
    });

    parser.push("failed\nsummary\n");
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: "late-successor",
      usage: { input: 2, output: 1, total: 3 },
      errorText: "provider failed",
    });
    expect(usageEvents).toEqual([{ usage: { input: 2, output: 1, total: 3 }, isTerminal: true }]);
  });

  it("preserves plugin-owned session ids emitted after terminal errors", () => {
    const sessionIds: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: () => [
        { kind: "result", errorText: "provider failed" },
        { kind: "sessionId", sessionId: "late-successor" },
      ],
      onAssistantDelta: () => {},
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    });

    parser.push("terminal\n");
    parser.finish();

    expect(sessionIds).toEqual(["late-successor"]);
    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: "late-successor",
      usage: undefined,
      errorText: "provider failed",
    });
  });

  it("preserves streamed plugin text when the terminal result text is empty", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) =>
        line === "delta"
          ? { kind: "text", text: "streamed answer" }
          : { kind: "result", text: "  " },
      onAssistantDelta: () => {},
    });

    parser.push("delta\nresult\n");
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "streamed answer",
      sessionId: undefined,
      usage: undefined,
    });
  });

  it("preserves earlier plugin result text when a later result only adds metadata", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) =>
        line === "result"
          ? { kind: "result", text: "completed answer" }
          : {
              kind: "result",
              sessionId: "summary-session",
              usage: { input: 5, output: 3, total: 8 },
            },
      onAssistantDelta: () => {},
    });

    parser.push("result\nsummary\n");
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "completed answer",
      sessionId: "summary-session",
      usage: { input: 5, output: 3, total: 8 },
    });
  });

  it("retains built-in fallback text after a plugin handles other lines", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "acme", output: "jsonl" },
      providerId: "acme-cli",
      parseJsonlEvent: (line) => {
        if (line === "session") {
          return { kind: "sessionId", sessionId: "custom-session" };
        }
        if (line === "prefix") {
          return { kind: "text", text: "streamed prefix" };
        }
        return null;
      },
      onAssistantDelta: () => {},
    });

    parser.push(
      [
        "session",
        "prefix",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "delegated answer" },
        }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "delegated answer",
      sessionId: "custom-session",
      usage: undefined,
    });
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
    expect(output?.diagnosticUsage).toEqual({
      input: 30,
      output: 15,
      cacheRead: 300,
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

    expect(starts).toEqual([
      { toolCallId: "toolu_1", name: "Bash", kind: "tool_use", args: { command: "ls -la" } },
    ]);
    expect(results).toEqual([
      { toolCallId: "toolu_1", name: "Bash", isError: false, result: "total 0\n" },
    ]);
  });

  it("frames coalesced Claude image and PDF lines before omitting retained binary bytes", () => {
    const results: CliToolResultDelta[] = [];
    const pluginLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return null;
      },
      onAssistantDelta: () => {},
      onToolResult: (result) => results.push(result),
    });
    const base64 = "a".repeat(4_300_000);
    const rawLines: string[] = [];
    for (const [type, mediaType] of [
      ["image", "image/png"],
      ["document", "application/pdf"],
    ] as const) {
      rawLines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `read-${type}`,
                is_error: type === "document",
                content: [
                  { type: "text", text: `Read ${type}` },
                  {
                    type,
                    title: `${type} attachment`,
                    source: { type: "base64", media_type: mediaType, data: base64 },
                  },
                  {
                    type: "image",
                    source: { type: "url", url: "https://example.test/keep.png" },
                  },
                  {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: "keep text" },
                  },
                ],
              },
            ],
          },
        }),
      );
    }
    const resultLine = JSON.stringify({ type: "result", result: "both attachments read" });
    parser.push(`${[...rawLines, resultLine].join("\n")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("both attachments read");
    expect(results).toHaveLength(2);
    expect(pluginLines).toEqual([...rawLines, resultLine]);
    for (const [index, type, mediaType] of [
      [0, "image", "image/png"],
      [1, "document", "application/pdf"],
    ] as const) {
      expect(results[index]).toEqual({
        toolCallId: `read-${type}`,
        name: "",
        isError: type === "document",
        result: [
          { type: "text", text: `Read ${type}` },
          {
            type,
            title: `${type} attachment`,
            source: { type: "base64", media_type: mediaType },
            omitted: true,
            bytes: 3_225_000,
          },
          { type: "image", source: { type: "url", url: "https://example.test/keep.png" } },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "keep text" },
          },
        ],
      });
    }
  });

  it.each([
    { name: "echoed media bytes", padded: false },
    { name: "surrounding raw whitespace", padded: true },
  ])("counts $name claimed by Claude plugin parsers before dispatch", ({ padded }) => {
    const pluginLines: string[] = [];
    const assistantDeltas: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return { kind: "text", text: "claimed" };
      },
      onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
    });
    const semanticLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "claimed-image",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: padded ? "YQ==" : "a".repeat(4_300_000),
                },
              },
            ],
          },
        ],
      },
    });
    const rawLine = padded ? `${" ".repeat(4_300_000)}${semanticLine}` : semanticLine;

    parser.push(`${rawLine}\n${rawLine}\n`);

    expect(pluginLines).toEqual([semanticLine, semanticLine]);
    expect(assistantDeltas).toEqual(["claimed"]);
    expect(parser.getErrorText()).toContain("JSONL output exceeded");
  });

  it("counts actual blank Claude frames without invoking hooks or inventing a finish frame", () => {
    const parseJsonlEvent = vi.fn(() => null);
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        parseJsonlEvent,
        onAssistantDelta: () => {},
      });
    const completeParser = createParser();
    completeParser.push("\r\n".repeat(20_000));
    completeParser.finish();

    expect(completeParser.getErrorText()).toBeNull();
    expect(parseJsonlEvent).not.toHaveBeenCalled();

    const overflowParser = createParser();
    overflowParser.push("\n".repeat(20_001));

    expect(overflowParser.getErrorText()).toContain("exceeded 20000 lines");
    expect(parseJsonlEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "whitespace-only records",
      createLine: () => " ".repeat(4_300_000),
    },
    {
      name: "padding around valid JSON",
      createLine: () => `${" ".repeat(4_300_000)}{}`,
    },
    {
      name: "formatting inside a compacted media record",
      createLine: () =>
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "padded-image",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "YQ==" },
                  },
                ],
              },
            ],
          },
        }).replace('"message":', `"message":${" ".repeat(4_300_000)}`),
    },
  ])("charges $name against the Claude raw-output budget", ({ createLine }) => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    const line = createLine();

    parser.push(`${line}\n${line}\n`);

    expect(parser.getErrorText()).toContain("JSONL output exceeded 8388608 characters");
  });

  it("normalizes empty Claude image data without treating zero omitted bytes as unchanged", () => {
    const results: CliToolResultDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onToolResult: (result) => results.push(result),
    });

    parser.push(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "empty-image",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "" },
                },
              ],
            },
          ],
        },
      })}\n`,
    );

    expect(results[0]?.result).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png" },
        omitted: true,
        bytes: 0,
      },
    ]);
  });

  it("still enforces raw Claude line and retained-text limits", () => {
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
      });
    const oversizedLineParser = createParser();
    oversizedLineParser.push(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "oversized-image",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "a".repeat(8 * 1024 * 1024),
                  },
                },
              ],
            },
          ],
        },
      })}\n`,
    );
    expect(oversizedLineParser.getErrorText()).toContain("JSONL line exceeded");

    const growingPartialLineParser = createParser();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toBeNull();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toContain("JSONL line exceeded");

    const oversizedTextParser = createParser();
    for (const toolCallId of ["first", "second"]) {
      oversizedTextParser.push(
        `${JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: [{ type: "text", text: "a".repeat(4_300_000) }],
              },
            ],
          },
        })}\n`,
      );
    }
    expect(oversizedTextParser.getErrorText()).toContain("JSONL output exceeded");

    const excessiveLinesParser = createParser();
    excessiveLinesParser.push("{}\n".repeat(20_001));
    expect(excessiveLinesParser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it.each([
    { providerId: "codex-cli", jsonlDialect: undefined },
    { providerId: "pi-cli", jsonlDialect: undefined },
    { providerId: "google-gemini-cli", jsonlDialect: "gemini-stream-json" as const },
  ])("preserves $providerId binary tool payloads byte-for-byte", ({ providerId, jsonlDialect }) => {
    const observedLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: providerId, output: "jsonl", ...(jsonlDialect ? { jsonlDialect } : {}) },
      providerId,
      parseJsonlEvent: (line) => {
        observedLines.push(line);
        return null;
      },
      onAssistantDelta: () => {},
    });
    const rawLine = JSON.stringify({
      type: "user",
      item: {
        type: "mcp_tool_call",
        result: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
      },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "keep-binary",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      },
    });
    parser.push(`\n \t\r\n${rawLine}\n`);

    expect(observedLines).toEqual([rawLine]);
  });

  it.each([
    {
      name: "reassembles streamed tool args from input_json_delta chunks",
      frames: [
        claudeBlockStart({ type: "tool_use", id: "toolu_chunked", name: "Bash", input: {} }, 0),
        claudeInputJsonDelta('{"command":', 0),
        claudeInputJsonDelta(' "echo hi"}', 0),
        claudeBlockStop(0),
      ],
      expected: [
        {
          toolCallId: "toolu_chunked",
          name: "Bash",
          kind: "tool_use",
          args: { command: "echo hi" },
        },
      ],
    },
    {
      name: "emits empty args when streamed tool args are malformed",
      frames: [
        claudeBlockStart({ type: "tool_use", id: "toolu_bad", name: "Bash", input: {} }, 0),
        claudeInputJsonDelta('{"command": "ls', 0),
        claudeBlockStop(0),
      ],
      expected: [{ toolCallId: "toolu_bad", name: "Bash", kind: "tool_use", args: {} }],
    },
  ])("$name", ({ frames, expected }) => {
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

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(starts).toEqual(expected);
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

  it("keeps pre-tool text in assistant deltas when no commentary consumer is wired", () => {
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
    });

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-drop-commentary" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let me inspect the repo." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "Let me inspect the repo.", delta: "Let me inspect the repo." },
    ]);
  });

  it.each([
    {
      name: "does not fire onCommentaryText when no text precedes tool_use",
      frames: [
        { type: "init", session_id: "session-no-commentary" },
        claudeBlockStart({ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }, 0),
      ],
      expectedCommentary: [],
    },
    {
      name: "does not duplicate commentary when consecutive tool_use blocks have no new text",
      frames: [
        { type: "init", session_id: "session-multi-commentary" },
        claudeTextDelta("First, checking files."),
        claudeBlockStart({ type: "tool_use", id: "toolu_1", name: "Read", input: {} }, 1),
        claudeBlockStart({ type: "tool_use", id: "toolu_2", name: "Bash", input: {} }, 2),
      ],
      expectedCommentary: ["First, checking files."],
    },
    {
      name: "emits only the new segment on text-tool-text-tool sequences",
      frames: [
        { type: "init", session_id: "session-segment" },
        claudeTextDelta("Reading the file now."),
        claudeBlockStart({ type: "tool_use", id: "toolu_a", name: "Read", input: {} }, 1),
        claudeTextDelta(" Now searching."),
        claudeBlockStart({ type: "tool_use", id: "toolu_b", name: "Grep", input: {} }, 3),
      ],
      expectedCommentary: ["Reading the file now.", "Now searching."],
    },
  ])("$name", ({ frames, expectedCommentary }) => {
    const commentaryTexts: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onCommentaryText: (text) => commentaryTexts.push(text),
    });

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(commentaryTexts).toEqual(expectedCommentary);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
