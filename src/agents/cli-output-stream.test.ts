import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

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

function claudeTextDelta(text: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "text_delta", text },
  });
}

function claudeSyntheticNoResponse(text = "No response requested.") {
  return {
    type: "assistant",
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

describe("createCliJsonlStreamingParser", () => {
  it("observes exact parent native tools across chunked fresh and warm initialization", () => {
    const snapshots: unknown[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onNativeTools: (tools: unknown) => snapshots.push(tools),
    });
    const initial = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "reused-session",
      tools: ["Read", "Bash", "mcp__openclaw__automations"],
    });
    parser.push(initial.slice(0, -2));
    expect(snapshots).toEqual([]);
    parser.push(
      initial.slice(-2) +
        "\n" +
        joinJsonlFrames(
          { type: "result", result: "first turn complete" },
          { type: "system", subtype: "init", session_id: "reused-session", tools: ["Read"] },
          { type: "result", result: "warm turn complete" },
          { type: "system", subtype: "init", session_id: "replacement-session", tools: [] },
        ),
    );
    parser.finish();

    expect(snapshots).toEqual([["Read", "Bash", "mcp__openclaw__automations"], ["Read"], []]);
  });

  it("ignores subagent and non-initialization native tool lists", () => {
    const snapshots: unknown[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onNativeTools: (tools: unknown) => snapshots.push(tools),
    });
    parser.push(
      joinJsonlFrames(
        { type: "system", subtype: "init", parent_tool_use_id: null, tools: ["Read"] },
        { type: "system", subtype: "init", parent_tool_use_id: "child-call", tools: ["Bash"] },
        { type: "system", subtype: "status", tools: [] },
        { type: "assistant", tools: ["Write"] },
        "",
      ),
    );
    parser.finish();

    expect(snapshots).toEqual([["Read"]]);
  });

  it("forwards malformed and missing parent native tool lists for owner validation", () => {
    const snapshots: unknown[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onNativeTools: (tools: unknown) => snapshots.push(tools),
    });
    for (const tools of [["Read"], "Bash", null, ["Read", 7], undefined]) {
      parser.push(JSON.stringify({ type: "system", subtype: "init", tools }) + "\n");
    }
    parser.finish();

    expect(snapshots).toEqual([["Read"], "Bash", null, ["Read", 7], undefined]);
  });

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

  it("records Claude's exact synthetic empty terminal as a failure", () => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      joinJsonlFrames(
        claudeSyntheticNoResponse(),
        { type: "result", subtype: "success", session_id: "synthetic-empty", result: "" },
        "",
      ),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: "synthetic-empty",
      usage: undefined,
      errorText: "Claude CLI returned a synthetic no-response result.",
      terminalFailure: { reason: "synthetic_no_response" },
    });
  });

  it.each([
    {
      name: "records a Claude hook-stopped terminal result",
      frames: [] as unknown[],
      expected: {
        text: "",
        sessionId: "hook-stopped",
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
      name: "keeps streamed text when a hook stops the turn after a reply",
      frames: [claudeTextDelta("streamed answer")] as unknown[],
      expected: { text: "streamed answer", sessionId: "hook-stopped", usage: undefined },
    },
    {
      name: "does not classify a backgrounded turn as a stop",
      frames: [] as unknown[],
      terminalReason: "background_requested",
      expected: { text: "", sessionId: "hook-stopped", usage: undefined },
    },
  ])("$name", ({ frames, expected, terminalReason }) => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      joinJsonlFrames(
        ...frames,
        {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "hook-stopped",
          stop_reason: "tool_use",
          terminal_reason: terminalReason ?? "hook_stopped",
          result: "",
          num_turns: 4,
        },
        "",
      ),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual(expected);
  });

  it("records a hook stop that follows an interim result", () => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      joinJsonlFrames(
        {
          type: "result",
          subtype: "success",
          session_id: "interim-then-stop",
          terminal_reason: "completed",
          result: "Agent is running. I'll let you know when it finishes.",
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "interim-then-stop",
          stop_reason: "tool_use",
          terminal_reason: "hook_stopped",
          result: "",
        },
        "",
      ),
    );
    parser.finish();

    // The interim text was that result's reply, not this turn's: a stopped
    // turn reports empty text like the JSON and JSONL result paths do.
    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: "interim-then-stop",
      usage: undefined,
      errorText:
        "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use).",
      terminalFailure: {
        reason: "turn_stopped",
        terminalReason: "hook_stopped",
        stopReason: "tool_use",
      },
    });
  });

  it.each([
    {
      name: "ordinary lookalike",
      frames: [
        {
          ...claudeSyntheticNoResponse(),
          message: { ...claudeSyntheticNoResponse().message, model: "claude-sonnet-4-6" },
        },
      ],
      expectedText: "",
    },
    {
      name: "different synthetic text",
      frames: [claudeSyntheticNoResponse("No reply needed.")],
      expectedText: "",
    },
    {
      name: "real text",
      frames: [claudeSyntheticNoResponse(), claudeTextDelta("real answer")],
      expectedText: "real answer",
    },
    {
      name: "tool activity",
      frames: [
        {
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
          },
        },
        claudeSyntheticNoResponse(),
      ],
      expectedText: "",
    },
  ])("does not classify $name as a synthetic empty terminal", ({ frames, expectedText }) => {
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      joinJsonlFrames(
        ...frames,
        { type: "result", subtype: "success", session_id: "not-synthetic", result: "" },
        "",
      ),
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: expectedText,
      sessionId: "not-synthetic",
      usage: undefined,
    });
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
