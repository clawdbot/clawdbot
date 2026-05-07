import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let createGoogleVertexTransportStreamFn: typeof import("./transport-stream.js").createGoogleVertexTransportStreamFn;
let hasGoogleVertexAuthorizedUserAdcSync: typeof import("./vertex-adc.js").hasGoogleVertexAuthorizedUserAdcSync;
let resetGoogleVertexAuthorizedUserTokenCacheForTest: typeof import("./vertex-adc.js").resetGoogleVertexAuthorizedUserTokenCacheForTest;

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

function buildGoogleVertexModel(
  overrides: Partial<Model<"google-vertex">> = {},
): Model<"google-vertex"> {
  return {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
    ({
      buildGoogleGenerativeAiParams,
      createGoogleGenerativeAiTransportStreamFn,
      createGoogleVertexTransportStreamFn,
    } = await import("./transport-stream.js"));
    ({ hasGoogleVertexAuthorizedUserAdcSync, resetGoogleVertexAuthorizedUserTokenCacheForTest } =
      await import("./vertex-adc.js"));
  });

  beforeEach(() => {
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    resetGoogleVertexAuthorizedUserTokenCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/provider-transport-runtime");
    vi.resetModules();
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

  it("refreshes authorized_user ADC before Google Vertex requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-adc-"));
    const credentialsPath = path.join(tempDir, "application_default_credentials.json");
    await writeFile(
      credentialsPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      }),
      "utf8",
    );
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
    const tokenFetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ya29.vertex-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        },
      ]),
    );

    expect(hasGoogleVertexAuthorizedUserAdcSync()).toBe(true);

    const model = buildGoogleVertexModel();

    const streamFn = createGoogleVertexTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "gcp-vertex-credentials",
          fetch: tokenFetchMock,
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(tokenFetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ya29.vertex-token",
          "Content-Type": "application/json",
          accept: "text/event-stream",
        }),
      }),
    );
    expect(result).toMatchObject({
      api: "google-vertex",
      provider: "google-vertex",
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("refreshes authorized_user ADC from the Windows APPDATA fallback for Google Vertex requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-appdata-adc-"));
    const homeDir = path.join(tempDir, "home");
    const appDataDir = path.join(tempDir, "AppData", "Roaming");
    const fallbackDir = path.join(appDataDir, "gcloud");
    const credentialsPath = path.join(fallbackDir, "application_default_credentials.json");
    await mkdir(fallbackDir, { recursive: true });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "appdata-refresh-token",
      }),
      "utf8",
    );
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("APPDATA", appDataDir);
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
    const tokenFetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ya29.appdata-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        },
      ]),
    );

    expect(hasGoogleVertexAuthorizedUserAdcSync()).toBe(true);

    const streamFn = createGoogleVertexTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        buildGoogleVertexModel(),
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "gcp-vertex-credentials",
          fetch: tokenFetchMock,
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(tokenFetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        body: expect.objectContaining({
          get: expect.any(Function),
        }),
        method: "POST",
      }),
    );
    const requestBody = tokenFetchMock.mock.calls[0]?.[1]?.body as URLSearchParams | undefined;
    expect(requestBody?.get("refresh_token")).toBe("appdata-refresh-token");
    expect(guardedFetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ya29.appdata-token",
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

  it("uses Gemini skip-validator thought signatures for cross-provider tool-call replay", () => {
    const model = buildGeminiModel({
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
    });

    const params = buildGoogleGenerativeAiParams(model, {
      messages: [
        {
          role: "assistant",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-opus-4-7",
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: { q: "hello" },
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toMatchObject({
      role: "model",
      parts: [
        {
          thoughtSignature: "skip_thought_signature_validator",
          functionCall: { name: "lookup", args: { q: "hello" } },
        },
      ],
    });
  });

  it("does not trust cross-provider tool-call thought signatures for non-Gemini-3 models", () => {
    const model = buildGeminiModel({
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
    });

    const params = buildGoogleGenerativeAiParams(model, {
      messages: [
        {
          role: "assistant",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-opus-4-7",
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: { q: "hello" },
              thoughtSignature: "foreign_sig",
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toMatchObject({
      role: "model",
      parts: [{ functionCall: { name: "lookup", args: { q: "hello" } } }],
    });
    expect(JSON.stringify(params.contents)).not.toContain("foreign_sig");
    expect(JSON.stringify(params.contents)).not.toContain("skip_thought_signature_validator");
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

  it("uses a non-empty text placeholder for empty user text", () => {
    const params = buildGoogleGenerativeAiParams(buildGeminiModel(), {
      messages: [
        { role: "user", content: "", timestamp: 0 },
        {
          role: "user",
          content: [{ type: "text", text: "" }],
          timestamp: 1,
        },
      ],
    } as never);

    expect(params.contents).toEqual([
      { role: "user", parts: [{ text: " " }] },
      { role: "user", parts: [{ text: " " }] },
    ]);
  });

  it("uses a text placeholder when user parts are filtered out for text-only models", () => {
    const params = buildGoogleGenerativeAiParams(buildGeminiModel({ input: ["text"] }), {
      messages: [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "png-bytes" }],
          timestamp: 0,
        },
      ],
    } as never);

    expect(params.contents).toEqual([{ role: "user", parts: [{ text: " " }] }]);
  });

  it("uses a user placeholder when converted Gemini contents would otherwise be empty", () => {
    const params = buildGoogleGenerativeAiParams(buildGeminiModel(), {
      messages: [
        {
          role: "assistant",
          provider: "google",
          api: "google-generative-ai",
          model: "gemini-2.5-pro",
          stopReason: "stop",
          timestamp: 0,
          content: [{ type: "text", text: "   " }],
        },
      ],
    } as never);

    expect(params.contents).toEqual([{ role: "user", parts: [{ text: " " }] }]);
  });

  it.each([
    ["gemini-2.5-flash-lite", "minimal", 512],
    ["gemini-2.5-flash-lite", "low", 2048],
    ["gemini-2.5-flash", "minimal", 128],
    ["gemini-2.5-flash", "low", 2048],
    ["gemini-2.5-pro", "minimal", 128],
    ["gemini-2.5-pro", "low", 2048],
    ["gemini-2.5-flash", "medium", 8192],
    ["gemini-2.5-pro", "medium", 8192],
  ] as const)("%s with reasoning=%s uses thinkingBudget %i", (id, reasoning, expectedBudget) => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      { reasoning },
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingBudget: expectedBudget },
    });
  });

  it("emits thinking activity for thoughtSignature-only parts to keep the stream active", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "draft", thoughtSignature: "sig_1" },
                  { thoughtSignature: "sig_2" },
                  { text: "answer" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
          },
        },
      ]),
    );

    const model = buildGeminiModel({
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
    });

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          systemPrompt: "You are a helpful assistant.",
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as never,
        { reasoning: "high" },
      ),
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    expect(result.content).toEqual([
      { type: "thinking", thinking: "draft", thinkingSignature: "sig_2" },
      { type: "text", text: "answer" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events[3]).toMatchObject({ type: "thinking_delta", delta: "" });
  });

  it("starts a thinking block for thoughtSignature-only parts that arrive before any text", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { thoughtSignature: "sig_1" },
                  { thought: true, text: "draft" },
                  { text: "answer" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
          },
        },
      ]),
    );

    const model = buildGeminiModel({
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
    });

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          systemPrompt: "You are a helpful assistant.",
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as never,
        { reasoning: "high" },
      ),
    );
    const result = await stream.result();

    expect(result.content).toEqual([
      { type: "thinking", thinking: "draft", thinkingSignature: "sig_1" },
      { type: "text", text: "answer" },
    ]);
  });
});
