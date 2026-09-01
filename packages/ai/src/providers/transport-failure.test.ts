import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

const context: Context = {
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};
const model: Model<"openai-completions"> = {
  id: "gpt-5.6-luna",
  name: "Test model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://provider.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};
const anthropicModel: Model<"anthropic-messages"> = {
  ...model,
  id: "sonnet-4.6",
  api: "anthropic-messages",
  provider: "anthropic",
};

const options = { apiKey: "fixture-token", reasoningEffort: "medium" as const };
const implementations = [
  {
    name: "Completions SDK",
    model,
    createStream: (signal?: AbortSignal) =>
      streamOpenAICompletions(model, context, { ...options, signal }),
  },
  {
    name: "Completions transport",
    model,
    createStream: (signal?: AbortSignal) =>
      createOpenAICompletionsTransportStreamFn()(model, context, { ...options, signal }),
  },
  {
    name: "Anthropic SDK",
    model: anthropicModel,
    createStream: (signal?: AbortSignal) =>
      streamAnthropic(anthropicModel, context, { ...options, signal }),
  },
  {
    name: "Anthropic transport",
    model: anthropicModel,
    createStream: (signal?: AbortSignal) =>
      createAnthropicMessagesTransportStreamFn()(anthropicModel, context, { ...options, signal }),
  },
];

describe.each(implementations)(
  "$name transport failures",
  ({ model: providerModel, createStream }) => {
    it.each(["ECONNRESET", "UND_ERR_SOCKET", "AggregateError"])(
      "marks a pre-response %s without replaying the fetch",
      async (code) => {
        const fetchFailure = vi.fn<typeof fetch>(async () => {
          const error = Object.assign(new Error("socket closed"), {
            code: code === "AggregateError" ? "ECONNRESET" : code,
          });
          if (code === "AggregateError") {
            throw new AggregateError([error], "Multiple connections failed");
          }
          throw code === "ECONNRESET" ? error : new TypeError("fetch failed", { cause: error });
        });
        configureAiTransportHost({ buildModelFetch: () => fetchFailure });

        const result = await (await createStream()).result();

        expect(fetchFailure).toHaveBeenCalledTimes(1);
        expect(result.stopReason).toBe("error");
        expect(result.content).toEqual([]);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            type: "provider_transport_failure",
            timestamp: expect.any(Number),
            error: expect.objectContaining({ message: expect.any(String) }),
            details: { eventsEmitted: false, phase: "before_message_stream_start" },
          }),
        );
      },
    );

    it.each(["provider rejection", "caller abort"] as const)(
      "does not mark an empty response after %s",
      async (failure) => {
        const controller = new AbortController();
        const fetchFailure = vi.fn<typeof fetch>(async () => {
          if (failure === "caller abort") {
            controller.abort();
            throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
          }
          return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
            status: 401,
          });
        });
        configureAiTransportHost({ buildModelFetch: () => fetchFailure });
        const result = await (await createStream(controller.signal)).result();
        expect(fetchFailure).toHaveBeenCalledTimes(1);
        expect(result.stopReason).toBe(failure === "caller abort" ? "aborted" : "error");
        expect(result.diagnostics).toBeUndefined();
      },
    );

    it.each(["text", "thinking", "toolCall"] as const)(
      "does not mark a socket drop after a %s delta",
      async (kind) => {
        const openAiDelta =
          kind === "text"
            ? { content: "Partial" }
            : kind === "thinking"
              ? { reasoning_content: "Partial" }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "lookup", arguments: '{"value":' },
                    },
                  ],
                };
        const anthropicBlock =
          kind === "text"
            ? { type: "text", text: "Partial" }
            : kind === "thinking"
              ? { type: "thinking", thinking: "Partial" }
              : { type: "tool_use", id: "call_1", name: "lookup", input: {} };
        const events =
          providerModel.api === "anthropic-messages"
            ? [
                {
                  type: "message_start",
                  message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                { type: "content_block_start", index: 0, content_block: anthropicBlock },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta:
                    kind === "toolCall"
                      ? { type: "input_json_delta", partial_json: '{"value":' }
                      : kind === "thinking"
                        ? { type: "thinking_delta", thinking: " more" }
                        : { type: "text_delta", text: " more" },
                },
              ]
            : [
                {
                  id: "chatcmpl-1",
                  choices: [{ index: 0, delta: openAiDelta, finish_reason: null }],
                },
              ];
        const body = events
          .map((event) => {
            const header = "type" in event ? `event: ${event.type}\n` : "";
            return `${header}data: ${JSON.stringify(event)}\n\n`;
          })
          .join("");
        let failBody: (() => void) | undefined;
        const fetchStream: typeof fetch = async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                failBody = () =>
                  controller.error(
                    Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
                  );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        configureAiTransportHost({ buildModelFetch: () => fetchStream });

        const response = await createStream();
        let sawDelta = false;
        for await (const event of response) {
          if (event.type.endsWith("_delta")) {
            sawDelta = true;
            failBody?.();
          }
        }
        const result = await response.result();
        expect(sawDelta).toBe(true);

        expect(result.stopReason).toBe("error");
        expect(
          result.diagnostics?.some(
            (diagnostic) => diagnostic.type === "provider_transport_failure",
          ),
        ).not.toBe(true);
      },
    );
  },
);
