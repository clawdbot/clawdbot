import { createServer } from "node:http";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";

describe("incomplete Responses loopback SSE", () => {
  it.each([
    {
      api: "openai-responses" as const,
      provider: "openai",
      createStream: createOpenAIResponsesTransportStreamFn,
    },
    {
      api: "azure-openai-responses" as const,
      provider: "azure-openai",
      createStream: createAzureOpenAIResponsesTransportStreamFn,
    },
  ])("recovers status-less incomplete $api output over real SSE", async (transport) => {
    const requestPaths: string[] = [];
    const server = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const terminalEvent = {
          type: "response.incomplete",
          sequence_number: 0,
          response: {
            id: "resp-statusless-sse",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                id: "msg-statusless-sse",
                role: "assistant",
                content: [{ type: "output_text", text: "TERMINAL_PARTIAL" }],
              },
              {
                type: "function_call",
                id: "fc-statusless-sse",
                call_id: "call-statusless-sse",
                name: "write",
                arguments: '{"path":"unfinished',
              },
            ],
            usage: {
              input_tokens: 21,
              output_tokens: 4,
              total_tokens: 25,
              input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
            },
          },
        };
        response.write(`event: response.incomplete\ndata: ${JSON.stringify(terminalEvent)}\n\n`);
        response.end();
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
      } satisfies Model;

      const stream = await transport.createStream()(
        model,
        {
          messages: [{ role: "user", content: "Reply with a partial sentence", timestamp: 0 }],
          tools: [],
        },
        { apiKey: "test-key", maxRetries: 0 },
      );
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      const terminal = events.find((event) => event.type === "done");
      expect(requestPaths).toHaveLength(1);
      expect(requestPaths[0]).toMatch(/^\/v1\/responses(?:\?|$)/);
      expect(terminal).toMatchObject({
        type: "done",
        reason: "length",
        message: {
          stopReason: "length",
          content: [{ type: "text", text: "TERMINAL_PARTIAL" }],
          usage: {
            input: 13,
            output: 4,
            cacheRead: 6,
            cacheWrite: 2,
            totalTokens: 25,
          },
        },
      });
      if (terminal?.type === "done") {
        expect(terminal.message.content.some((block) => block.type === "toolCall")).toBe(false);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
