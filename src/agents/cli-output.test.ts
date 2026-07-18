/** Tests CLI JSON/JSONL output parsing, streamed deltas, and error extraction. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

function parseCliJson(raw: string, backend: ParseCliOutputParams["backend"], providerId = "") {
  return parseCliOutput({ raw, backend, providerId, outputMode: "json" });
}

function parseCliJsonl(raw: string, backend: ParseCliOutputParams["backend"], providerId: string) {
  return parseCliOutput({ raw, backend, providerId, outputMode: "jsonl" });
}

describe("parseCliJson", () => {
  it("preserves Claude max-turn terminal context in JSON mode", () => {
    const result = parseCliJson(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-json-max-turns",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (3)"],
      }),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-json-max-turns",
      usage: undefined,
      errorText: "Reached maximum number of turns (3)",
      terminalFailure: { reason: "max_turns", limit: 3 },
    });
  });

  it("classifies Claude is_error JSON results as provider errors", () => {
    const result = parseCliJson(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: 'API Error: 400 {"error":{"message":"Bad request"}}',
      }),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "Bad request",
    });
  });

  it("classifies generic is_error JSON results as provider errors", () => {
    const result = parseCliJson(
      JSON.stringify({
        is_error: true,
        result: "429 rate limit exceeded",
      }),
      {
        command: "custom",
        output: "json",
      },
      "custom-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "429 rate limit exceeded",
    });
  });

  it("keeps successful JSON result message payloads as assistant text", () => {
    const result = parseCliJson(
      JSON.stringify({
        type: "result",
        message: "done",
      }),
      {
        command: "custom",
        output: "json",
      },
      "custom-cli",
    );

    expect(result).toEqual({
      text: "done",
      sessionId: undefined,
      usage: undefined,
    });
  });

  it("does not classify null JSON result error fields as provider errors", () => {
    const result = parseCliJson(
      JSON.stringify({
        type: "result",
        error: null,
        message: "done",
      }),
      {
        command: "custom",
        output: "json",
      },
      "custom-cli",
    );

    expect(result).toEqual({
      text: "done",
      sessionId: undefined,
      usage: undefined,
    });
  });

  it("classifies JSON status error result payloads as provider errors", () => {
    const result = parseCliJson(
      JSON.stringify({
        type: "result",
        status: "error",
        result: "rate limit",
      }),
      {
        command: "custom",
        output: "json",
      },
      "custom-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "rate limit",
    });
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

  it("parses Gemini stream-json message and result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({
          type: "init",
          timestamp: "2026-06-16T19:36:46.000Z",
          session_id: "gemini-session-123",
          model: "gemini-3.1-pro-preview",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-16T19:36:47.000Z",
          role: "assistant",
          content: "Gemini says ",
          delta: true,
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-16T19:36:48.000Z",
          role: "assistant",
          content: "hello",
          delta: true,
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "success",
          stats: {
            total_tokens: 21,
            input_tokens: 13,
            output_tokens: 5,
            cached: 8,
            input: 5,
          },
        }),
      ].join("\n"),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
        sessionIdFields: ["session_id"],
      },
      "google-gemini-cli",
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

  it("keeps Gemini tool-only stream-json output structured instead of raw JSONL", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({
          type: "init",
          timestamp: "2026-06-16T19:36:46.000Z",
          session_id: "gemini-session-123",
          model: "gemini-3.1-pro-preview",
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: "2026-06-16T19:36:47.000Z",
          tool_name: "mcp_openclaw_create_goal",
          tool_id: "tool-1",
          parameters: { objective: "Update files" },
        }),
        JSON.stringify({
          type: "tool_result",
          timestamp: "2026-06-16T19:36:48.000Z",
          tool_id: "tool-1",
          status: "success",
          output: "created",
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "success",
          stats: { total_tokens: 2, input_tokens: 1, output_tokens: 1 },
        }),
      ].join("\n"),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
        sessionIdFields: ["session_id"],
      },
      "google-gemini-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "gemini-session-123",
      usage: {
        input: 1,
        output: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 2,
      },
    });
  });

  it("parses Gemini stream-json result errors as provider errors", () => {
    const result = parseCliJsonl(
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
      ].join("\n"),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      "google-gemini-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "Gemini stream failed",
    });
  });

  it("keeps detailed Gemini stream-json error events over generic result errors", () => {
    const result = parseCliJsonl(
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
      ].join("\n"),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      "google-gemini-cli",
    );

    expect(result).toEqual({
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

  it("preserves streamed Claude text when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-456" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: " world" },
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-456",
          result: "",
          usage: { input_tokens: 18, output_tokens: 4 },
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
      text: "Hello world",
      sessionId: "session-456",
      usage: {
        input: 18,
        output: 4,
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
  it("uses streamed Claude assistant text when the result envelope is missing", () => {
    const raw = [
      JSON.stringify({ type: "init", session_id: "session-stream-missing-result" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial answer" },
        },
      }),
    ].join("\n");

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

    expect(result).toEqual({
      text: "partial answer",
      sessionId: "session-stream-missing-result",
      usage: undefined,
    });
  });

  it("fails stream-json output without result or assistant text instead of returning raw JSONL", () => {
    const raw = JSON.stringify({ type: "init", session_id: "session-empty" });

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

    expect(result).toEqual({
      text: "",
      sessionId: "session-empty",
      usage: undefined,
      errorText: "CLI stream-json output ended without a result event.",
    });
  });
});

describe("createCliJsonlStreamingParser", () => {
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

  it("uses streamed Claude assistant text when no result envelope arrives", () => {
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
        JSON.stringify({ type: "init", session_id: "session-stream-no-result" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "streamed answer" },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "streamed answer",
      sessionId: "session-stream-no-result",
      usage: undefined,
    });
  });

  it("preserves streamed Claude text when the final result event is empty", () => {
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
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hello" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: " world" },
          },
        }),
        JSON.stringify({ type: "result", session_id: "session-stream", result: "" }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "hello world",
      sessionId: "session-stream",
      usage: undefined,
    });
  });

  it("reports an output-limit error and ignores later chunks", () => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        reliability: { outputLimits: { maxTurnRawChars: 1024 } },
      },
      providerId: "local-cli",
      onAssistantDelta: () => {},
    });

    parser.push("x".repeat(1025));
    parser.push(`${JSON.stringify({ type: "result", result: "late" })}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBe(
      "CLI JSONL output exceeded 1024 characters; refusing to parse output.",
    );
    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "CLI JSONL output exceeded 1024 characters; refusing to parse output.",
    });
  });

  it("streams thinking deltas, skips signature deltas, and dedupes the snapshot", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Let me think" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: " harder." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque-signature" },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              { type: "thinking", thinking: "Let me think harder.", signature: "opaque-signature" },
              { type: "text", text: "Answer." },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "Let me think", delta: "Let me think", isReasoningSnapshot: true },
      { text: "Let me think harder.", delta: " harder.", isReasoningSnapshot: true },
    ]);
  });

  it("emits snapshot thinking blocks when no thinking deltas streamed", () => {
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

    parser.push(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          content: [
            { type: "thinking", thinking: "Snapshot-only reasoning.", signature: "sig" },
            { type: "redacted_thinking", data: "opaque-blob" },
            { type: "text", text: "Answer." },
          ],
        },
      }),
    );
    parser.finish();

    expect(thinking).toEqual([
      {
        text: "Snapshot-only reasoning.",
        delta: "Snapshot-only reasoning.",
        isReasoningSnapshot: true,
      },
    ]);
  });

  it("replaces per-index thinking when assistant snapshots revise non-prefix text", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "rough draft" },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              { type: "thinking", thinking: "revised thought", signature: "sig" },
              { type: "text", text: "Answer." },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "rough draft", delta: "rough draft", isReasoningSnapshot: true },
      { text: "revised thought", delta: "revised thought", isReasoningSnapshot: true },
    ]);
  });

  it("dedupes per content-block index across multiple thinking blocks", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "A" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "thinking_delta", thinking: "B" },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              { type: "thinking", thinking: "A", signature: "sig-a" },
              { type: "thinking", thinking: "B", signature: "sig-b" },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    // Snapshot blocks "A" (index 0) and "B" (index 1) were already streamed on
    // their own indexes, so the snapshot must not re-emit either one.
    expect(thinking).toEqual([
      { text: "A", delta: "A", isReasoningSnapshot: true },
      { text: "AB", delta: "B", isReasoningSnapshot: true },
    ]);
  });

  it("dedupes snapshot thinking after tool-interleaved multi-block streaming", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "A" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tool-1", name: "Read" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"file_path":"x"}' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "B" },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              { type: "thinking", thinking: "A", signature: "sig-a" },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } },
              { type: "thinking", thinking: "B", signature: "sig-b" },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "A", delta: "A", isReasoningSnapshot: true },
      { text: "AB", delta: "B", isReasoningSnapshot: true },
    ]);
  });

  it("streams indexless thinking deltas from content block framing", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-1" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "thinking" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "A" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop" },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-1", name: "Read" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"file_path":"x"}' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop" },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "thinking" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "B" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            content: [{ type: "text", text: "Answer." }],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "A", delta: "A", isReasoningSnapshot: true },
      { text: "AB", delta: "B", isReasoningSnapshot: true },
    ]);
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

  it("resets per-index thinking state on a new message within the same turn (tool round-trip)", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-A" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Hello " },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "world" },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-A",
            content: [{ type: "thinking", thinking: "Hello world" }],
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-B" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "New " },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "thought" },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-B",
            content: [{ type: "thinking", thinking: "New thought" }],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "Hello ", delta: "Hello ", isReasoningSnapshot: true },
      { text: "Hello world", delta: "world", isReasoningSnapshot: true },
      { text: "New ", delta: "New ", isReasoningSnapshot: true },
      { text: "New thought", delta: "thought", isReasoningSnapshot: true },
    ]);
  });

  it("ignores indexless thinking deltas without content block framing", () => {
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

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "orphaned" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: "0",
            delta: { type: "thinking_delta", thinking: "also orphaned" },
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([]);
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
      {
        toolCallId: "toolu_chunked",
        name: "Bash",
        kind: "tool_use",
        args: { command: "echo hi" },
      },
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

    expect(starts).toEqual([{ toolCallId: "toolu_bad", name: "Bash", kind: "tool_use", args: {} }]);
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

  it("fires onCommentaryText with accumulated text before a tool_use block", () => {
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

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-commentary" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let me check " },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "that for you." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(commentaryTexts).toEqual(["Let me check that for you."]);
    expect(deltas).toEqual([]);
  });

  it("flushes Claude text as an assistant delta when no tool follows", () => {
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

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-answer" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Final " },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "answer." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_stop",
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(commentaryTexts).toEqual([]);
    expect(deltas).toEqual([{ text: "Final answer.", delta: "Final answer." }]);
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

  it("does not fire onCommentaryText when no text precedes tool_use", () => {
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

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-no-commentary" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(commentaryTexts).toEqual([]);
  });

  it("does not duplicate commentary when consecutive tool_use blocks have no new text", () => {
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

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-multi-commentary" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "First, checking files." },
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
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 2,
            content_block: { type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(commentaryTexts).toEqual(["First, checking files."]);
  });

  it("emits only the new segment on text-tool-text-tool sequences", () => {
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

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-segment" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Reading the file now." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_a", name: "Read", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: " Now searching." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 3,
            content_block: { type: "tool_use", id: "toolu_b", name: "Grep", input: {} },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(commentaryTexts).toEqual(["Reading the file now.", "Now searching."]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
