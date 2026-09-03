import { createServer } from "node:http";
import type { Context, Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { requestPreparedOpenAIResponsesCompaction } from "./openai-responses-compact-request.js";
import { createBoundedOpenAIResponsesCompactionFetch } from "./openai-responses-compaction-window.js";

const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

const context = {
  messages: [{ role: "user", content: "Retain this synthetic conversation.", timestamp: 1 }],
} satisfies Context;
const compacted = {
  object: "response.compaction",
  output: [{ type: "compaction", id: "cmp_http", encrypted_content: "synthetic-opaque" }],
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe("prepared Responses compaction HTTP lifetime", () => {
  it("settles pending reads and releases the body when the consumer cancels", async () => {
    const { promise: pulling, resolve: started } = createDeferred();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      pull() {
        started();
        return new Promise<void>(() => {});
      },
      cancel,
    });
    const response = await createBoundedOpenAIResponsesCompactionFetch(
      async () => new Response(body),
    )("https://synthetic.invalid/compact");
    if (!response.body) {
      throw new Error("Bounded response is missing its body");
    }
    const reader = response.body.getReader();
    const pending = reader.read();
    await pulling;
    try {
      await reader.cancel("consumer stopped");
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      expect(cancel).toHaveBeenCalledExactlyOnceWith("consumer stopped");
      expect(body.locked).toBe(false);
    } finally {
      reader.releaseLock();
    }
  });

  it("cancels and unlocks an oversized body without awaiting upstream cleanup", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const boundedFetch = createBoundedOpenAIResponsesCompactionFetch(
      async () => new Response(body),
    );
    const response = await boundedFetch("https://synthetic.invalid/compact");
    await expect(response.json()).rejects.toThrow("response exceeds 16 MiB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([
    "request-timeout",
    "host-timeout",
    "body-timeout",
    "status-error",
    "caller-abort",
    "success",
    "oversized-body",
  ] as const)("preserves SDK %s behavior with a bounded response body", async (mode) => {
    const deadlineCase =
      mode === "request-timeout" || mode === "host-timeout" || mode === "body-timeout";
    const timeoutMs = deadlineCase ? 100 : 1_000;
    const abortController = new AbortController();
    const requestPaths: string[] = [];
    let watchdogFired = false;
    const { promise: headersReceived, resolve: firstHeaders } = createDeferred();
    configureAiTransportHost({
      resolveModelRequestTimeoutMs: () => (mode === "host-timeout" ? timeoutMs : undefined),
      buildModelFetch: () => async (input, init) => {
        const response = await fetch(input, init);
        firstHeaders();
        return response;
      },
    });
    const server = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      request.resume();
      if (mode === "status-error") {
        // retry-after-ms hint present on purpose: the SDK must still surface
        // the failure on the first attempt instead of retrying internally.
        response.writeHead(503, { "content-type": "application/json", "retry-after-ms": "1" });
        response.end(JSON.stringify({ error: { message: "synthetic 503 failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      if (mode === "oversized-body") {
        response.end(Buffer.alloc(16 * 1024 * 1024 + 1, "x"));
      } else if (mode === "success") {
        response.end(JSON.stringify(compacted));
      } else {
        // Headers arrive promptly; only SDK body parsing can enforce this deadline.
        response.write('{"object":"response.compaction","output":[');
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      abortController.abort(new Error("fixture cleanup: compaction did not settle"));
      server.closeAllConnections();
    }, 2_000);
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback address");
      }
      const model = {
        id: "synthetic-model",
        name: "Synthetic model",
        provider: "synthetic-provider",
        api: "openai-responses",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      } satisfies Model;
      const outcome = requestPreparedOpenAIResponsesCompaction(
        createOpenAIResponsesTransportStreamFn(),
        model,
        context,
        {
          apiKey: "synthetic-loopback-only",
          ...(mode !== "host-timeout" ? { timeoutMs } : {}),
          signal: abortController.signal,
        },
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      if (mode === "caller-abort") {
        await headersReceived;
        abortController.abort();
      }
      const result = await outcome;
      if (deadlineCase) {
        expect(result.error).toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
      } else if (mode === "status-error") {
        expect(result.error).toBeInstanceOf(OpenAI.APIError);
        expect(String(result.error)).toContain("synthetic 503 failure");
      } else if (mode === "caller-abort") {
        expect(result.error).toBeInstanceOf(OpenAI.APIUserAbortError);
      } else if (mode === "oversized-body") {
        expect(result.error).toBeInstanceOf(Error);
        expect(String(result.error)).toContain("response exceeds 16 MiB");
      } else {
        expect(result.error).toBeUndefined();
        expect(result.value?.output).toEqual(compacted.output);
      }
      expect(watchdogFired).toBe(false);
      // Exactly one request per mode: the embedded runner owns transient
      // retries, so the SDK never re-issues a failed compaction call.
      expect(requestPaths).toEqual(["/v1/responses/compact"]);
    } finally {
      clearTimeout(watchdog);
      abortController.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
