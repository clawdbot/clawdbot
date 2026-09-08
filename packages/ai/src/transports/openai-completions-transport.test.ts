import { createServer } from "node:http";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { Model } from "../types.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsChunk,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsModel,
  neverYieldsStream,
} from "./openai-completions.test-support.js";
import { buildOpenAISdkRequestOptions } from "./openai-transport-params.js";

async function captureTransportRequest(model: Model<"openai-completions">) {
  const previousHost = getAiTransportHost();
  let captured: Request | undefined;
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => async (input, init) => {
      captured = new Request(input, init);
      return new Response(
        `data: ${JSON.stringify(makeCompletionsChunk({ content: "ok" }, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const stream = createOpenAICompletionsTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] } as never,
      { apiKey: "test-key" } as never,
    );
    if (stream instanceof Promise) {
      throw new Error("OpenAI Chat transport must return its event stream synchronously");
    }
    for await (const event of stream) {
      // Consume the request through transport finalization.
      void event;
    }
    if (!captured) {
      throw new Error("Expected the transport to issue a request");
    }
    return captured;
  } finally {
    configureAiTransportHost(previousHost);
  }
}

describe("openai completions transport", () => {
  it("passes provider request timeouts to OpenAI SDK per-request options", () => {
    const signal = new AbortController().signal;
    const model = {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      requestTimeoutMs: 900_000.7,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(buildOpenAISdkRequestOptions(model, signal)).toEqual({
      signal,
      timeout: 900_000,
      maxRetries: 0,
    });
    expect(
      buildOpenAISdkRequestOptions(
        { ...model, requestTimeoutMs: -1 } as Model<"openai-completions">,
        undefined,
      ),
    ).toBeUndefined();
  });
  it("streams OpenAI-compatible loopback requests with the configured SDK timeout", async () => {
    let captured: { path?: string; timeout?: string; model?: string; roles?: string[] } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ role?: string }>;
        };
        captured = {
          path: req.url,
          timeout: Array.isArray(req.headers["x-stainless-timeout"])
            ? req.headers["x-stainless-timeout"][0]
            : req.headers["x-stainless-timeout"],
          model: parsed.model,
          roles: parsed.messages?.map((message) => message.role ?? ""),
        };
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk({}, "stop", {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          )}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
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
      const baseModel = {
        id: "mlx-community/Qwen3-30B-A3B-6bit",
        name: "Qwen3 MLX",
        api: "openai-completions",
        provider: "mlx",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
        requestTimeoutMs: 900_000,
      } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };
      const stream = createOpenAICompletionsTransportStreamFn()(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        reason?: string;
      }>) {
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(captured.path).toBe("/v1/chat/completions");
      expect(captured.timeout).toBe("900");
      expect(captured.model).toBe("mlx-community/Qwen3-30B-A3B-6bit");
      expect(captured.roles).toEqual(["system", "user"]);
      expect(doneReason).toBe("stop");
      expect(text).toBe("OK");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses ModelStudio chat streams with no user or assistant payload turns", async () => {
    const model = makeCompletionsModel({
      id: "qwen-coder-plus",
      name: "qwen-coder-plus",
      provider: "qwen",
      baseUrl: "https://modelstudio.example/v1",
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 256,
    });
    const stream = createOpenAICompletionsTransportStreamFn()(
      model,
      {
        systemPrompt: "runtime-only system prompt",
        messages: [],
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

    expect(errorPayload).toMatchObject({ stopReason: "error" });
    expect(String(errorPayload?.errorMessage)).toContain(
      "contains no non-empty user or assistant messages",
    );
    expect(String(errorPayload?.errorMessage)).toContain("system/tool-only request");
  });

  it("allows generic OpenAI-compatible chat streams without the ModelStudio turn guard", async () => {
    let capturedRoles: string[] | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        capturedRoles = parsed.messages?.map((message) => message.role ?? "");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(`data: ${JSON.stringify(makeCompletionsChunk({}, "stop"))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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
        id: "generic-openai-compatible",
        name: "Generic OpenAI Compatible",
        provider: "custom-openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 256,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "runtime-only system prompt",
          messages: [],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      for await (const event of stream as AsyncIterable<{ type: string; reason?: string }>) {
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(capturedRoles).toEqual(["system"]);
      expect(doneReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails OpenAI completions streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
    try {
      const model = createDeepSeekCompletionsModel();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = processCompletionsStream(
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

  it("moves Azure OpenAI completions api-version headers into query params", async () => {
    const request = await captureTransportRequest({
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
    } as unknown as Model<"openai-completions">);
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe(
      "https://example.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      existing: "1",
      "api-version": "2024-10-21",
    });
    expect(request.headers.get("api-key")).toBe("azure-key");
    expect(request.headers.get("x-tenant")).toBe("acme");
    expect(request.headers.has("api-version")).toBe(false);
  });

  it("preserves configured query params without moving non-Azure headers", async () => {
    const request = await captureTransportRequest(
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
    );
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe("https://proxy.example.com/v1/chat/completions");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tenant: "acme" });
    expect(request.headers.get("api-version")).toBe("proxy-header");
    expect(request.headers.get("x-tenant")).toBe("acme");
  });
});
