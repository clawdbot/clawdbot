import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let buildGoogleGenerativeAiParams: typeof import("./transport-stream.js").buildGoogleGenerativeAiParams;
let createGoogleGenerativeAiTransportStreamFn: typeof import("./transport-stream.js").createGoogleGenerativeAiTransportStreamFn;

const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: unknown,
): TModel {
  return {
    ...model,
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request,
  };
}

function buildGeminiModel(
  overrides: Partial<Model<"google-generative-ai">> = {},
): Model<"google-generative-ai"> {
  return {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("google transport stream", () => {
  beforeAll(async () => {
    ({ buildGoogleGenerativeAiParams, createGoogleGenerativeAiTransportStreamFn } =
      await import("./transport-stream.js"));
  });

  beforeEach(() => {
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
  });

  it("uses the guarded fetch transport and parses Gemini SSE output", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          responseId: "resp_1",
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "draft", thoughtSignature: "sig_1" },
                  { text: "answer" },
                  {
                    thoughtSignature: "call_sig_1",
                    functionCall: { name: "lookup", args: { q: "hello" } },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            cachedContentTokenCount: 2,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
          },
        },
      ]),
    );

    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        api: "google-generative-ai",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        headers: { "X-Provider": "google" },
      } satisfies Model<"google-generative-ai">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          systemPrompt: "Follow policy.",
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: {
                type: "object",
                properties: { q: { type: "string" } },
                required: ["q"],
              },
            },
          ],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          apiKey: "gemini-api-key",
          cachedContent: "cachedContents/request-cache",
          reasoning: "medium",
          toolChoice: "auto",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          "Content-Type": "application/json",
          "x-goog-api-key": "gemini-api-key",
          "X-Provider": "google",
        }),
      }),
    );

    const init = guardedFetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = init.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected Google transport request body to be serialized JSON");
    }
    const payload = JSON.parse(requestBody) as Record<string, unknown>;
    expect(payload.systemInstruction).toEqual({
      parts: [{ text: "Follow policy." }],
    });
    expect(payload.cachedContent).toBe("cachedContents/request-cache");
    expect(payload.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    });
    expect(payload.toolConfig).toMatchObject({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(result).toMatchObject({
      api: "google-generative-ai",
      provider: "google",
      responseId: "resp_1",
      stopReason: "toolUse",
      usage: {
        input: 8,
        output: 8,
        cacheRead: 2,
        totalTokens: 18,
      },
      content: [
        { type: "thinking", thinking: "draft", thinkingSignature: "sig_1" },
        { type: "text", text: "answer" },
        {
          type: "toolCall",
          name: "lookup",
          arguments: { q: "hello" },
          thoughtSignature: "call_sig_1",
        },
      ],
    });
  });

  it("uses bearer auth when the Google api key is an OAuth JSON payload", async () => {
    guardedFetchMock.mockResolvedValueOnce(buildSseResponse([]));

    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        api: "google-generative-ai",
        provider: "custom-google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      } satisfies Model<"google-generative-ai">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: JSON.stringify({ token: "oauth-token", projectId: "demo" }),
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(guardedFetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("coerces replayed malformed tool-call args to an object for Google payloads", () => {
    const params = buildGoogleGenerativeAiParams(buildGeminiModel(), {
      messages: [
        {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4",
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: "{not valid json",
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toMatchObject({
      role: "model",
      parts: [{ functionCall: { name: "lookup", args: {} } }],
    });
  });

  it("replays Gemini tool call thought signatures for same-model history", () => {
    const model = buildGeminiModel({
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
    });

    const params = buildGoogleGenerativeAiParams(model, {
      messages: [
        {
          role: "assistant",
          provider: "google",
          api: "google-generative-ai",
          model: "gemini-3-flash-preview",
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: { q: "hello" },
              thoughtSignature: "call_sig_1",
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toMatchObject({
      role: "model",
      parts: [
        {
          thoughtSignature: "call_sig_1",
          functionCall: { name: "lookup", args: { q: "hello" } },
        },
      ],
    });
  });

  it("builds direct Gemini payloads without negative fallback thinking budgets", () => {
    const model = {
      id: "custom-gemini-model",
      name: "Custom Gemini",
      api: "google-generative-ai",
      provider: "custom-google",
      baseUrl: "https://proxy.example.com/gemini/v1beta",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } satisfies Model<"google-generative-ai">;

    const params = buildGoogleGenerativeAiParams(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        reasoning: "medium",
      },
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingBudget: -1 },
    });
  });

  it("omits disabled thinkingBudget=0 for Gemini 2.5 Pro direct payloads", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        maxTokens: 128,
      } as never,
    );

    expect(params.generationConfig).toMatchObject({
      maxOutputTokens: 128,
    });
    expect(params.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("strips explicit thinkingBudget=0 but preserves includeThoughts for Gemini 2.5 Pro", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        thinking: {
          enabled: true,
          budgetTokens: 0,
        },
      } as never,
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it.each([
    ["gemini-pro-latest", "LOW"],
    ["gemini-flash-latest", "MINIMAL"],
    ["gemini-flash-lite-latest", "MINIMAL"],
  ] as const)(
    "uses thinkingLevel instead of disabled thinkingBudget for %s defaults",
    (id, level) => {
      const params = buildGoogleGenerativeAiParams(
        buildGeminiModel({ id }),
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as never,
        {
          maxTokens: 128,
        } as never,
      );

      expect(params.generationConfig).toMatchObject({
        maxOutputTokens: 128,
        thinkingConfig: { thinkingLevel: level },
      });
      expect(params.generationConfig).not.toMatchObject({
        thinkingConfig: { thinkingBudget: 0 },
      });
    },
  );

  it("maps explicit Gemini 3 thinking budgets to thinkingLevel", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3-flash-preview" }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        thinking: {
          enabled: true,
          budgetTokens: 8192,
        },
      } as never,
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingBudget: 8192 },
    });
  });

  it("keeps adaptive Gemini 3 thinking on provider dynamic defaults", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3-flash-preview" }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        reasoning: "adaptive",
      } as never,
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingLevel: expect.any(String) },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingBudget: expect.any(Number) },
    });
  });

  it("maps adaptive Gemini 2.5 thinking to dynamic thinkingBudget", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-2.5-flash" }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        reasoning: "adaptive",
      } as never,
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
    });
  });

  it("normalizes explicit Gemini 3 Pro thinking levels", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3.1-pro-preview" }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        thinking: {
          enabled: true,
          level: "MINIMAL",
        },
      } as never,
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
    });
  });

  it("includes cachedContent in direct Gemini payloads when requested", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        cachedContent: "cachedContents/prebuilt-context",
      },
    );

    expect(params.cachedContent).toBe("cachedContents/prebuilt-context");
  });
});
