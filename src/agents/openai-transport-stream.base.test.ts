import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  resolveAzureOpenAIApiVersion,
  type OpenAIResponsesOutput,
  type CapturedStreamEvent,
  makeCompletionsModel,
  makeResponsesModel,
  createDeepSeekCompletionsModel,
  createAssistantOutput,
  createResponsesAssistantOutput,
  createAzureResponsesModel,
  neverYieldsStream,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createOpenClawTransportStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

describe("openai transport stream", () => {
  it("keeps bounded redacted diagnostics UTF-16 well-formed", () => {
    const payload = testing.stringifyRedactedPayload(`${"x".repeat(7_998)}🚀tail`);
    const event = testing.stringifyRedactedEvent(`${"x".repeat(1_998)}🚀tail`);

    expect(payload).toContain(`${"x".repeat(7_998)}…<truncated>`);
    expect(event).toContain(`${"x".repeat(1_998)}…<truncated>`);
    expect(payload).not.toContain("\uD83D");
    expect(event).not.toContain("\uD83D");
  });

  it("fails Azure Responses streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
    try {
      const model = createAzureResponsesModel();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = testing.processResponsesStream(
        neverYieldsStream(),
        createResponsesAssistantOutput(model),
        { push: vi.fn() },
        model,
        { firstEventTimeoutMs: 5, abortFirstEventStream, onFirstEventTimeout },
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        /did not deliver a first SSE event within 5ms after streaming headers/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(abortFirstEventStream).toHaveBeenCalledTimes(1);
      expect(abortFirstEventStream.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(abortFirstEventStream.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails OpenAI completions streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
    try {
      const model = createDeepSeekCompletionsModel();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = testing.processOpenAICompletionsStream(
        neverYieldsStream() as AsyncIterable<ChatCompletionChunk>,
        createAssistantOutput(model),
        model,
        { push: vi.fn() },
        { firstEventTimeoutMs: 5, abortFirstEventStream, onFirstEventTimeout },
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        /did not deliver a first SSE event within 5ms after streaming headers/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(abortFirstEventStream).toHaveBeenCalledTimes(1);
      expect(abortFirstEventStream.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(abortFirstEventStream.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes detail-less Responses failures without leaking request ids", async () => {
    // Observation should preserve hashes/metadata shape while dropping raw request ids.
    const model = createAzureResponsesModel();
    const event = {
      type: "response.failed",
      response: {
        id: "resp_failed_123",
        status: "failed",
        model: "gpt-5.4-pro",
        metadata: {
          litellm_request_id: "litellm_req_plaintext_123",
          api_key: "sk-observation-secret",
        },
        provider_request_id: "provider_req_plaintext_456",
        status_details: {
          provider_request_id: "provider_req_nested_789",
        },
        provider_error: {
          request_id: "provider_error_req_nested_012",
          headers: {
            "x-request-id": ["header_req_plaintext_345", "header_req_plaintext_678"],
          },
        },
      },
    };

    const observation = testing.buildResponsesFailedNoDetailsObservation(event, model);
    const summary = testing.summarizeResponsesFailedNoDetailsObservation(observation);

    expect(observation.providerRuntimeFailureKind).toBe("no_error_details");
    expect(observation.responseId).toBe("resp_failed_123");
    expect(observation.responseStatus).toBe("failed");
    expect(observation.responseModel).toBe("gpt-5.4-pro");
    expect(observation.metadataKeys).toEqual(["api_key", "litellm_request_id"]);
    expect(observation.requestIdHashes).toHaveLength(6);
    expect(observation.requestIdHashes.join(",")).toContain("sha256:");
    expect(summary).toContain("responseId=resp_failed_123");
    expect(summary).toContain("requestIds=");
    expect(JSON.stringify(observation)).not.toContain("litellm_req_plaintext_123");
    expect(JSON.stringify(observation)).not.toContain("provider_req_plaintext_456");
    expect(JSON.stringify(observation)).not.toContain("provider_req_nested_789");
    expect(JSON.stringify(observation)).not.toContain("provider_error_req_nested_012");
    expect(JSON.stringify(observation)).not.toContain("header_req_plaintext_345");
    expect(JSON.stringify(observation)).not.toContain("header_req_plaintext_678");
    expect(JSON.stringify(observation)).not.toContain("sk-observation-secret");
  });

  it("normalizes Responses failed events before transport errors are thrown", () => {
    const model = createAzureResponsesModel();

    expect(
      testing.normalizeResponsesFailedEvent(
        {
          type: "response.failed",
          response: {
            id: "resp_failed_rate_limit",
            error: {
              code: "rate_limit_exceeded",
              message: "Too many requests",
            },
          },
        },
        model,
      ),
    ).toMatchObject({
      message: "rate_limit_exceeded: Too many requests",
      responseId: "resp_failed_rate_limit",
    });

    expect(
      testing.normalizeResponsesFailedEvent(
        {
          type: "response.failed",
          response: {
            id: "resp_failed_incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
        model,
      ),
    ).toMatchObject({
      message: "incomplete: max_output_tokens",
      responseId: "resp_failed_incomplete",
    });
  });

  it("preserves the failed response id before throwing detail-less Responses failures", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await expect(
      testing.processResponsesStream(
        streamChunks([
          {
            type: "response.failed",
            response: {
              id: "resp_failed_runtime",
              status: "failed",
              model: "gpt-5.4-pro",
            },
          },
        ]),
        output,
        { push: vi.fn() },
        model,
      ),
    ).rejects.toThrow("Unknown error (no error details in response)");

    expect(output.responseId).toBe("resp_failed_runtime");
  });

  it("treats empty Responses error objects as detail-less failures", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await expect(
      testing.processResponsesStream(
        streamChunks([
          {
            type: "response.failed",
            response: {
              id: "resp_failed_empty_error",
              status: "failed",
              model: "gpt-5.4-pro",
              error: { code: null, message: null },
              provider_request_id: "provider_req_empty_error",
            },
          },
        ]),
        output,
        { push: vi.fn() },
        model,
      ),
    ).rejects.toThrow("Unknown error (no error details in response)");

    expect(output.responseId).toBe("resp_failed_empty_error");
  });

  it("tags Responses encrypted reasoning with replay provenance while streaming", async () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    const output: OpenAIResponsesOutput = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
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

    await testing.processResponsesStream(
      streamChunks([
        { type: "response.output_item.added", item: { type: "reasoning" } },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_123",
            encrypted_content: "ciphertext",
            summary: [{ type: "summary_text", text: "Need a tool." }],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    );

    const expectedReplayMetadata = testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
      authProfileId: "openai:oauth",
      sessionId: "session-123",
    });
    const thinkingBlock = output.content[0] as {
      thinkingSignature?: string;
      openclawReasoningReplay?: unknown;
    };
    const replayItem = JSON.parse(thinkingBlock.thinkingSignature ?? "{}") as Record<
      string,
      unknown
    >;
    expect(replayItem).toMatchObject({
      type: "reasoning",
      id: "rs_123",
      encrypted_content: "ciphertext",
    });
    expect(replayItem).not.toHaveProperty("__openclaw_replay");
    expect(thinkingBlock.openclawReasoningReplay).toEqual(expectedReplayMetadata);
  });

  it("clamps Responses cached prompt usage at zero", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-cache-overflow",
            status: "completed",
            usage: {
              input_tokens: 2,
              output_tokens: 5,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 3 },
            },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expectRecordFields(output.usage, {
      input: 0,
      output: 5,
      cacheRead: 4,
      reasoningTokens: 3,
      totalTokens: 9,
    });
  });

  it("prices Responses cache writes separately from ordinary input", async () => {
    const model = makeResponsesModel({
      ...createAzureResponsesModel(),
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    });
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-cache-write",
            status: "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expectRecordFields(output.usage, {
      input: 50,
      output: 10,
      cacheRead: 20,
      cacheWrite: 30,
      reasoningTokens: 0,
      totalTokens: 110,
    });
    expect(output.usage.cost.input).toBeCloseTo(0.00025);
    expect(output.usage.cost.output).toBeCloseTo(0.0003);
    expect(output.usage.cost.cacheRead).toBeCloseTo(0.00001);
    expect(output.usage.cost.cacheWrite).toBeCloseTo(0.0001875);
    expect(output.usage.cost.total).toBeCloseTo(0.0007475);
  });

  it("records Responses usage and cost when the turn ends incomplete", async () => {
    const model = makeResponsesModel({
      ...createAzureResponsesModel(),
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    });
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.incomplete",
          response: {
            id: "resp-incomplete",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expectRecordFields(output.usage, {
      input: 50,
      output: 10,
      cacheRead: 20,
      cacheWrite: 30,
      reasoningTokens: 0,
      totalTokens: 110,
    });
    // Sub-cent totals round to 0 at toBeCloseTo's default precision, so assert non-zero too.
    expect(output.usage.cost.total).toBeGreaterThan(0);
    expect(output.usage.cost.total).toBeCloseTo(0.0007475, 7);
    expect(output.stopReason).toBe("length");
  });

  it("reports content-filtered incomplete Responses turns as errors", async () => {
    const model = makeResponsesModel(createAzureResponsesModel());
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.incomplete",
          response: {
            id: "resp-filtered",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe("Provider incomplete_reason: content_filter");
    expectRecordFields(output.usage, { input: 12, output: 0 });
  });

  it("backfills partial message output but not tool calls from an incomplete Responses turn", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.incomplete",
          response: {
            id: "resp-incomplete-output",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                id: "msg_truncated",
                role: "assistant",
                content: [{ type: "text", text: "TRUNCATED_HALF_SENTENCE" }],
              },
              {
                type: "function_call",
                id: "fc_truncated",
                call_id: "call_truncated",
                name: "write",
                arguments: '{"path":"unfinished',
              },
            ],
            usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.content).toMatchObject([{ type: "text", text: "TRUNCATED_HALF_SENTENCE" }]);
    expect(output.stopReason).toBe("length");
    expectRecordFields(output.usage, { input: 8, output: 4 });
  });

  it("backfills Azure Responses completed message output when item events are absent", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-azure-completed-message",
            status: "completed",
            output: [
              { type: "reasoning", id: "rs_123", summary: [] },
              {
                type: "message",
                id: "msg_123",
                role: "assistant",
                content: [{ type: "text", text: "AZURE_RESPONSES_CANARY_OK" }],
              },
            ],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([
      {
        type: "text",
        text: "AZURE_RESPONSES_CANARY_OK",
        textSignature: '{"v":1,"id":"msg_123"}',
      },
    ]);
  });

  it("collapses cumulative message snapshot items into one text block (#91959)", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const pushSpy = vi.fn();
    const textBlockSignatures: Array<[string, number, string | undefined]> = [];
    const snapshot1 = "Scaled dot-product attention";
    const snapshot2 = "Scaled dot-product attention divides by sqrt(d_k)";
    const snapshot3 = "Scaled dot-product attention divides by sqrt(d_k) before softmax.";
    const messageItem = (id: string, text: string) => ({
      type: "message",
      id,
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    });

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        { type: "response.output_text.delta", delta: snapshot1 },
        { type: "response.output_item.done", item: messageItem("msg_1", snapshot1) },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        { type: "response.output_item.done", item: messageItem("msg_2", snapshot2) },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_3", phase: "final_answer" },
        },
        { type: "response.output_item.done", item: messageItem("msg_3", snapshot3) },
        {
          type: "response.completed",
          response: { id: "resp-snapshots", status: "completed" },
        },
      ]),
      output,
      {
        push: (rawEvent) => {
          pushSpy(rawEvent);
          const event = rawEvent as CapturedStreamEvent;
          if (
            (event.type === "text_start" || event.type === "text_end") &&
            typeof event.contentIndex === "number"
          ) {
            const block = output.content[event.contentIndex] as
              | { textSignature?: string }
              | undefined;
            textBlockSignatures.push([event.type, event.contentIndex, block?.textSignature]);
          }
        },
      },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "text",
        text: snapshot3,
        textSignature: '{"v":1,"id":"msg_3","phase":"final_answer"}',
      },
    ]);
    // Balanced lifecycle: one text_start, all events on index 0, and each
    // collapsed snapshot re-ends the same block.
    const textEvents = pushSpy.mock.calls
      .map(([event]) => event as { type: string; contentIndex?: number })
      .filter((event) => event.type.startsWith("text_"));
    expect(textEvents.map((event) => [event.type, event.contentIndex])).toEqual([
      ["text_start", 0],
      ["text_delta", 0],
      ["text_end", 0],
      ["text_end", 0],
      ["text_end", 0],
    ]);
    expect(textBlockSignatures).toEqual([
      ["text_start", 0, '{"v":1,"id":"msg_1","phase":"final_answer"}'],
      ["text_end", 0, '{"v":1,"id":"msg_1","phase":"final_answer"}'],
      ["text_end", 0, '{"v":1,"id":"msg_2","phase":"final_answer"}'],
      ["text_end", 0, '{"v":1,"id":"msg_3","phase":"final_answer"}'],
    ]);
  });

  it("stamps deferred message blocks before their first public event", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const textEvents: Array<[string, number, string | undefined]> = [];
    const doneItem = (id: string, text: string) => ({
      type: "response.output_item.done",
      item: {
        type: "message",
        id,
        phase: "final_answer",
        content: [{ type: "output_text", text }],
      },
    });

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        doneItem("msg_1", "Hello."),
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        doneItem("msg_2", "Hello."),
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_3", phase: "final_answer" },
        },
        { type: "response.output_text.delta", delta: "Good" },
        { type: "response.output_text.delta", delta: "bye" },
        doneItem("msg_3", "Goodbye"),
        {
          type: "response.completed",
          response: { id: "resp-deferred-signatures", status: "completed" },
        },
      ]),
      output,
      {
        push: (rawEvent) => {
          const event = rawEvent as CapturedStreamEvent;
          if (event.type?.startsWith("text_") && typeof event.contentIndex === "number") {
            const block = output.content[event.contentIndex] as
              | { textSignature?: string }
              | undefined;
            textEvents.push([event.type, event.contentIndex, block?.textSignature]);
          }
        },
      },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "text",
        text: "Hello.",
        textSignature: '{"v":1,"id":"msg_1","phase":"final_answer"}',
      },
      {
        type: "text",
        text: "Hello.",
        textSignature: '{"v":1,"id":"msg_2","phase":"final_answer"}',
      },
      {
        type: "text",
        text: "Goodbye",
        textSignature: '{"v":1,"id":"msg_3","phase":"final_answer"}',
      },
    ]);
    expect(textEvents).toEqual([
      ["text_start", 0, '{"v":1,"id":"msg_1","phase":"final_answer"}'],
      ["text_end", 0, '{"v":1,"id":"msg_1","phase":"final_answer"}'],
      ["text_start", 1, '{"v":1,"id":"msg_2","phase":"final_answer"}'],
      ["text_end", 1, '{"v":1,"id":"msg_2","phase":"final_answer"}'],
      ["text_start", 2, '{"v":1,"id":"msg_3","phase":"final_answer"}'],
      ["text_delta", 2, '{"v":1,"id":"msg_3","phase":"final_answer"}'],
      ["text_delta", 2, '{"v":1,"id":"msg_3","phase":"final_answer"}'],
      ["text_end", 2, '{"v":1,"id":"msg_3","phase":"final_answer"}'],
    ]);
  });

  it("keeps prefix-nested message items separated by a tool call as separate blocks", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const messageEvents = (id: string, text: string) => [
      { type: "response.output_item.added", item: { type: "message", id } },
      {
        type: "response.output_item.done",
        item: { type: "message", id, content: [{ type: "output_text", text }] },
      },
    ];

    await testing.processResponsesStream(
      streamChunks([
        ...messageEvents("msg_1", "Done."),
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "write",
            arguments: "{}",
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "write",
            arguments: "{}",
          },
        },
        ...messageEvents("msg_2", "Done."),
        {
          type: "response.completed",
          response: { id: "resp-tool-boundary", status: "completed" },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // The post-tool message is a real reply, not a snapshot of the pre-tool one.
    expect(output.content.map((block) => block.type)).toEqual(["text", "toolCall", "text"]);
    expect(output.content[2]).toMatchObject({ type: "text", text: "Done." });
  });

  it("collapses cumulative message snapshots in completed-response backfill (#91959)", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-backfill-snapshots",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "The answer" }],
              },
              {
                type: "message",
                id: "msg_2",
                role: "assistant",
                content: [{ type: "output_text", text: "The answer is 42." }],
              },
              {
                type: "message",
                id: "msg_3",
                role: "assistant",
                content: [{ type: "output_text", text: "The answer" }],
              },
            ],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // msg_2 strictly extends msg_1 and collapses into it; msg_3 shrinks back
    // and is an independently identified message, so it stays a real block.
    expect(output.content).toEqual([
      {
        type: "text",
        text: "The answer is 42.",
        textSignature: '{"v":1,"id":"msg_2"}',
      },
      {
        type: "text",
        text: "The answer",
        textSignature: '{"v":1,"id":"msg_3"}',
      },
    ]);
  });

  it("keeps backfill message items separated by a reasoning item as distinct blocks", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-backfill-reasoning-boundary",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "Step one." }],
              },
              { type: "reasoning", id: "rs_1", summary: [] },
              {
                type: "message",
                id: "msg_2",
                role: "assistant",
                content: [{ type: "output_text", text: "Step one. Step two." }],
              },
            ],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // A reasoning item is a real boundary even in backfill: msg_2 must not
    // collapse into msg_1 despite being a strict extension (mirrors streaming).
    expect(output.content).toEqual([
      { type: "text", text: "Step one.", textSignature: '{"v":1,"id":"msg_1"}' },
      { type: "text", text: "Step one. Step two.", textSignature: '{"v":1,"id":"msg_2"}' },
    ]);
  });

  it("backfills Azure Responses completed function calls when item events are absent", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-azure-completed-tool",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_123",
                call_id: "call_123",
                name: "session_status",
                arguments: '{"sessionKey":"current"}',
              },
            ],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_123|fc_123",
        name: "session_status",
        arguments: { sessionKey: "current" },
        partialJson: '{"sessionKey":"current"}',
      },
    ]);
  });

  it("summarizes model payload tools with full names when requested", () => {
    const previous = process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
    process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = "tools";
    try {
      expect(
        testing.summarizeResponsesTools([
          { type: "function", name: "exec" },
          { type: "function", function: { name: "wait" } },
        ]),
      ).toBe("count=2 names=exec,wait");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
      } else {
        process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = previous;
      }
    }
  });

  it("skips unreadable model payload tool names in debug summaries", () => {
    const previous = process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
    process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = "tools";
    try {
      expect(
        testing.summarizeResponsesTools([
          {
            type: "function",
            get function(): { name: string } {
              throw new Error("responses debug tool function getter exploded");
            },
          },
          {
            type: "function",
            function: {
              get name(): string {
                throw new Error("responses debug nested name getter exploded");
              },
            },
          },
          { type: "function", function: { name: "wait" } },
        ]),
      ).toBe("count=3 names=wait");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
      } else {
        process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = previous;
      }
    }
  });

  it("redacts full model payload debug summaries", () => {
    const previous = process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
    process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = "full-redacted";
    try {
      const apiKey = "test-api-key";
      const summary = testing.summarizeResponsesPayload({
        model: "gpt-5.5",
        stream: true,
        input: [],
        tools: [{ type: "function", name: "exec" }],
        apiKey,
      });
      expect(summary).toContain("payload=");
      expect(summary).toContain('"apiKey":"***"');
      expect(summary).not.toContain(apiKey);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
      } else {
        process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = previous;
      }
    }
  });

  it("enforces the code mode responses tool surface before requests leave OpenClaw", () => {
    const payload = {
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "computer" },
        { type: "web_search_preview" },
        { type: "function", function: { name: "wait" } },
      ],
    };

    testing.enforceCodeModeResponsesToolSurface(payload);
    testing.assertCodeModeResponsesToolSurface(payload);
    expect(payload.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "computer" },
      { type: "function", function: { name: "wait" } },
    ]);
  });

  it("skips unreadable code mode response payload tool names", () => {
    const payload = {
      tools: [
        { type: "function", name: "exec" },
        {
          type: "function",
          get function(): { name: string } {
            throw new Error("responses code mode function getter exploded");
          },
        },
        {
          type: "function",
          function: {
            get name(): string {
              throw new Error("responses code mode nested name getter exploded");
            },
          },
        },
        { type: "function", function: { name: "wait" } },
      ],
    };

    testing.enforceCodeModeResponsesToolSurface(payload);
    testing.assertCodeModeResponsesToolSurface(payload);
    expect(payload.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", function: { name: "wait" } },
    ]);
  });

  it("rejects duplicate direct-only tools in a code mode payload", () => {
    const payload = {
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "wait" },
        { type: "function", name: "computer" },
        { type: "function", name: "computer" },
      ],
    };

    expect(() => testing.assertCodeModeResponsesToolSurface(payload)).toThrow(
      /tool surface violation/,
    );
  });

  it("fails closed when the code mode final payload tool surface is not exec/wait", () => {
    expect(() =>
      testing.assertCodeModeResponsesToolSurface({
        tools: [{ type: "function", name: "exec" }, { type: "web_search_preview" }],
      }),
    ).toThrow(/Code mode payload tool surface violation/);
  });

  it("adds OpenClaw attribution to native OpenAI transport headers and protects it from provider overrides", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
          "X-Provider": "model",
        },
      }),
      { systemPrompt: "", messages: [] } as never,
      {
        originator: "openclaw",
        "User-Agent": "openclaw",
        "X-Caller": "request",
      },
    );

    expectRecordFields(headers, {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
      "X-Provider": "model",
      "X-Caller": "request",
    });
  });

  it("adds OpenClaw attribution to native OpenAI Codex transport headers", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.4-codex",
        name: "GPT-5.4 Codex",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
        },
      }),
      { systemPrompt: "", messages: [] } as never,
    );

    expectRecordFields(headers, {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    expect(headers.Accept).toBeUndefined();
    expect(headers.accept).toBeUndefined();
  });

  it("adds session_id header for the native ChatGPT/Codex Responses transport when a session id is present", () => {
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {},
      }),
      { systemPrompt: "", messages: [] } as never,
      undefined,
      undefined,
      "session-abc-123",
    );

    expect(headers.session_id).toBe("session-abc-123");
  });

  it("omits the session_id header for the native ChatGPT/Codex Responses transport when no session id is available", () => {
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {},
      }),
      { systemPrompt: "", messages: [] } as never,
    );

    expect(headers.session_id).toBeUndefined();
  });

  it("does not add a session_id header for non-native OpenAI Responses transports even when a session id is present", () => {
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        headers: {},
      }),
      { systemPrompt: "", messages: [] } as never,
      undefined,
      undefined,
      "session-abc-123",
    );

    expect(headers.session_id).toBeUndefined();
  });

  it("does not overwrite an existing session_id header on the native ChatGPT/Codex Responses transport", () => {
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {},
      }),
      { systemPrompt: "", messages: [] } as never,
      { session_id: "caller-supplied-session" },
      undefined,
      "session-abc-123",
    );

    expect(headers.session_id).toBe("caller-supplied-session");
  });

  it("does not add a generated session_id header when the caller supplies a differently-cased one", () => {
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {},
      }),
      { systemPrompt: "", messages: [] } as never,
      { Session_ID: "caller-supplied-session" },
      undefined,
      "session-abc-123",
    );

    expect(headers.Session_ID).toBe("caller-supplied-session");
    expect(headers.session_id).toBeUndefined();
  });

  it("adds SSE Accept only to native ChatGPT/Codex Responses stream requests", () => {
    const codexModel = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 400000,
      maxTokens: 128000,
    });
    const transportAliasModel = {
      ...codexModel,
      api: "openclaw-openai-responses-transport" as Api,
    } satisfies Model;
    const nonNativeChatGPTModel = makeResponsesModel({
      ...codexModel,
      baseUrl: "https://api.openai.com/v1",
    });
    const openAIModel = makeResponsesModel({
      ...codexModel,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(testing.buildOpenAISdkRequestOptions(codexModel, undefined, { stream: true })).toEqual({
      headers: { Accept: "text/event-stream" },
    });
    expect(
      testing.buildOpenAISdkRequestOptions(transportAliasModel, undefined, { stream: true }),
    ).toEqual({ headers: { Accept: "text/event-stream" } });
    expect(testing.buildOpenAISdkRequestOptions(codexModel)).toBeUndefined();
    expect(
      testing.buildOpenAISdkRequestOptions(nonNativeChatGPTModel, undefined, { stream: true }),
    ).toBeUndefined();
    expect(
      testing.buildOpenAISdkRequestOptions(openAIModel, undefined, { stream: true }),
    ).toBeUndefined();
  });

  it("moves Azure OpenAI completions api-version headers into default query params", () => {
    const config = testing.buildOpenAICompletionsClientConfig(
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        api: "openai-completions",
        provider: "azure-custom",
        baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o-mini?existing=1",
        headers: {
          "api-key": "azure-key",
          "api-version": "2024-10-21",
          "X-Tenant": "acme",
        },
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      } as unknown as Model<"openai-completions">,
      { systemPrompt: "", messages: [] } as never,
    );

    expect(config).toEqual({
      baseURL: "https://example.openai.azure.com/openai/deployments/gpt-4o-mini",
      defaultHeaders: {
        "api-key": "azure-key",
        "X-Tenant": "acme",
      },
      defaultQuery: {
        existing: "1",
        "api-version": "2024-10-21",
      },
    });
  });

  it("preserves configured base URL query params without moving non-Azure headers", () => {
    const config = testing.buildOpenAICompletionsClientConfig(
      makeCompletionsModel({
        id: "proxy-model",
        name: "Proxy Model",
        provider: "custom-proxy",
        baseUrl: "https://proxy.example.com/v1?tenant=acme",
        headers: {
          "api-version": "proxy-header",
          "X-Tenant": "acme",
        },
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
      }),
      { systemPrompt: "", messages: [] } as never,
    );

    expect(config).toEqual({
      baseURL: "https://proxy.example.com/v1",
      defaultHeaders: {
        "api-version": "proxy-header",
        "X-Tenant": "acme",
      },
      defaultQuery: {
        tenant: "acme",
      },
    });
  });

  it("builds boundary-aware stream shapers for supported default agent transports", () => {
    expect(
      createBoundaryAwareStreamFnForModel(
        makeResponsesModel({
          id: "gpt-5.4",
          name: "GPT-5.4",
        }),
      ),
    ).toBeTypeOf("function");
    expect(
      createOpenClawTransportStreamFnForModel(
        makeResponsesModel({
          id: "gpt-5.4",
          name: "GPT-5.4",
        }),
      ),
    ).toBeTypeOf("function");
    expect(
      createBoundaryAwareStreamFnForModel(
        makeResponsesModel({
          id: "codex-mini-latest",
          name: "Codex Mini Latest",
          api: "openai-chatgpt-responses",
        }),
      ),
    ).toBeTypeOf("function");
    expect(
      createBoundaryAwareStreamFnForModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">),
    ).toBeTypeOf("function");
  });

  it("prepares a custom simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expectRecordFields(prepared, {
      api: "openclaw-openai-responses-transport",
      provider: "openai",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("prepares a Codex Responses simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      makeResponsesModel({
        id: "codex-mini-latest",
        name: "Codex Mini Latest",
        api: "openai-chatgpt-responses",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expectRecordFields(prepared, {
      api: "openclaw-openai-responses-transport",
      provider: "openai",
      id: "codex-mini-latest",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("prepares an Anthropic simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expectRecordFields(prepared, {
      api: "openclaw-anthropic-messages-transport",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("reports the Google simple-completion api alias without loading provider runtime", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        api: "google-generative-ai",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"google-generative-ai">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe(
      "openclaw-google-generative-ai-transport",
    );
  });

  it("keeps github-copilot OpenAI-family models on the shared transport seam", () => {
    const model = attachModelProviderRequestTransport(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/v1",
        input: ["text", "image"],
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expectRecordFields(prepareTransportAwareSimpleModel(model), {
      api: "openclaw-openai-responses-transport",
      provider: "github-copilot",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("keeps github-copilot Claude models on the shared Anthropic transport seam", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/anthropic",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expectRecordFields(prepareTransportAwareSimpleModel(model), {
      api: "openclaw-anthropic-messages-transport",
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("uses a valid Azure API version default when the environment is unset", () => {
    expect(resolveAzureOpenAIApiVersion({})).toBe("preview");
    expect(resolveAzureOpenAIApiVersion({ AZURE_OPENAI_API_VERSION: "2025-01-01-preview" })).toBe(
      "2025-01-01-preview",
    );
  });

  it("uses an OpenAI-compatible client for Foundry Azure Responses base URLs", () => {
    const model = {
      ...createAzureResponsesModel(),
      baseUrl: "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
    };
    const client = testing.createAzureOpenAIClient(
      model,
      { systemPrompt: "system", messages: [], tools: [] } as never,
      "test-key",
    );

    expect(client.constructor.name).toBe("OpenAI");
  });

  it("keeps traditional Azure Responses hosts on the AzureOpenAI client", () => {
    const client = testing.createAzureOpenAIClient(
      createAzureResponsesModel(),
      { systemPrompt: "system", messages: [], tools: [] } as never,
      "test-key",
    );

    expect(client.constructor.name).toBe("AzureOpenAI");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
