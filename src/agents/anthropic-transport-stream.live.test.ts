import http from "node:http";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";

const LIVE = isLiveTestEnabled(["ANTHROPIC_TRANSPORT_LIVE_TEST"]);
const describeLive = LIVE ? describe : describe.skip;

type AnthropicMessagesModel = Model<"anthropic-messages">;
type AnthropicStreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type AnthropicStreamContext = Parameters<AnthropicStreamFn>[1];
type AnthropicStreamOptions = Parameters<AnthropicStreamFn>[2];

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function waitForServerListening(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected loopback server to listen on a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describeLive("anthropic transport stream live", () => {
  it("cancels an in-flight SSE body read over a real HTTP stream", async () => {
    const controller = new AbortController();
    const abortReason = new Error("live anthropic stream abort");
    let requestBody = "";
    let requestBodyPromise: Promise<string> | undefined;
    let resolveResponseStarted: (() => void) | undefined;
    const responseStartedPromise = new Promise<void>((resolve) => {
      resolveResponseStarted = resolve;
    });

    const server = http.createServer((request, response) => {
      requestBodyPromise = readRequestBody(request).then((body) => {
        requestBody = body;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(
          'data: {"type":"message_start","message":{"id":"msg_live","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        );
        resolveResponseStarted?.();
        return body;
      });
    });

    const port = await waitForServerListening(server);
    try {
      const model: AnthropicMessagesModel = {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      };
      const streamFn = createAnthropicMessagesTransportStreamFn();
      const stream = await Promise.resolve(
        streamFn(
          model,
          { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
          {
            apiKey: "sk-ant-live-transport-test",
            signal: controller.signal,
          } as AnthropicStreamOptions,
        ),
      );

      const responseStarted = await Promise.race([
        responseStartedPromise.then(() => true),
        delay(1_000, false),
      ]);
      expect(responseStarted).toBe(true);
      controller.abort(abortReason);

      const timedOut = Symbol("timed out");
      const result = await Promise.race([stream.result(), delay(1_000, timedOut)]);
      if (result === timedOut) {
        throw new Error("Anthropic live SSE stream did not abort within 1000ms");
      }

      expect(result.stopReason).toBe("aborted");
      expect(result.errorMessage).toBe("live anthropic stream abort");
      const capturedRequestBody = requestBodyPromise
        ? await Promise.race([requestBodyPromise, delay(500, requestBody)])
        : requestBody;
      if (capturedRequestBody.trim().length > 0) {
        const body = JSON.parse(capturedRequestBody) as { model?: unknown; stream?: unknown };
        expect(body.model).toBe("claude-sonnet-4-6");
        expect(body.stream).toBe(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(abortReason);
      }
      await closeServer(server);
    }
  }, 10_000);
});
