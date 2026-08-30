import { createServer, type Server } from "node:http";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";

const responsesTransports = [
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
] as const;

async function createResponsesSseServer(event: Record<string, unknown>): Promise<{
  server: Server;
  baseUrl: string;
  requestPaths: string[];
}> {
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
      response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Missing Responses loopback server address");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestPaths };
}

async function closeResponsesSseServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("failed Responses loopback SSE", () => {
  it.each(responsesTransports)(
    "preserves failed $api terminal facts over the real SDK stream",
    async (transport) => {
      const { server, baseUrl, requestPaths } = await createResponsesSseServer({
        type: "response.failed",
        sequence_number: 0,
        response: {
          id: "resp-failed-usage-sse",
          model: "gpt-5.6-luna",
          status: "failed",
          error: { code: "server_error", message: "provider failed after consuming tokens" },
          output: [],
          usage: {
            input_tokens: 21,
            output_tokens: 4,
            total_tokens: 25,
            input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      });

      try {
        const model = {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          api: transport.api,
          provider: transport.provider,
          baseUrl,
          reasoning: true,
          input: ["text"],
          cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        } satisfies Model;

        const stream = await transport.createStream()(
          model,
          {
            messages: [{ role: "user", content: "Report failed usage", timestamp: 0 }],
            tools: [],
          },
          { apiKey: "test-key", maxRetries: 0 },
        );
        const events = [];
        for await (const event of stream) {
          events.push(event);
        }

        expect(requestPaths).toHaveLength(1);
        expect(requestPaths[0]).toMatch(/^\/v1\/responses(?:\?|$)/);
        expect(events.map((event) => event.type)).toEqual(["start", "error"]);
        const terminal = events.at(-1);
        expect(terminal).toMatchObject({
          type: "error",
          reason: "error",
          error: {
            responseId: "resp-failed-usage-sse",
            responseModel: "gpt-5.6-luna",
            stopReason: "error",
            errorMessage: "server_error: provider failed after consuming tokens",
            // The structured error.code must survive normalization -> the thrown
            // ResponsesStreamFailure -> projectProviderError into errorCode, so the
            // failover classifier receives a structured descriptor and consults the
            // provider hook instead of misreading the folded message as timeout (#117609).
            errorCode: "server_error",
            usage: {
              input: 13,
              output: 4,
              cacheRead: 6,
              cacheWrite: 2,
              reasoningTokens: 3,
              totalTokens: 25,
            },
          },
        });
        if (terminal?.type === "error") {
          expect(terminal.error.usage.cost.input).toBeCloseTo(0.000065, 10);
          expect(terminal.error.usage.cost.output).toBeCloseTo(0.00012, 10);
          expect(terminal.error.usage.cost.cacheRead).toBeCloseTo(0.000003, 10);
          expect(terminal.error.usage.cost.cacheWrite).toBeCloseTo(0.0000125, 10);
          expect(terminal.error.usage.cost.total).toBeCloseTo(0.0002005, 10);
        }
      } finally {
        await closeResponsesSseServer(server);
      }
    },
  );
});
