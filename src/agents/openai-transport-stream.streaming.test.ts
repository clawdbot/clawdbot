import { createServer } from "node:http";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  classifyAssistantFailoverReason,
  formatUserFacingAssistantErrorText,
} from "./embedded-agent-helpers.js";
import {
  type CapturedStreamEvent,
  makeCompletionsModel,
  createResponsesAssistantOutput,
  createAzureResponsesModel,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

// Loaded hosted runners can delay the first real loopback request well beyond
// the shared test timeout even when this file runs in its isolated project.
const COLD_RUNNER_HTTP_TEST_TIMEOUT_MS = 300_000;

describe("openai transport stream", () => {
  it("passes provider request timeouts to OpenAI SDK clients", () => {
    const requestTimeoutMs = 900_000;

    const responsesModel = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "custom-openai",
      baseUrl: "https://api.example.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      requestTimeoutMs,
    } satisfies Model<"openai-responses"> & { requestTimeoutMs: number };
    const azureModel = {
      ...responsesModel,
      api: "azure-openai-responses",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-5.4",
    } satisfies Model<"azure-openai-responses"> & { requestTimeoutMs: number };
    expect(testing.buildOpenAISdkClientOptions(responsesModel).timeout).toBe(requestTimeoutMs);
    expect(testing.buildOpenAISdkClientOptions(azureModel).timeout).toBe(requestTimeoutMs);
  });

  it.each([
    {
      api: "openai-responses" as const,
      provider: "custom-openai",
      createStream: createOpenAIResponsesTransportStreamFn,
    },
    {
      api: "azure-openai-responses" as const,
      provider: "azure-openai-responses-devdiv",
      createStream: createAzureOpenAIResponsesTransportStreamFn,
    },
  ])(
    "honors turn timeout and zero retries over real $api HTTP",
    async (transport) => {
      const capturedTimeouts: Array<string | undefined> = [];
      const server = createServer((request, response) => {
        const timeout = request.headers["x-stainless-timeout"];
        capturedTimeouts.push(Array.isArray(timeout) ? timeout[0] : timeout);
        request.resume();
        request.on("end", () => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { type: "server_error", message: "turn retry regression" },
            }),
          );
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }

        const model = {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          api: transport.api,
          provider: transport.provider,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
          requestTimeoutMs: 900_000,
        } satisfies Model & { requestTimeoutMs: number };

        const stream = await transport.createStream()(
          model,
          {
            messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
            tools: [],
          },
          { apiKey: "test-key", timeoutMs: 1_234, maxRetries: 0 },
        );

        const eventTypes: string[] = [];
        for await (const event of stream) {
          eventTypes.push(event.type);
        }

        expect(eventTypes).toContain("error");
        // The SDK advertises request timeouts in whole seconds on the wire.
        expect(capturedTimeouts).toEqual(["1"]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  );

  it("reports the managed Responses HTTP status before streaming events", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(202, {
          "content-type": "text/event-stream; charset=utf-8",
          "x-provider-test": "managed-response",
        });
        res.end(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { id: "resp_status", status: "completed", output: [] },
          })}\n\n`,
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const onResponse = vi.fn();
      const model = {
        id: "gpt-status",
        name: "GPT Status",
        api: "openai-responses",
        provider: "custom-openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      } satisfies Model<"openai-responses">;

      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        {
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        },
        { apiKey: "test-key", onResponse },
      );
      for await (const event of stream) {
        // Drain the stream so the terminal event and hook complete.
        void event;
      }

      expect(onResponse).toHaveBeenCalledWith(
        {
          status: 202,
          headers: expect.objectContaining({ "x-provider-test": "managed-response" }),
        },
        model,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("classifies OpenAI-compatible unsupported-model detail from failed chat requests", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "req_not_supported_model",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "400",
              message: "Param Incorrect",
              param: "Not supported model some-model-id",
            },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "some-model-id",
        name: "Some Model",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let errorPayload: Record<string, unknown> | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "error") {
          errorPayload = event.error;
        }
      }

      expect(errorPayload).toMatchObject({
        stopReason: "error",
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
      });
      expect(String(errorPayload?.errorBody)).toContain("Not supported model some-model-id");
      expect(classifyAssistantFailoverReason(errorPayload as never)).toBe("model_not_found");
      expect(formatUserFacingAssistantErrorText(errorPayload as never)).toBe(
        "The selected model was not found by the provider. Check the model id or choose a different model.",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("yields to aborts during bursty Responses streams", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const abort = new AbortController();
    const stream = { push: vi.fn() };
    let yieldedToTimer = false;

    async function* mockStream() {
      yield { type: "response.output_item.added", item: { type: "message" } };
      for (let index = 0; index < 512; index += 1) {
        yield { type: "response.output_text.delta", delta: "x" };
      }
    }

    setTimeout(() => {
      yieldedToTimer = true;
      abort.abort();
    }, 0);

    await expect(
      testing.processResponsesStream(mockStream(), output, stream, model, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(stream.push.mock.calls.length).toBeLessThan(512);
  });

  it("omits accumulated partial snapshots from Responses text deltas", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processResponsesStream(
      streamChunks([
        { type: "response.output_item.added", item: { type: "message" } },
        { type: "response.output_text.delta", delta: "a" },
        { type: "response.output_text.delta", delta: "b" },
        { type: "response.completed", response: { id: "resp_text", status: "completed" } },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "ab" }]);
  });

  it.each([
    ["omits arguments", undefined],
    ["sends empty arguments", ""],
  ])("preserves streamed Responses arguments when done %s", async (_label, doneArguments) => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const streamedArguments = '{"path":"docs/nodes/computer-use.md"}';

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", delta: streamedArguments },
        {
          type: "response.function_call_arguments.done",
          ...(doneArguments === undefined ? {} : { arguments: doneArguments }),
          item_id: "fc_read",
          output_index: 0,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_read", status: "completed" },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "docs/nodes/computer-use.md" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("keeps idless Responses tool-call ids stable and response-unique", async () => {
    const runOnce = async () => {
      const model = createAzureResponsesModel();
      const output = createResponsesAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      await testing.processResponsesStream(
        streamChunks([
          {
            type: "response.output_item.added",
            item: { type: "function_call", name: "computer", arguments: "" },
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", name: "computer", arguments: "{}" },
          },
          { type: "response.completed", response: { id: "resp_idless", status: "completed" } },
        ]),
        output,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        model,
      );
      const block = output.content.find((entry) => entry.type === "toolCall") as
        | { id?: string }
        | undefined;
      const end = events.find((event) => event.type === "toolcall_end") as
        | { toolCall?: { id?: string } }
        | undefined;
      if (!block?.id || !end?.toolCall?.id) {
        throw new Error("missing tool-call lifecycle");
      }
      return { blockId: block.id, endId: end.toolCall.id };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.blockId).toMatch(/^call_[0-9a-f]{24}$/);
    expect(first.endId).toBe(first.blockId);
    expect(second.endId).toBe(second.blockId);
    expect(second.blockId).not.toBe(first.blockId);
  });

  it("materializes one stable tool call for a done-only idless Responses item", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const item = {
      type: "function_call",
      name: "computer",
      arguments: '{"action":"screenshot"}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 0,
          item,
        },
        {
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "resp_done_only_idless",
            status: "completed",
            output: [item],
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "computer",
        arguments: { action: "screenshot" },
      },
    ]);
    const toolEvents = events.filter((event) => event.type?.startsWith("toolcall_")) as Array<{
      type: string;
      contentIndex: number;
      toolCall?: { id?: string };
    }>;
    expect(toolEvents.map((event) => [event.type, event.contentIndex])).toEqual([
      ["toolcall_start", 0],
      ["toolcall_end", 0],
    ]);
    expect(toolEvents[1]?.toolCall?.id).toBe((output.content[0] as { id?: string }).id);
  });

  it("uses an SDK function call call_id directly when its optional item id is absent", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const item = {
      type: "function_call",
      call_id: "call_sdk_without_item_id",
      name: "computer",
      arguments: '{"action":"screenshot"}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 0,
          item,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item,
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_sdk_without_item_id",
            status: "completed",
            output: [item],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_sdk_without_item_id", name: "computer" },
    ]);
  });

  it("reconciles an idless added Responses item to its canonical done identity", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const doneItem = {
      type: "function_call",
      id: "fc_canonical",
      call_id: "call_canonical",
      name: "computer",
      arguments: '{"action":"screenshot"}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 0,
          item: { type: "function_call", name: "computer", arguments: "" },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item: doneItem,
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_canonical_tool_identity",
            status: "completed",
            output: [doneItem],
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_canonical|fc_canonical", name: "computer" },
    ]);
    const end = events.find((event) => event.type === "toolcall_end") as
      | { toolCall?: { id?: string } }
      | undefined;
    expect(end?.toolCall?.id).toBe("call_canonical|fc_canonical");
  });

  it("keeps interleaved Responses function calls bound to their output indices", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{
      type?: string;
      contentIndex?: number;
      toolCall?: { id?: string };
    }> = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 1,
          item: {
            type: "function_call",
            id: "fc_click",
            call_id: "call_click",
            name: "computer",
            arguments: "",
            status: "in_progress",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          sequence_number: 2,
          item: {
            type: "function_call",
            id: "fc_type",
            call_id: "call_type",
            name: "computer",
            arguments: "",
            status: "in_progress",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_type",
          sequence_number: 3,
          delta: '{"action":"type","text":"hello"}',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_click",
          sequence_number: 4,
          delta: '{"action":"left_click","coordinate":[10,20]}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 5,
          item: {
            type: "function_call",
            id: "fc_click",
            call_id: "call_click",
            name: "computer",
            arguments: '{"action":"left_click","coordinate":[10,20]}',
            status: "completed",
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          sequence_number: 6,
          item: {
            type: "function_call",
            id: "fc_type",
            call_id: "call_type",
            name: "computer",
            arguments: '{"action":"type","text":"hello"}',
            status: "completed",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_interleaved_calls", status: "completed" },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_click|fc_click",
        name: "computer",
        arguments: { action: "left_click", coordinate: [10, 20] },
      },
      {
        type: "toolCall",
        id: "call_type|fc_type",
        name: "computer",
        arguments: { action: "type", text: "hello" },
      },
    ]);
    expect(
      events
        .filter((event) => event.type?.startsWith("toolcall_"))
        .map((event) => [event.type, event.contentIndex]),
    ).toEqual([
      ["toolcall_start", 0],
      ["toolcall_start", 1],
      ["toolcall_delta", 1],
      ["toolcall_delta", 0],
      ["toolcall_end", 0],
      ["toolcall_end", 1],
    ]);
    expect(
      events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall?.id),
    ).toEqual(["call_click|fc_click", "call_type|fc_type"]);
  });

  it("recovers parallel Responses arguments from done events and preserves opening names", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const firstItem = {
      type: "function_call",
      id: "fc_recovered_first",
      call_id: "call_recovered_first",
      name: "read",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_recovered_second",
      call_id: "call_recovered_second",
      name: "write",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...firstItem, arguments: "" },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...secondItem, arguments: "" },
        },
        { type: "response.function_call_arguments.delta", delta: '{"ambiguous":true}' },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: firstItem.id,
          arguments: '{"path":"README.md"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          item_id: secondItem.id,
          arguments: '{"path":"README.md","text":"ok"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: firstItem.id,
            call_id: firstItem.call_id,
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: secondItem.id,
            call_id: secondItem.call_id,
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_recovered_parallel", status: "completed" },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_recovered_first|fc_recovered_first",
        name: "read",
        arguments: { path: "README.md" },
      },
      {
        type: "toolCall",
        id: "call_recovered_second|fc_recovered_second",
        name: "write",
        arguments: { path: "README.md", text: "ok" },
      },
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("handles Azure Responses text content and text delta events", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            role: "assistant",
            id: "msg_azure_text",
            content: [],
            status: "in_progress",
          },
        },
        { type: "response.text.delta", delta: "Hello" },
        { type: "response.text.delta", delta: " from Azure!" },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "msg_azure_text",
            content: [{ type: "text", text: "Hello from Azure!" }],
            status: "completed",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_azure_text",
            status: "completed",
            usage: {
              input_tokens: 4,
              output_tokens: 3,
              total_tokens: 7,
            },
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(events).toMatchObject([
      { type: "text_start" },
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " from Azure!" },
      { type: "text_end", content: "Hello from Azure!" },
    ]);
    expect(output.content).toMatchObject([{ type: "text", text: "Hello from Azure!" }]);
    expectRecordFields(output.usage, {
      input: 4,
      output: 3,
      totalTokens: 7,
    });
    expect(output.responseId).toBe("resp_azure_text");
  });
});
