import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import { buildOpenAISdkClientOptions } from "./openai-transport-params.js";

const COLD_RUNNER_HTTP_TEST_TIMEOUT_MS = 300_000;

describe("openai completions transport requests", () => {
  it("passes provider request timeouts to the completions SDK client", () => {
    const requestTimeoutMs = 900_000;
    const model = {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
      requestTimeoutMs,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(buildOpenAISdkClientOptions(model).timeout).toBe(requestTimeoutMs);
  });

  it.each([
    {
      api: "openai-completions" as const,
      provider: "openai",
      createStream: createOpenAICompletionsTransportStreamFn,
    },
  ])(
    "honors turn timeout and pinned SDK retries over real $api HTTP",
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
          { apiKey: "test-key", timeoutMs: 1_234 },
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
  it("preserves OpenAI-compatible error metadata on failed chat requests", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "req_error_metadata",
        });
        res.end(
          JSON.stringify({
            error: {
              message: "Quota exceeded for api_key=sk-secret1234567890abcd",
              type: "rate_limit_error",
              code: "insufficient_quota",
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
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
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
        errorCode: "insufficient_quota",
        errorType: "rate_limit_error",
      });
      expect(String(errorPayload?.errorBody)).toContain("Quota exceeded");
      expect(String(errorPayload?.errorBody)).not.toContain("sk-secret1234567890abcd");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("parses JSON chat completions returned to streaming requests", async () => {
    let capturedStreamFlag: unknown;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedStreamFlag = (JSON.parse(body) as { stream?: unknown }).stream;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            id: "chatcmpl-json-fallback",
            object: "chat.completion",
            model: "moonshotai/kimi-k2.6",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning_content: "Need a direct answer.",
                  content: "live-ok",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
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
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        provider: "openrouter",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        contextWindow: 256_000,
        maxTokens: 16_384,
        compat: {
          supportsReasoningEffort: true,
        },
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply live-ok", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key", reasoningEffort: "high" } as never,
      );

      let doneReason: string | undefined;
      let thinking = "";
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        reason?: string;
      }>) {
        if (event.type === "thinking_delta") {
          thinking += event.delta ?? "";
        }
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(capturedStreamFlag).toBe(true);
      expect(thinking).toBe("Need a direct answer.");
      expect(text).toBe("live-ok");
      expect(doneReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
