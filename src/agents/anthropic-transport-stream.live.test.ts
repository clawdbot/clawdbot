/**
 * Live Anthropic transport smoke tests.
 * Runs only when live credentials are enabled and verifies the native messages
 * transport against the configured provider.
 */
import http from "node:http";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { createAnthropicMessagesTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { shouldSkipLiveProviderDrift } from "./live-test-provider-drift.js";
import { isLiveBillingDrift } from "./live-test-provider-drift.test-support.js";

const LIVE = isLiveTestEnabled(["ANTHROPIC_TRANSPORT_LIVE_TEST"]);
const describeLive = LIVE ? describe : describe.skip;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const PROVIDER_LIVE = isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]) && Boolean(ANTHROPIC_KEY);
const describeProviderLive = PROVIDER_LIVE ? describe : describe.skip;
const OPUS_TUPLE_LIVE = isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]) && Boolean(ANTHROPIC_KEY);
const describeOpusTupleLive = OPUS_TUPLE_LIVE ? describe : describe.skip;

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

function skipAnthropicBillingDrift(
  label: string,
  result: { stopReason: string; errorMessage?: string },
): boolean {
  if (result.stopReason !== "error" || !isLiveBillingDrift(result.errorMessage ?? "")) {
    return false;
  }
  console.warn(`[anthropic:live] skip ${label}: billing drift`);
  return true;
}

function classifyProviderError(errorMessage: string | undefined): string {
  if (!errorMessage) {
    return "none";
  }
  return (
    shouldSkipLiveProviderDrift({
      allowAuth: true,
      allowBilling: true,
      allowModelNotFound: true,
      allowProviderUnavailable: true,
      allowRateLimit: true,
      allowTimeout: true,
      error: errorMessage,
    })?.reason ?? "unclassified"
  );
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

describeOpusTupleLive("anthropic Opus tuple schema provider live", () => {
  it("accepts a draft-07 tuple tool after Anthropic projection", async () => {
    const model: AnthropicMessagesModel = {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 512,
    };
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "Call tuple_probe with range [1, 2]." }],
          tools: [
            {
              name: "tuple_probe",
              description: "Return a pair of integers.",
              parameters: {
                type: "object",
                properties: {
                  range: {
                    type: "array",
                    items: [{ type: "integer" }, { type: "integer" }],
                    additionalItems: false,
                  },
                },
                required: ["range"],
              },
            },
          ],
        } as unknown as AnthropicStreamContext,
        {
          apiKey: ANTHROPIC_KEY,
          maxTokens: 128,
          toolChoice: { type: "tool", name: "tuple_probe" },
        } as AnthropicStreamOptions,
      ),
    );

    const result = await stream.result();
    if (skipAnthropicBillingDrift("Opus tuple schema", result)) {
      return;
    }
    const toolCall = result.content.find(
      (block) => block.type === "toolCall" && block.name === "tuple_probe",
    );

    expect(
      result.stopReason,
      `tuple tool projection failed; errorClass=${classifyProviderError(result.errorMessage)}`,
    ).toBe("toolUse");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "tuple_probe",
      arguments: { range: [1, 2] },
    });
  }, 45_000);
});

describeProviderLive("anthropic transport stream provider live", () => {
  it("keeps a healthy forced tool when a sibling descriptor is unreadable", async () => {
    const modelId = process.env.OPENCLAW_LIVE_ANTHROPIC_TOOL_MODEL || "claude-haiku-4-5-20251001";
    const model: AnthropicMessagesModel = {
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 512,
    };
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "Call healthy_probe with value LIVE_OK." }],
          tools: [
            {
              name: "unreadable_probe",
              description: "Unreadable probe",
              get parameters() {
                throw new Error("live unreadable parameters getter");
              },
            },
            {
              name: "healthy_probe",
              description: "Return the requested probe value.",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          ],
        } as unknown as AnthropicStreamContext,
        {
          apiKey: ANTHROPIC_KEY,
          maxTokens: 128,
          toolChoice: { type: "tool", name: "healthy_probe" },
        } as AnthropicStreamOptions,
      ),
    );

    const result = await stream.result();
    if (skipAnthropicBillingDrift("forced tool projection", result)) {
      return;
    }
    const toolCall = result.content.find(
      (block) => block.type === "toolCall" && block.name === "healthy_probe",
    );

    expect(
      result.stopReason,
      `forced tool projection failed; errorClass=${classifyProviderError(result.errorMessage)}`,
    ).toBe("toolUse");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "healthy_probe",
      arguments: { value: "LIVE_OK" },
    });
  }, 45_000);

  it("keeps a healthy forced tool through the Anthropic SDK provider", async () => {
    const modelId = process.env.OPENCLAW_LIVE_ANTHROPIC_TOOL_MODEL || "claude-haiku-4-5-20251001";
    const model: AnthropicMessagesModel = {
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 512,
    };
    const stream = streamAnthropic(
      model,
      {
        messages: [
          { role: "user", content: "Call healthy_probe with value SDK_OK.", timestamp: Date.now() },
        ],
        tools: [
          {
            name: "unreadable_probe",
            description: "Unreadable probe",
            get parameters() {
              throw new Error("live unreadable parameters getter");
            },
          },
          {
            name: "healthy_probe",
            description: "Return the requested probe value.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      } as unknown as Parameters<typeof streamAnthropic>[1],
      {
        apiKey: ANTHROPIC_KEY,
        maxTokens: 128,
        toolChoice: { type: "tool", name: "healthy_probe" },
      },
    );

    const result = await stream.result();
    if (skipAnthropicBillingDrift("SDK forced tool projection", result)) {
      return;
    }
    const toolCall = result.content.find(
      (block) => block.type === "toolCall" && block.name === "healthy_probe",
    );

    expect(
      result.stopReason,
      `SDK forced tool projection failed; errorClass=${classifyProviderError(result.errorMessage)}`,
    ).toBe("toolUse");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "healthy_probe",
      arguments: { value: "SDK_OK" },
    });
  }, 45_000);
});
