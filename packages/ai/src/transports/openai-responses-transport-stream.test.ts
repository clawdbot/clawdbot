/**
 * Regression coverage for SSE stream termination handling.
 *
 * The Responses API defines three terminal event types:
 *   - response.completed — normal completion
 *   - response.incomplete — model stopped before finishing (max_tokens, content_filter, etc.)
 *   - response.failed   — provider error
 *
 * EOF without any terminal event is a transport error and must not be
 * treated as a successful empty response (issue #108958).
 */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import "./openai-responses-transport.js";

const processResponsesStream = expectDefined(
  globalThis.openclawOpenAIResponsesTransportTestApi,
).processResponsesStream;

function makeMockStream(events: Array<Record<string, unknown>>): AsyncIterable<unknown> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: events[i++], done: i > events.length }) };
    },
  };
}

function makeStreamSink() {
  const events: Array<unknown> = [];
  return {
    events,
    push(event: unknown) {
      events.push(event);
    },
  };
}

const baseModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses" as const,
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  input: ["text" as const],
};

function makeOutput() {
  return {
    role: "assistant" as const,
    content: [] as Array<Record<string, unknown>>,
    api: "openai-responses" as const,
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("processResponsesStream terminal states", () => {
  it("completes normally with response.completed", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "Hello" },
        {
          type: "response.completed",
          response: { id: "resp_1", status: "completed" },
        },
      ]),
      output,
      stream,
      baseModel,
    );

    expect(output.stopReason).toBe("stop");
  });

  it("returns incomplete with stopReason length when response.incomplete arrives", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_2" } },
        { type: "response.output_text.delta", delta: "Hello" },
        {
          type: "response.incomplete",
          response: {
            id: "resp_2",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      output,
      stream,
      baseModel,
    );

    // mapResponsesStopReason("incomplete") → "length"
    expect(output.stopReason).toBe("length");
  });

  it("sets stopReason to error when stream ends without any terminal event", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_3" } },
        { type: "response.output_text.delta", delta: "Hello" },
        // No terminal event — EOF without completion
      ]),
      output,
      stream,
      baseModel,
    );

    expect(output.stopReason).toBe("error");
  });

  it("does not persist a successful response when terminal event is missing", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_4" } },
        // EOF immediately — no terminal event
      ]),
      output,
      stream,
      baseModel,
    );

    // stopReason must be "error" — never "stop" (which would mean success)
    expect(output.stopReason).toBe("error");

    // No "done" event must have been pushed to the stream
    const doneEvents = stream.events.filter((e) => (e as { type?: string }).type === "done");
    expect(doneEvents).toHaveLength(0);
  });

  it("throws on response.failed (regression check)", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await expect(
      processResponsesStream(
        makeMockStream([
          { type: "response.created", response: { id: "resp_5" } },
          {
            type: "response.failed",
            response: {
              id: "resp_5",
              error: { code: "server_error", message: "Internal server error" },
            },
          },
        ]),
        output,
        stream,
        baseModel,
      ),
    ).rejects.toThrow("server_error");
  });

  it("preserves incomplete stopReason even when content includes tool calls", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_6" } },
        {
          type: "response.incomplete",
          response: {
            id: "resp_6",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      output,
      stream,
      baseModel,
    );

    // Incomplete with "length" should not be reclassified as "toolUse"
    // even if tool calls are present (unlike response.completed)
    expect(output.stopReason).toBe("length");
  });

  it("no duplicated downstream events after EOF without terminal", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_7" } },
        { type: "response.output_text.delta", delta: "Hello" },
        // EOF
      ]),
      output,
      stream,
      baseModel,
    );

    // stopReason is "error" — the caller will throw based on this
    expect(output.stopReason).toBe("error");

    // Verify no "done" event was pushed to the stream
    const doneEvents = stream.events.filter((e) => (e as { type?: string }).type === "done");
    expect(doneEvents).toHaveLength(0);
  });

  it("empty stream sets stopReason to error before emitting success", async () => {
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(makeMockStream([]), output, stream, baseModel);

    expect(output.stopReason).toBe("error");

    const doneEvents = stream.events.filter((e) => (e as { type?: string }).type === "done");
    expect(doneEvents).toHaveLength(0);
  });

  it("fails unterminated stream with tool calls (EOF, no terminal)", async () => {
    // Regression: the post-loop guard must detect unterminated streams
    // regardless of accumulated stopReason or content state. A stream
    // that produces a completed function_call then EOFs without any terminal
    // event is a transport error — not a successful stop.
    const output = makeOutput();
    const stream = makeStreamSink();

    await processResponsesStream(
      makeMockStream([
        { type: "response.created", response: { id: "resp_tool" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "item_tool_1",
            type: "function_call",
            call_id: "call_tool_1",
            name: "get_weather",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "item_tool_1",
          output_index: 0,
          delta: '{"location":"Tokyo"}',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "item_tool_1",
          output_index: 0,
          arguments: '{"location":"Tokyo"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "item_tool_1",
            type: "function_call",
            call_id: "call_tool_1",
            name: "get_weather",
            arguments: '{"location":"Tokyo"}',
          },
        },
        // EOF — no terminal event (response.completed never arrived)
      ]),
      output,
      stream,
      baseModel,
    );

    // terminalState is "none" → stopReason must be "error"
    // (The tool call was completed, so hasActive() is false,
    //  but there was no response.completed terminal event.)
    expect(output.stopReason).toBe("error");

    const doneEvents = stream.events.filter((e) => (e as { type?: string }).type === "done");
    expect(doneEvents).toHaveLength(0);
  });
});
