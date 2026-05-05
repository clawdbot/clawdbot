import { createServer } from "node:http";
import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenAIResponsesParams,
  buildOpenAICompletionsParams,
  createOpenAICompletionsTransportStreamFn,
  parseTransportChunkUsage,
  resolveAzureOpenAIApiVersion,
  sanitizeTransportPayloadText,
  __testing,
} from "./openai-transport-stream.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createOpenClawTransportStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

describe("openai transport stream", () => {
  it("adds OpenClaw attribution to native OpenAI transport headers and protects it from pi", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const headers = __testing.buildOpenAIClientHeaders(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        headers: {
          originator: "pi",
          "User-Agent": "pi",
          "X-Provider": "model",
        },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      { systemPrompt: "", messages: [] } as never,
      {
        originator: "pi",
        "User-Agent": "pi",
        "X-Caller": "request",
      },
    );

    expect(headers).toMatchObject({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
      "X-Provider": "model",
      "X-Caller": "request",
    });
  });

  it("adds OpenClaw attribution to native OpenAI Codex transport headers", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const headers = __testing.buildOpenAIClientHeaders(
      {
        id: "gpt-5.4-codex",
        name: "GPT-5.4 Codex",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {
          originator: "pi",
          "User-Agent": "pi",
        },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      { systemPrompt: "", messages: [] } as never,
    );

    expect(headers).toMatchObject({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("moves Azure OpenAI completions api-version headers into default query params", () => {
    const config = __testing.buildOpenAICompletionsClientConfig(
      {
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
      } as unknown as Model<"openai-completions">,
      { systemPrompt: "", messages: [] } as never,
    );

    expect(config).toEqual({
      baseURL: "https://example.openai.azure.com/openai/deployments/gpt-4o-mini",
      defaultHeaders: {
        "api-key": "azure-key",
        "X-Tenant": "acme",
      },
      defaultQuery: {
        existing: "1",
        "api-version": "2024-10-21",
      },
    });
  });

  it("preserves configured base URL query params without moving non-Azure headers", () => {
    const config = __testing.buildOpenAICompletionsClientConfig(
      {
        id: "proxy-model",
        name: "Proxy Model",
        api: "openai-completions",
        provider: "custom-proxy",
        baseUrl: "https://proxy.example.com/v1?tenant=acme",
        headers: {
          "api-version": "proxy-header",
          "X-Tenant": "acme",
        },
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      } satisfies Model<"openai-completions">,
      { systemPrompt: "", messages: [] } as never,
    );

    expect(config).toEqual({
      baseURL: "https://proxy.example.com/v1",
      defaultHeaders: {
        "api-version": "proxy-header",
        "X-Tenant": "acme",
      },
      defaultQuery: {
        tenant: "acme",
      },
    });
  });

  it("reports the supported transport-aware APIs", () => {
    expect(isTransportAwareApiSupported("openai-responses")).toBe(true);
    expect(isTransportAwareApiSupported("openai-codex-responses")).toBe(true);
    expect(isTransportAwareApiSupported("openai-completions")).toBe(true);
    expect(isTransportAwareApiSupported("azure-openai-responses")).toBe(true);
    expect(isTransportAwareApiSupported("anthropic-messages")).toBe(true);
    expect(isTransportAwareApiSupported("google-generative-ai")).toBe(true);
  });

  it("builds boundary-aware stream shapers for supported default agent transports", () => {
    expect(
      createBoundaryAwareStreamFnForModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">),
    ).toBeTypeOf("function");
    expect(
      createOpenClawTransportStreamFnForModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">),
    ).toBeTypeOf("function");
    expect(
      createBoundaryAwareStreamFnForModel({
        id: "codex-mini-latest",
        name: "Codex Mini Latest",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">),
    ).toBeTypeOf("function");
    expect(
      createBoundaryAwareStreamFnForModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">),
    ).toBeTypeOf("function");
  });

  it("prepares a custom simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expect(prepared).toMatchObject({
      api: "openclaw-openai-responses-transport",
      provider: "openai",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("prepares a Codex Responses simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "codex-mini-latest",
        name: "Codex Mini Latest",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expect(prepared).toMatchObject({
      api: "openclaw-openai-responses-transport",
      provider: "openai-codex",
      id: "codex-mini-latest",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("prepares an Anthropic simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expect(prepared).toMatchObject({
      api: "openclaw-anthropic-messages-transport",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("reports the Google simple-completion api alias without loading provider runtime", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        api: "google-generative-ai",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"google-generative-ai">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe(
      "openclaw-google-generative-ai-transport",
    );
  });

  it("keeps github-copilot OpenAI-family models on the shared transport seam", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
      api: "openclaw-openai-responses-transport",
      provider: "github-copilot",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("keeps github-copilot Claude models on the shared Anthropic transport seam", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/anthropic",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
      api: "openclaw-anthropic-messages-transport",
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("removes unpaired surrogate code units but preserves valid surrogate pairs", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    expect(sanitizeTransportPayloadText(`left${high}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText(`left${low}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText("emoji 🙈 ok")).toBe("emoji 🙈 ok");
  });

  it("uses a valid Azure API version default when the environment is unset", () => {
    expect(resolveAzureOpenAIApiVersion({})).toBe("2024-12-01-preview");
    expect(resolveAzureOpenAIApiVersion({ AZURE_OPENAI_API_VERSION: "2025-01-01-preview" })).toBe(
      "2025-01-01-preview",
    );
  });

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
    const completionsModel = {
      ...responsesModel,
      api: "openai-completions",
      reasoning: false,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(__testing.buildOpenAISdkClientOptions(responsesModel).timeout).toBe(requestTimeoutMs);
    expect(__testing.buildOpenAISdkClientOptions(azureModel).timeout).toBe(requestTimeoutMs);
    expect(__testing.buildOpenAISdkClientOptions(completionsModel).timeout).toBe(requestTimeoutMs);
  });

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

    expect(__testing.buildOpenAISdkRequestOptions(model, signal)).toEqual({
      signal,
      timeout: 900_000,
    });
    expect(
      __testing.buildOpenAISdkRequestOptions(
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
        const created = Math.floor(Date.now() / 1000);
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-timeout-proof",
            object: "chat.completion.chunk",
            created,
            model: "mlx-community/Qwen3-30B-A3B-6bit",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "OK" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-timeout-proof",
            object: "chat.completion.chunk",
            created,
            model: "mlx-community/Qwen3-30B-A3B-6bit",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  it("does not double-count reasoning tokens and clamps uncached prompt usage at zero", () => {
    const model = {
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    expect(
      parseTransportChunkUsage(
        {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
        model,
      ),
    ).toMatchObject({
      input: 7,
      output: 20,
      cacheRead: 3,
      totalTokens: 30,
    });

    expect(
      parseTransportChunkUsage(
        {
          prompt_tokens: 2,
          completion_tokens: 5,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 4 },
        },
        model,
      ),
    ).toMatchObject({
      input: 0,
      output: 5,
      cacheRead: 4,
      totalTokens: 9,
    });
  });

  it("records usage from OpenAI-compatible streaming usage chunks", async () => {
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
    } satisfies Model<"openai-completions">;
    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream: { push(event: unknown): void } = { push() {} };

    async function* mockStream() {
      yield {
        id: "chatcmpl-vllm",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: "glm-5",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" as const, content: "ok" },
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      };
      yield {
        id: "chatcmpl-vllm",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: "glm-5",
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 10,
          total_tokens: 18,
        },
      };
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.usage).toMatchObject({
      input: 8,
      output: 10,
      cacheRead: 0,
      totalTokens: 18,
    });
  });

  it("skips null and non-object OpenAI-compatible stream chunks", async () => {
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
    } satisfies Model<"openai-completions">;
    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream: { push(event: unknown): void } = { push() {} };

    async function* mockStream() {
      yield null as never;
      yield "not-a-chunk" as never;
      yield {
        id: "chatcmpl-vllm",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: "glm-5",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" as const, content: "ok" },
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      };
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toContainEqual({ type: "text", text: "ok" });
    expect(output.stopReason).toBe("stop");
  });

  it("keeps OpenRouter thinking format for declared OpenRouter providers on custom proxy URLs", () => {
    const params = buildOpenAICompletionsParams(
      attachModelProviderRequestTransport(
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          api: "openai-completions",
          provider: "openrouter",
          baseUrl: "https://proxy.example.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        } satisfies Model<"openai-completions">,
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      ),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    );

    expect(params).toMatchObject({
      reasoning: {
        effort: "high",
      },
    });
  });

  it("keeps OpenRouter thinking format for native OpenRouter hosts behind custom provider ids", () => {
    const params = buildOpenAICompletionsParams(
      attachModelProviderRequestTransport(
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          api: "openai-completions",
          provider: "custom-openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        } satisfies Model<"openai-completions">,
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      ),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    );

    expect(params).toMatchObject({
      reasoning: {
        effort: "high",
      },
    });
  });

  it("does not build OpenRouter reasoning params for Hunter Alpha when reasoning is disabled", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    ) as { reasoning?: unknown; reasoning_effort?: unknown };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("uses system role instead of developer for responses providers that disable developer role", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]).toMatchObject({ role: "system" });
  });

  it("keeps developer role for native OpenAI reasoning responses models", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]).toMatchObject({ role: "developer" });
  });

  it("uses model maxTokens for Responses params when runtime maxTokens is omitted", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 65_536,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { max_output_tokens?: unknown };

    expect(params.max_output_tokens).toBe(65_536);
  });

  it("uses top-level instructions for Codex responses and preserves prompt cache identity", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        serviceTier: "auto",
        sessionId: "session-123",
        temperature: 0.2,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown> & {
      input?: Array<{ role?: string }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input?.some((item) => item.role === "system" || item.role === "developer")).toBe(
      false,
    );
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("metadata");
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("service_tier");
    expect(params).not.toHaveProperty("temperature");
  });

  it("sanitizes Codex responses params after payload hooks mutate them without stripping cache identity", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
    };

    const sanitized = __testing.sanitizeOpenAICodexResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      payload,
    );

    expect(sanitized.prompt_cache_key).toBe("session-123");
    expect(sanitized).not.toHaveProperty("metadata");
    expect(sanitized).not.toHaveProperty("max_output_tokens");
    expect(sanitized).not.toHaveProperty("prompt_cache_retention");
    expect(sanitized).not.toHaveProperty("service_tier");
    expect(sanitized).not.toHaveProperty("temperature");
  });

  it("preserves custom Codex-compatible responses params", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        sessionId: "session-123",
        temperature: 0.2,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.metadata).toEqual({
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
    });
    expect(params.max_output_tokens).toBe(1024);
    expect(params.temperature).toBe(0.2);
  });

  it("preserves custom Codex-compatible responses params after payload hooks mutate them", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
    };

    const sanitized = __testing.sanitizeOpenAICodexResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      payload,
    );

    expect(sanitized).toEqual(payload);
  });

  it("omits prior Responses replay item ids for native Codex responses", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_abc|fc_prior",
            toolName: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
            isError: false,
            timestamp: 2,
          },
          { role: "user", content: "what is the capital of the philippines", timestamp: 3 },
        ],
        tools: [],
      } as never,
      { sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        encrypted_content?: string;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
    });
    expect(reasoningItem?.id).toBeUndefined();
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
  });

  it("preserves prior Responses replay item ids for custom Codex-compatible responses", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
        ],
        tools: [],
      } as never,
      { sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
      }>;
    };

    expect(params.input?.some((item) => item.type === "reasoning")).toBe(true);
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      id: "msg_prior",
      phase: "commentary",
    });
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      id: "fc_prior",
      call_id: "call_abc",
    });
  });

  it("adds minimal user input for Codex responses when only the system prompt is present", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: " " }],
      },
    ]);
  });

  it("does not infer high reasoning when Pi passes thinking off", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params.reasoning).toEqual({ effort: "none" });
    expect(params).not.toHaveProperty("include");
  });

  it("uses shared stream reasoning as OpenAI Responses effort", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "high",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("uses disabled OpenAI Responses reasoning when the model supports none", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "none",
      } as never,
    ) as { reasoning?: unknown; include?: unknown };

    expect(params.reasoning).toEqual({ effort: "none" });
    expect(params).not.toHaveProperty("include");
  });

  it("omits disabled OpenAI Responses reasoning when the model does not support none", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5",
        name: "GPT-5",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "none",
      } as never,
    ) as { reasoning?: unknown; include?: unknown };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it("maps minimal shared reasoning to low for OpenAI Responses", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("raises minimal OpenAI Responses reasoning when web_search is available", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    } as unknown as Model<"openai-responses">;

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("keeps minimal OpenAI Responses reasoning without web_search", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    } as unknown as Model<"openai-responses">;

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });

  it("maps low reasoning to medium for Codex mini responses models", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.1-codex-mini",
        name: "gpt-5.1-codex-mini",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-codex-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "low",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it.each([
    {
      label: "openai",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    },
    {
      label: "openai-codex",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
      },
    },
    {
      label: "azure-openai-responses",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "https://azure.example.openai.azure.com/openai/v1",
      },
    },
    {
      label: "custom-openai-responses",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "custom-openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      },
    },
  ])("replays assistant phase metadata for $label responses payloads", ({ label, model }) => {
    const params = buildOpenAIResponsesParams(
      {
        ...model,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: "Working...",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_commentary",
                  phase: "commentary",
                }),
              },
            ],
          },
          {
            role: "user",
            content: "Continue",
            timestamp: 2,
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ role?: string; id?: string; phase?: string }>;
    };

    const assistantItem = params.input?.find((item) => item.role === "assistant");
    expect(assistantItem).toMatchObject({
      role: "assistant",
      phase: "commentary",
    });
    if (label === "openai-codex") {
      expect(assistantItem?.id).toBeUndefined();
    } else {
      expect(assistantItem?.id).toBe("msg_commentary");
    }
  });

  it("strips the internal cache boundary from OpenAI system prompts", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ content?: string }> };

    expect(params.input?.[0]?.content).toBe("Stable prefix\nDynamic suffix");
  });

  it("defaults responses tool schemas to strict on native OpenAI routes", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]?.strict).toBe(true);
    expect(params.tools?.[0]).toMatchObject({
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
        required: [],
      },
    });
  });

  it("falls back to strict:false when a native OpenAI tool schema is not strict-compatible", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]?.strict).toBe(false);
  });

  it("omits responses strict tool shaping for proxy-like OpenAI routes", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]).not.toHaveProperty("strict");
  });

  it("still normalizes responses tool parameters when strict is omitted", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: {},
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]).not.toHaveProperty("strict");
    expect(params.tools?.[0]?.parameters).toMatchObject({
      type: "object",
      properties: {},
    });
  });

  it("normalizes responses tool parameters while downgrading native strict:false", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]?.strict).toBe(false);
    expect(params.tools?.[0]?.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("adds native OpenAI turn metadata on direct Responses routes", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { sessionId: "session-123" } as never,
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
        openclaw_turn_attempt: "1",
        openclaw_transport: "stream",
      },
    ) as { metadata?: Record<string, string> };

    expect(params.metadata).toMatchObject({
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
      openclaw_turn_attempt: "1",
      openclaw_transport: "stream",
    });
  });

  it("leaves proxy-like OpenAI Responses routes without native turn metadata by default", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { sessionId: "session-123" } as never,
      undefined,
    ) as { metadata?: Record<string, string> };

    expect(params).not.toHaveProperty("metadata");
  });

  it("gates responses service_tier to native OpenAI endpoints", () => {
    const nativeParams = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };
    const proxyParams = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };

    expect(nativeParams.service_tier).toBe("priority");
    expect(proxyParams).not.toHaveProperty("service_tier");
  });

  it("strips store when responses compat disables it", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "custom-provider",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { store?: unknown };

    expect(params).not.toHaveProperty("store");
  });

  it("uses system role for xAI default-route responses providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]).toMatchObject({ role: "system" });
  });

  it("uses system role for Moonshot default-route completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        api: "openai-completions",
        provider: "moonshot",
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ role?: string }> };

    expect(params.messages?.[0]).toMatchObject({ role: "system" });
  });

  it("strips the internal cache boundary from OpenAI completions system prompts", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ content?: string }> };

    expect(params.messages?.[0]?.content).toBe("Stable prefix\nDynamic suffix");
  });

  it("uses shared stream reasoning as OpenAI completions effort", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "medium",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("medium");
  });

  it("maps minimal shared reasoning to low for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("low");
  });

  it("defaults OpenAI completions reasoning effort to high when unset", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort for gpt-5.4-mini Chat Completions tool payloads", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "medium",
      } as never,
    ) as { reasoning_effort?: unknown; tools?: unknown };

    expect(params.tools).toBeDefined();
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("keeps reasoning_effort for gpt-5.4-mini Chat Completions payloads without tools", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "medium",
      } as never,
    ) as { reasoning_effort?: unknown; tools?: unknown };

    expect(params.tools).toEqual([]);
    expect(params.reasoning_effort).toBe("medium");
  });

  it("uses provider-native reasoning effort values declared by model compat", () => {
    const baseModel = {
      id: "qwen/qwen3-32b",
      name: "Qwen 3 32B",
      api: "openai-completions",
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "default"],
        reasoningEffortMap: {
          off: "none",
          low: "default",
          medium: "default",
          high: "default",
        },
      },
    } as unknown as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const enabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "medium",
    } as never) as { reasoning_effort?: unknown };
    const disabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "off",
    } as never) as { reasoning_effort?: unknown };

    expect(enabled.reasoning_effort).toBe("default");
    expect(disabled.reasoning_effort).toBe("none");
  });

  it("omits unsupported disabled reasoning for completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "openai/gpt-oss-120b",
        name: "GPT OSS 120B",
        api: "openai-completions",
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "off",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("uses system role and streaming usage compat for native Qwen completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        api: "openai-completions",
        provider: "qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      messages?: Array<{ role?: string }>;
      stream_options?: { include_usage?: boolean };
    };

    expect(params.messages?.[0]).toMatchObject({ role: "system" });
    expect(params.stream_options).toMatchObject({ include_usage: true });
  });

  it("enables streaming usage compat for generic providers on native DashScope endpoints", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "glm-5",
        name: "GLM-5",
        api: "openai-completions",
        provider: "generic",
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options).toMatchObject({ include_usage: true });
  });

  it("honors explicit streaming usage compat for configured custom providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-completions",
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsUsageInStreaming: true },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options).toMatchObject({ include_usage: true });
  });

  it("always includes stream_options.include_usage for known local backends like llama-cpp", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "llama-3",
        name: "Llama 3",
        api: "openai-completions",
        provider: "llama-cpp",
        baseUrl: "http://localhost:8080/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("forwards prompt_cache_key for opted-in OpenAI-compatible completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-completions",
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsPromptCacheKey: true },
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { sessionId: "session-123" },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("session-123");
  });

  it("omits prompt_cache_key for completions when caching is disabled or not opted in", () => {
    const baseModel = {
      id: "custom-model",
      name: "Custom Model",
      api: "openai-completions",
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const disabled = buildOpenAICompletionsParams(
      {
        ...baseModel,
        compat: { supportsPromptCacheKey: true },
      } as unknown as Model<"openai-completions">,
      context,
      { sessionId: "session-123", cacheRetention: "none" },
    ) as { prompt_cache_key?: string };
    const notOptedIn = buildOpenAICompletionsParams(baseModel, context, {
      sessionId: "session-123",
    }) as { prompt_cache_key?: string };

    expect(disabled.prompt_cache_key).toBeUndefined();
    expect(notOptedIn.prompt_cache_key).toBeUndefined();
  });

  it("disables developer-role-only compat defaults for configured custom proxy completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-completions",
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    ) as {
      messages?: Array<{ role?: string }>;
      reasoning_effort?: unknown;
      stream_options?: unknown;
      store?: unknown;
      tools?: Array<{ function?: { strict?: boolean } }>;
    };

    expect(params.messages?.[0]).toMatchObject({ role: "system" });
    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params.stream_options).toMatchObject({ include_usage: true });
    expect(params).not.toHaveProperty("store");
    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("flattens pure text content arrays for string-only completions backends when opted in", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "google/gemma-4-E2B-it",
        name: "Gemma 4 E2B",
        api: "openai-completions",
        provider: "inferrs",
        baseUrl: "http://127.0.0.1:8080/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
        compat: {
          requiresStringContent: true,
        } as Record<string, unknown>,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What is 2 + 2?" }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ role?: string; content?: unknown }> };

    expect(params.messages?.[0]).toMatchObject({ role: "system", content: "system" });
    expect(params.messages?.[1]).toMatchObject({ role: "user", content: "What is 2 + 2?" });
  });

  it("uses max_tokens for Chutes default-route completions providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "zai-org/GLM-4.7-TEE",
        name: "GLM 4.7 TEE",
        api: "openai-completions",
        provider: "chutes",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
      } as never,
    );

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("uses model maxTokens for OpenAI completions params when runtime maxTokens is omitted", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 65_536,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("uses model maxTokens with max_tokens completions compat when runtime maxTokens is omitted", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "zai-org/GLM-4.7-TEE",
        name: "GLM 4.7 TEE",
        api: "openai-completions",
        provider: "chutes",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 65_536,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("omits strict tool shaping for Z.ai default-route completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "glm-5",
        name: "GLM 5",
        api: "openai-completions",
        provider: "zai",
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("defaults completions tool schemas to strict on native OpenAI routes", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5",
        name: "GPT-5",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function?.strict).toBe(true);
  });

  it("falls back to completions strict:false when a native OpenAI tool schema is not strict-compatible", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5",
        name: "GPT-5",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function?.strict).toBe(false);
  });

  describe("Gemini thought_signature round-trip on OpenAI-compatible completions", () => {
    const geminiModel = {
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
      api: "openai-completions",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    function makeAssistantOutput(model: Model<"openai-completions">) {
      return {
        role: "assistant" as const,
        content: [] as Array<Record<string, unknown>>,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    }

    it("captures thought_signature from streamed Google tool_calls", async () => {
      const output = makeAssistantOutput(geminiModel);
      const chunks = [
        {
          id: "chatcmpl-gemini",
          object: "chat.completion.chunk" as const,
          created: 1,
          model: geminiModel.id,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    type: "function",
                    function: { name: "echo_value", arguments: "" },
                    extra_content: { google: { thought_signature: "SIG-OPAQUE-ABC==" } },
                  },
                ],
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-gemini",
          object: "chat.completion.chunk" as const,
          created: 1,
          model: geminiModel.id,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"value":"repro"}' } }],
              },
              logprobs: null,
              finish_reason: "tool_calls" as const,
            },
          ],
        },
      ] as const;
      async function* mockStream() {
        for (const chunk of chunks) {
          yield chunk as never;
        }
      }

      await __testing.processOpenAICompletionsStream(mockStream(), output, geminiModel, {
        push() {},
      });

      expect(output.content[0]).toMatchObject({
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: { value: "repro" },
        thoughtSignature: "SIG-OPAQUE-ABC==",
      });
    });

    it("re-emits captured thought_signature for same Google route tool-call replay", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            { role: "user", content: "echo" },
            {
              role: "assistant",
              api: geminiModel.api,
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature: "SIG-OPAQUE-ABC==",
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call_abc",
              toolName: "echo_value",
              content: [{ type: "text", text: "ok" }],
              isError: false,
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "SIG-OPAQUE-ABC==",
      );
    });

    it("does not replay thought_signature across a different API surface", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            {
              role: "assistant",
              api: "google-generative-ai",
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature: "SIG-OPAQUE-ABC==",
                },
              ],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: unknown }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content).toBeUndefined();
    });

    it("does not emit extra_content when no thought_signature was captured", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            {
              role: "assistant",
              api: geminiModel.api,
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [{ type: "toolCall", id: "call_abc", name: "echo_value", arguments: {} }],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: unknown }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content).toBeUndefined();
    });
  });

  it("uses Mistral compat defaults for direct Mistral completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        api: "openai-completions",
        provider: "mistral",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
        reasoningEffort: "high",
      } as never,
    );

    expect(params).toMatchObject({
      max_tokens: 2048,
    });
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("uses Mistral compat defaults for custom providers on native Mistral hosts", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        api: "openai-completions",
        provider: "custom-mistral-host",
        baseUrl: "https://api.mistral.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
        reasoningEffort: "high",
      } as never,
    );

    expect(params).toMatchObject({
      max_tokens: 2048,
    });
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("serializes raw string tool-call arguments without double-encoding them", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "toolCall",
                id: "call_abc|fc_item1",
                name: "my_tool",
                arguments: "not valid json",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ type?: string; arguments?: string }>;
    };

    const functionCall = params.input?.find((item) => item.type === "function_call");
    expect(functionCall).toBeDefined();
    expect(functionCall?.arguments).toBe("not valid json");
  });

  it("defaults tool_choice to auto for proxy-like openai-completions endpoints", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "test-model",
        name: "Test Model",
        api: "openai-completions",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 2048,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [
          {
            name: "get_weather",
            description: "Get weather information",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect(params).toHaveProperty("tool_choice", "auto");
  });

  it("does not send tool_choice by default for native openai-completions endpoints", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 2048,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [
          {
            name: "get_weather",
            description: "Get weather information",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("sends tool_choice when explicitly configured", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "test-model",
        name: "Test Model",
        api: "openai-completions",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 2048,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [
          {
            name: "get_weather",
            description: "Get weather information",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      {
        toolChoice: "required",
      },
    );

    expect(params).toHaveProperty("tools");
    expect(params).toHaveProperty("tool_choice", "required");
  });

  it("resets stopReason to stop when finish_reason is tool_calls but tool_calls array is empty", async () => {
    const model = {
      id: "nemotron-3-super",
      name: "Nemotron 3 Super",
      api: "openai-completions",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream = {
      push: () => {},
    };

    const mockChunks = [
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: "nemotron-3-super",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" as const, content: "" },
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: "nemotron-3-super",
        choices: [
          {
            index: 0,
            delta: { content: "4" },
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: "nemotron-3-super",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [] as never[] },
            logprobs: null,
            finish_reason: "tool_calls" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("stop");
    expect(output.content.some((block) => (block as { type?: string }).type === "toolCall")).toBe(
      false,
    );
  });

  it("handles reasoning_details from OpenRouter/Qwen3 in completions stream", async () => {
    const model = {
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-reasoning",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "reasoning.text", text: "I need to think about this." },
                { type: "reasoning.text", text: " Let me analyze." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-reasoning",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              content: " Hello! How can I help you?",
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-reasoning",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    const thinkingBlock = output.content[0] as { type: string; thinking: string };
    const textBlock = output.content[1] as { type: string; text: string };

    expect(output.content.length).toBe(2);
    expect(thinkingBlock.type).toBe("thinking");
    expect(thinkingBlock.thinking).toBe("I need to think about this. Let me analyze.");
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toBe(" Hello! How can I help you?");
  });

  it("keeps tool calls when reasoning_details and tool_calls share a chunk", async () => {
    const model = {
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-toolcall",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "Need a tool." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":"qwen3"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-toolcall",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "thinking", thinking: "Need a tool.", thinkingSignature: "reasoning_details" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "qwen3" } },
    ]);
  });

  it("treats singular tool_call finish_reason as tool use", async () => {
    const model = {
      id: "minimax-m2.5-8bit",
      name: "MiniMax M2.5 8bit",
      api: "openai-completions",
      provider: "mlx-lm",
      baseUrl: "http://localhost:1234/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-mlx",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: model.id,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-mlx",
        object: "chat.completion.chunk" as const,
        created: 1775425651,
        model: model.id,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_call",
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", id: "call_1", name: "lookup" }),
    );
  });

  it("keeps streamed tool call arguments intact when reasoning_details repeats", async () => {
    const model = {
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-toolcall-stream",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "Need a tool." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-toolcall-stream",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: " Still thinking." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { arguments: '"qwen3"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-toolcall-stream",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "thinking", thinking: "Need a tool." },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "qwen3" } },
      { type: "thinking", thinking: " Still thinking.", thinkingSignature: "reasoning_details" },
    ]);
  });

  it("surfaces visible OpenRouter response text from reasoning_details without dropping tools", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-minimax",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "reasoning.text", text: "Need to look something up." },
                { type: "response.output_text", text: "Working on it." },
              ],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":"weather"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-minimax",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_calls" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      {
        type: "thinking",
        thinking: "Need to look something up.",
        thinkingSignature: "reasoning_details",
      },
      { type: "text", text: "Working on it." },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "weather" } },
    ]);
  });

  it("does not surface ambiguous reasoning_details text without explicit compat opt-in", async () => {
    const model = {
      id: "openrouter/x-ai/grok-4",
      name: "Grok 4",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-grok",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "reasoning.text", text: "Internal thought." },
                { type: "text", text: "Do not leak this by default." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-grok",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toMatchObject([
      {
        type: "thinking",
        thinking: "Internal thought.",
        thinkingSignature: "reasoning_details",
      },
    ]);
  });

  it("preserves reasoning_details item order when visible text and thinking are interleaved", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-minimax-order",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "response.output_text", text: "Visible first." },
                { type: "reasoning.text", text: " Hidden second." },
                { type: "response.text", text: " Visible third." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toMatchObject([
      { type: "text", text: "Visible first." },
      {
        type: "thinking",
        thinking: " Hidden second.",
        thinkingSignature: "reasoning_details",
      },
      { type: "text", text: " Visible third." },
    ]);
  });

  it("does not duplicate fallback reasoning fields when reasoning_details already provided thinking", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-fallback-dup",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "Primary reasoning." }],
              reasoning: "Duplicate fallback reasoning.",
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toMatchObject([
      {
        type: "thinking",
        thinking: "Primary reasoning.",
        thinkingSignature: "reasoning_details",
      },
    ]);
  });

  it("keeps fallback thinking when reasoning_details only carries visible text", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-visible-fallback",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "response.output_text", text: "Visible answer." }],
              reasoning: "Hidden fallback reasoning.",
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toMatchObject([
      { type: "text", text: "Visible answer." },
      {
        type: "thinking",
        thinking: "Hidden fallback reasoning.",
        thinkingSignature: "reasoning",
      },
    ]);
  });

  it("keeps a streaming tool call intact when visible reasoning text arrives mid-call", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-tool-split",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tool-split",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { arguments: '"weather"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tool-split",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_calls" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "weather" } },
      { type: "text", text: "Working on it." },
    ]);
  });

  it("keeps a streaming tool call intact when visible reasoning text arrives between chunks", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      {
        id: "chatcmpl-tool-split-gap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tool-split-gap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tool-split-gap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { arguments: '"weather"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tool-split-gap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_calls" as const,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await __testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "weather" } },
      { type: "text", text: "Working on it." },
    ]);
  });

  it("fails fast when post-tool-call buffering grows beyond the safety cap", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };
    const oversizedText = "x".repeat(300_000);

    const mockChunks = [
      {
        id: "chatcmpl-tool-buffer-cap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tool-buffer-cap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              content: oversizedText,
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await expect(
      __testing.processOpenAICompletionsStream(mockStream(), output, model, stream),
    ).rejects.toThrow("Exceeded post-tool-call delta buffer limit");
  });

  it("fails fast when streaming tool-call arguments grow beyond the safety cap", async () => {
    const model = {
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const stream: { push(event: unknown): void } = { push() {} };
    const oversizedArgs = `"${"x".repeat(300_000)}"}`;

    const mockChunks = [
      {
        id: "chatcmpl-tool-arg-cap",
        object: "chat.completion.chunk" as const,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: `{${oversizedArgs}` },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      },
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await expect(
      __testing.processOpenAICompletionsStream(mockStream(), output, model, stream),
    ).rejects.toThrow("Exceeded tool-call argument buffer limit");
  });
});
