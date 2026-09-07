import { describe, expect, it, vi } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { parseCliOutput } from "./cli-output.js";

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
  {
    name: "all-zero token fields are treated as absent usage",
    raw: {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      total_tokens: 0,
    },
    normalized: undefined,
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

function claudeTextDelta(text: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "text_delta", text },
  });
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
      name: "records a Claude hook-stopped terminal result in JSON mode",
      input: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "session-json-hook-stopped",
        stop_reason: "tool_use",
        terminal_reason: "hook_stopped",
        result: "",
        num_turns: 4,
        permission_denials: [],
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-hook-stopped",
        usage: undefined,
        errorText:
          "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use).",
        terminalFailure: {
          reason: "turn_stopped",
          terminalReason: "hook_stopped",
          stopReason: "tool_use",
        },
      },
    },
    {
      name: "bounds and flattens the CLI-controlled terminal reason it repeats back",
      input: {
        type: "result",
        subtype: "success",
        session_id: "session-json-long-reason",
        terminal_reason: "hook_stopped",
        stop_reason: "y".repeat(200),
        result: "",
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-long-reason",
        usage: undefined,
        errorText: `Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: ${"y".repeat(64)}).`,
        terminalFailure: {
          reason: "turn_stopped",
          terminalReason: "hook_stopped",
          stopReason: "y".repeat(64),
        },
      },
    },
    {
      name: "records an aborted-tools terminal result as a turn stop",
      input: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "session-json-aborted-tools",
        stop_reason: "tool_use",
        terminal_reason: "aborted_tools",
        result: "",
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-aborted-tools",
        usage: undefined,
        errorText:
          "Claude CLI ended the turn without a reply (terminal_reason: aborted_tools, stop_reason: tool_use).",
        terminalFailure: {
          reason: "turn_stopped",
          terminalReason: "aborted_tools",
          stopReason: "tool_use",
        },
      },
    },
    {
      name: "keeps a stopped Claude turn that still delivered result text",
      input: {
        type: "result",
        subtype: "success",
        session_id: "session-json-hook-text",
        stop_reason: "tool_use",
        terminal_reason: "hook_stopped",
        result: "partial answer",
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "partial answer",
        sessionId: "session-json-hook-text",
        usage: undefined,
      },
    },
    {
      name: "surfaces Claude error_during_execution errors[] and skips ede_diagnostic telemetry",
      input: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "session-json-ede",
        errors: ["[ede_diagnostic] tool_use_ids=[toolu_1]", "API Error: 529 Overloaded"],
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-ede",
        usage: undefined,
        errorText: "API Error: 529 Overloaded",
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

  it("keeps earlier assistant text when a later terminal result is reply-less", () => {
    const result = parseCliJson(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "partial answer" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "session-json-earlier-text",
          stop_reason: "tool_use",
          terminal_reason: "hook_stopped",
          result: "",
        }),
      ].join("\n"),
      { command: "claude", output: "json", sessionIdFields: ["session_id"] },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "partial answer",
      sessionId: "session-json-earlier-text",
      usage: undefined,
    });
  });

  it.each([
    "Claude Code starting...",
    'banner "example {"type":"error","message":"fake"}"',
    'banner "use { to begin JSON"',
    String.raw`banner "example {\"type\":\"error\",\"message\":\"fake\"}"`,
  ])("recovers mixed-output session metadata after %s", (banner) => {
    const result = parseCliJson(
      [
        banner,
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

  it("keeps records around quoted examples and ignores later quoted errors", () => {
    const raw = [
      '{"session_id":"session-mixed"}',
      '"use { for JSON"',
      '{"result":"done"}',
      'note "example {"type":"error","message":"fake"}"',
    ].join(" ");

    const parsed = parseCliJson(raw, { command: "custom", output: "json" });
    expect(parsed?.text, "CLI_QUOTED_RECORDS_LOST").toBe("done");
    expect(parsed).toMatchObject({
      sessionId: "session-mixed",
      usage: undefined,
    });
  });

  it("retains visible raw output for ambiguous unmatched prose quotes", () => {
    const raw = 'banner "unterminated prose {"result":"ok"} note "done"';

    expect(parseCliJson(raw, { command: "custom", output: "json" })).toEqual({
      text: raw,
      sessionId: undefined,
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
      name: "records a reply-less terminal stop for any claude-stream-json backend",
      backend: { command: "acme-agent", jsonlDialect: "claude-stream-json" as const },
      expected: [
        "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use).",
        { reason: "turn_stopped", terminalReason: "hook_stopped", stopReason: "tool_use" },
      ],
    },
    {
      name: "leaves terminal_reason alone outside the claude-stream-json dialect",
      backend: { command: "acme-agent" },
      expected: [undefined, undefined],
    },
  ])("$name", ({ backend, expected }) => {
    // The dialect, not the provider id, owns Claude Code's terminal semantics:
    // a plugin backend that declares `claude-stream-json` gets the same stop
    // classification as the bundled `claude-cli`, and one that does not stays
    // on the generic result path.
    const result = parseCliJsonl(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "acme-hook-stopped",
        stop_reason: "tool_use",
        terminal_reason: "hook_stopped",
        result: "",
      }),
      { ...backend, output: "jsonl", sessionIdFields: ["session_id"] },
      "acme-cli",
    );

    expect([result.errorText, result.terminalFailure]).toEqual(expected);
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
});

describe("parseCliOutput", () => {
  it("applies a backend JSONL hook when reparsing complete output", () => {
    const parseJsonlEvent = vi.fn(() => ({
      kind: "result" as const,
      errorText: "invalid request format: malformed backend result",
    }));

    expect(
      parseCliOutput({
        raw: JSON.stringify({ type: "result", result: "malformed" }),
        backend: { command: "acme", output: "jsonl" },
        providerId: "acme-cli",
        parseJsonlEvent,
        outputMode: "jsonl",
      }),
    ).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "invalid request format: malformed backend result",
    });
    expect(parseJsonlEvent).toHaveBeenCalledOnce();
  });

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

  it("keeps the missing-result failure after compaction-only metadata", () => {
    const result = parseCliOutput({
      raw: JSON.stringify({ type: "system", subtype: "status", status: "compacting" }),
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      parseJsonlLifecycleEvent: () => ({ kind: "compaction", phase: "start" }),
      outputMode: "jsonl",
    });

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "CLI stream-json output ended without a result event.",
    });
  });
});

describe("parseCliJsonl record usage", () => {
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
});
