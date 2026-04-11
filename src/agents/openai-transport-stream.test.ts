import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  buildOpenAICompletionsParams,
  parseTransportChunkUsage,
  resolveAzureOpenAIApiVersion,
  sanitizeTransportPayloadText,
  __testing,
} from "./openai-transport-stream.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

describe("openai transport stream", () => {
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
    expect(
      createBoundaryAwareStreamFnForModel({
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
      } satisfies Model<"google-generative-ai">),
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

  it("prepares a Google simple-completion api alias when transport overrides are attached", () => {
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

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe(
      "openclaw-google-generative-ai-transport",
    );
    expect(prepared).toMatchObject({
      api: "openclaw-google-generative-ai-transport",
      provider: "google",
      id: "gemini-3.1-pro-preview",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
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

  it("keeps OpenRouter thinking format for declared OpenRouter providers on custom proxy URLs", async () => {
    const streamFn = buildTransportAwareSimpleStreamFn(
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
    );

    expect(streamFn).toBeTypeOf("function");
    let capturedPayload: Record<string, unknown> | undefined;
    let resolveCaptured!: () => void;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });

    void streamFn!(
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        api: "openclaw-openai-completions-transport",
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as Model<"openclaw-openai-completions-transport">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
        onPayload: async (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          resolveCaptured();
          return payload;
        },
      } as never,
    );

    await captured;

    expect(capturedPayload).toMatchObject({
      reasoning: {
        effort: "high",
      },
    });
  });

  it("keeps OpenRouter thinking format for native OpenRouter hosts behind custom provider ids", async () => {
    const streamFn = buildTransportAwareSimpleStreamFn(
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
    );

    expect(streamFn).toBeTypeOf("function");
    let capturedPayload: Record<string, unknown> | undefined;
    let resolveCaptured!: () => void;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });

    void streamFn!(
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        api: "openclaw-openai-completions-transport",
        provider: "custom-openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as Model<"openclaw-openai-completions-transport">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
        onPayload: async (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          resolveCaptured();
          return payload;
        },
      } as never,
    );

    await captured;

    expect(capturedPayload).toMatchObject({
      reasoning: {
        effort: "high",
      },
    });
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

  it("defaults OpenAI Responses reasoning effort to high when unset", () => {
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

    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
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
  ])("replays assistant phase metadata for $label responses payloads", ({ model }) => {
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
      id: "msg_commentary",
      phase: "commentary",
    });
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
      } satisfies Model<"openai-completions">,
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
    expect(params).not.toHaveProperty("stream_options");
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
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function?.strict).toBe(false);
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

  it("does not send tool_choice when tools are provided but toolChoice option is not set", () => {
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
});
