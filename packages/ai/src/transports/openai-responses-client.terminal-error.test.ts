// The managed Responses transport must surface the provider's terminal error
// fact (e.g. content_filter) instead of collapsing it into a generic message;
// the generic string is classified as a transient timeout by failover and
// triggers pointless model rotation.
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sseState = vi.hoisted(() => ({
  outcomes: [] as Array<Error | SdkResponse>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: () => {
        const outcome = sseState.outcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("terminal error tests must not construct a WebSocket");
  },
}));

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

describe("managed Responses transport terminal errors", () => {
  it.each([false, true])(
    "retains usage when truncated tool output has an item-done event: %s",
    async (itemDone) => {
      const partialCall = {
        type: "function_call",
        id: "fc_truncated",
        call_id: "call_truncated",
        name: "probe",
        arguments: '{"token":"unfinished',
        status: "incomplete",
      };
      sseState.outcomes.push({
        data: (async function* () {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...partialCall, arguments: "", status: "in_progress" },
          };
          yield {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: partialCall.id,
            delta: partialCall.arguments,
          };
          if (itemDone) {
            yield { type: "response.output_item.done", output_index: 0, item: partialCall };
          }
          yield {
            type: "response.incomplete",
            response: {
              id: "resp_truncated",
              model: "served-model",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [partialCall],
              usage: {
                input_tokens: 20,
                output_tokens: 9,
                total_tokens: 29,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            },
          };
        })(),
        response: new Response(null, { status: 200 }),
      });
      const options = { apiKey: "test-key", transport: "sse" } satisfies OpenAIResponsesOptions;
      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        { messages: [], tools: [] },
        options,
      );
      const events: string[] = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(events.filter((type) => type === "done" || type === "error")).toEqual(["error"]);
      expect(events).not.toContain("toolcall_end");
      expect(result.usage).toMatchObject({
        input: 16,
        cacheRead: 4,
        output: 9,
        totalTokens: 29,
        reasoningTokens: 3,
      });
      expect(result.responseId).toBe("resp_truncated");
      expect(result.responseModel).toBe("served-model");
    },
  );

  it.each([false, true])(
    "preserves the provider incomplete_reason with an active tool: %s",
    async (activeTool) => {
      sseState.outcomes.push({
        data: (async function* () {
          if (activeTool) {
            yield {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_filtered",
                call_id: "call_filtered",
                name: "probe",
                arguments: "",
                status: "in_progress",
              },
            };
          }
          yield {
            type: "response.incomplete",
            response: {
              id: "resp_filtered",
              status: "incomplete",
              incomplete_details: { reason: "content_filter" },
            },
          };
        })(),
        response: new Response(null, { status: 200 }),
      });
      const options = {
        apiKey: "test-key",
        sessionId: "session-terminal-error",
        transport: "sse",
      } satisfies OpenAIResponsesOptions;
      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        { messages: [], tools: [] },
        options,
      );
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
    },
  );
});
