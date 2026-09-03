import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { extractCliErrorMessage, formatCliOutputError, parseCliOutput } from "./cli-output.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

function parseCliJsonl(raw: string, backend: ParseCliOutputParams["backend"], providerId: string) {
  return parseCliOutput({ raw, backend, providerId, outputMode: "jsonl" });
}

function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("formatCliOutputError", () => {
  it("keeps truncated session identity UTF-16 safe", () => {
    const sessionId = `${"s".repeat(199)}😀tail`;
    expect(hasDanglingSurrogate(sessionId.slice(0, 200))).toBe(true);

    const error = formatCliOutputError({
      text: "",
      sessionId,
      terminalFailure: { reason: "max_turns" },
    });

    expect(hasDanglingSurrogate(error)).toBe(false);
    expect(error).toContain(`Claude session: ${"s".repeat(199)}.`);
  });

  it("names the Claude terminal reason and the hook that stopped the turn", () => {
    const error = formatCliOutputError(
      {
        text: "",
        sessionId: "claude-session-1",
        terminalFailure: {
          reason: "turn_stopped",
          terminalReason: "hook_stopped",
          stopReason: "tool_use",
        },
      },
      { runId: "run-1", sessionId: "session-1" },
    );

    expect(error).toBe(
      "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use). " +
        "OpenClaw run: run-1. OpenClaw session: session-1. Claude session: claude-session-1. " +
        "Tool actions may already have run; verify their effects before retrying. " +
        "A Claude Code hook stopped this turn; user-scope hooks (including plugin hooks) " +
        "apply to headless runs — move or disable that hook.",
    );
  });

  it("omits the hook guidance for terminal reasons no hook caused", () => {
    const error = formatCliOutputError({
      text: "",
      terminalFailure: { reason: "turn_stopped", terminalReason: "aborted_tools" },
    });

    expect(error).toBe(
      "Claude CLI ended the turn without a reply (terminal_reason: aborted_tools). " +
        "Tool actions may already have run; verify their effects before retrying.",
    );
  });
});

describe("parseCliJsonl errors", () => {
  it("keeps an explicit Claude execution error that also reports a terminal reason", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
        }),
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "claude-execution-error",
          stop_reason: "error",
          terminal_reason: "error_during_execution",
          result: "",
          errors: ["API Error: 529 Overloaded"],
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "claude-execution-error",
      usage: undefined,
      errorText: "API Error: 529 Overloaded",
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

describe("createCliJsonlStreamingParser errors", () => {
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

  it.each(["", "preserved answer"])(
    "keeps plugin-owned terminal errors and text %j ahead of later result summaries",
    (text) => {
      const usageEvents: Array<{ usage: unknown; isTerminal: boolean }> = [];
      const parser = createCliJsonlStreamingParser({
        backend: { command: "acme", output: "jsonl" },
        providerId: "acme-cli",
        parseJsonlEvent: (line) =>
          line === "failed"
            ? { kind: "result", text, errorText: "provider failed" }
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
        text,
        sessionId: "late-successor",
        usage: { input: 2, output: 1, total: 3 },
        errorText: "provider failed",
      });
      expect(usageEvents).toEqual([{ usage: { input: 2, output: 1, total: 3 }, isTerminal: true }]);
    },
  );

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

  it.each([
    ["without a result", undefined, "delegated answer"],
    ["with an empty result", "  ", "delegated answer"],
    ["with an authoritative result", "final answer", "final answer"],
  ] as const)("retains mixed plugin text precedence %s", (_label, resultText, expectedText) => {
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
        if (line === "result") {
          return { kind: "result", text: resultText };
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
        ...(resultText === undefined ? [] : ["result"]),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: expectedText,
      sessionId: "custom-session",
      usage: undefined,
    });
  });
});
