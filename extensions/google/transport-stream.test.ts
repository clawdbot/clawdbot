import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
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
let buildGoogleGemini3FirstResponseRetryParams: typeof import("./transport-stream.js").buildGoogleGemini3FirstResponseRetryParams;
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

function buildDelayedSecondSseResponse(params: {
  first: unknown;
  second: unknown;
  delayMs: number;
}): Response {
  const encoder = new TextEncoder();
  const first = `data: ${JSON.stringify(params.first)}\n\n`;
  const second = `data: ${JSON.stringify(params.second)}\n\ndata: [DONE]\n\n`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      timeout = setTimeout(() => {
        controller.enqueue(encoder.encode(second));
        controller.close();
      }, params.delayMs);
    },
    cancel() {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function requireMockCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  index: number,
  label: string,
): TArgs {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label} mock call ${index}`);
  }
  return call;
}

function requireRequestInit(call: unknown[], label: string): RequestInit {
  const init = call[1];
  if (!init || typeof init !== "object") {
    throw new Error(`Expected ${label} request init`);
  }
  return init as RequestInit;
}

function expectHeaders(init: RequestInit, expected: Record<string, string>): void {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(expected)) {
    expect(headers.get(key)).toBe(value);
  }
}

function parseRequestJsonBody(init: RequestInit): Record<string, unknown> {
  const requestBody = init.body;
  if (typeof requestBody !== "string") {
    throw new Error("Expected request body to be serialized JSON");
  }
  return JSON.parse(requestBody) as Record<string, unknown>;
}

function requireGenerationConfig(params: { generationConfig?: unknown }): Record<string, unknown> {
  const config = params.generationConfig;
  if (!config || typeof config !== "object") {
    throw new Error("Expected generationConfig");
  }
  return config as Record<string, unknown>;
}

function requireThinkingConfig(config: Record<string, unknown>): Record<string, unknown> {
  const thinkingConfig = config.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object") {
    throw new Error("Expected thinkingConfig");
  }
  return thinkingConfig as Record<string, unknown>;
}

describe("google transport stream", () => {
  beforeAll(async () => {
    ({
      buildGoogleGenerativeAiParams,
      buildGoogleGemini3FirstResponseRetryParams,
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
    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(guardedCall[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
    );
    const init = requireRequestInit(guardedCall, "guarded fetch");
    expect(init.method).toBe("POST");
    expectHeaders(init, {
      accept: "text/event-stream",
      "Content-Type": "application/json",
      "x-goog-api-key": "gemini-api-key",
      "X-Provider": "google",
    });

    const payload = parseRequestJsonBody(init);
    expect(payload.systemInstruction).toEqual({
      parts: [{ text: "Follow policy." }],
    });
    expect(payload.cachedContent).toBe("cachedContents/request-cache");
    expect((payload.generationConfig as { thinkingConfig?: unknown }).thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(
      (payload.toolConfig as { functionCallingConfig?: unknown }).functionCallingConfig,
    ).toEqual({
      mode: "AUTO",
    });
    expect(result.api).toBe("google-generative-ai");
    expect(result.provider).toBe("google");
    expect(result.responseId).toBe("resp_1");
    expect(result.stopReason).toBe("toolUse");
    expect(result.usage.input).toBe(8);
    expect(result.usage.output).toBe(8);
    expect(result.usage.cacheRead).toBe(2);
    expect(result.usage.totalTokens).toBe(18);
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "draft",
      thinkingSignature: "sig_1",
    });
    expect(result.content[1]?.type).toBe("text");
    expect(result.content[1]).toHaveProperty("text", "answer");
    expect(result.content[2]?.type).toBe("toolCall");
    expect(result.content[2]).toHaveProperty("name", "lookup");
    expect(result.content[2]).toHaveProperty("arguments", { q: "hello" });
    expect(result.content[2]).toHaveProperty("thoughtSignature", "call_sig_1");
  });

  it("builds a lean Gemini 3 first-response retry payload", () => {
    const model = buildGeminiModel({
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
    });
    const retryPayload = buildGoogleGemini3FirstResponseRetryParams({
      model,
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "HIGH",
          },
        },
      },
    });

    expect(retryPayload?.generationConfig).toEqual({
      thinkingConfig: {
        thinkingLevel: "LOW",
      },
    });
  });

  it("retries Gemini 3 requests with lean thinking when the first attempt has no first response", async () => {
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    guardedFetchMock
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          }),
      )
      .mockResolvedValueOnce(
        buildSseResponse([
          {
            candidates: [{ content: { parts: [{ text: "recovered" }] }, finishReason: "STOP" }],
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
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: {
                type: "object",
                properties: { q: { type: "string" } },
              },
            },
          ],
        } as never,
        { reasoning: "high" } as never,
      ),
    );
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(guardedFetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(guardedFetchMock.mock.calls[0]?.[1]?.body as string);
    const retryBody = JSON.parse(guardedFetchMock.mock.calls[1]?.[1]?.body as string);
    expect(firstBody.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(retryBody.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "LOW",
    });
    expect(retryBody.tools).toEqual(firstBody.tools);
  });

  it("keeps streaming after the first Gemini 3 chunk arrives before the retry deadline", async () => {
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    guardedFetchMock.mockResolvedValueOnce(
      buildDelayedSecondSseResponse({
        first: {
          candidates: [{ content: { parts: [{ text: "first " }] } }],
        },
        second: {
          candidates: [{ content: { parts: [{ text: "second" }] }, finishReason: "STOP" }],
        },
        delayMs: 25,
      }),
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
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as never,
        { reasoning: "high" } as never,
      ),
    );
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "text", text: "first second" }]);
    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
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

    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(typeof guardedCall[0]).toBe("string");
    const init = requireRequestInit(guardedCall, "guarded fetch");
    expectHeaders(init, {
      Authorization: "Bearer oauth-token",
      "Content-Type": "application/json",
    });
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

    const tokenCall = requireMockCall(tokenFetchMock, 0, "token fetch");
    expect(tokenCall[0]).toBe("https://oauth2.googleapis.com/token");
    expect(requireRequestInit(tokenCall, "token fetch").method).toBe("POST");

    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(guardedCall[0]).toBe(
      "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
    );
    const guardedInit = requireRequestInit(guardedCall, "guarded fetch");
    expect(guardedInit.method).toBe("POST");
    expectHeaders(guardedInit, {
      Authorization: "Bearer ya29.vertex-token",
      "Content-Type": "application/json",
      accept: "text/event-stream",
    });
    expect(result.api).toBe("google-vertex");
    expect(result.provider).toBe("google-vertex");
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
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

    const tokenCall = requireMockCall(tokenFetchMock, 0, "token fetch");
    expect(tokenCall[0]).toBe("https://oauth2.googleapis.com/token");
    const tokenInit = requireRequestInit(tokenCall, "token fetch");
    expect(tokenInit.method).toBe("POST");
    expect(tokenInit.body).toBeInstanceOf(URLSearchParams);
    const requestBody = tokenInit.body as URLSearchParams;
    expect(requestBody?.get("refresh_token")).toBe("appdata-refresh-token");
    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(typeof guardedCall[0]).toBe("string");
    expectHeaders(requireRequestInit(guardedCall, "guarded fetch"), {
      Authorization: "Bearer ya29.appdata-token",
    });
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

    expect(params.contents[0]).toEqual({
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

    expect(params.contents[0]).toEqual({
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

    expect(params.contents[0]).toEqual({
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

    expect(params.contents[0]).toEqual({
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

    const generationConfig = requireGenerationConfig(params);
    const thinkingConfig = requireThinkingConfig(generationConfig);
    expect(thinkingConfig.includeThoughts).toBe(true);
    expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
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

    const generationConfig = requireGenerationConfig(params);
    expect(generationConfig.maxOutputTokens).toBe(128);
    expect(generationConfig).not.toHaveProperty("thinkingConfig");
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

    const generationConfig = requireGenerationConfig(params);
    const thinkingConfig = requireThinkingConfig(generationConfig);
    expect(thinkingConfig.includeThoughts).toBe(true);
    expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
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

      const generationConfig = requireGenerationConfig(params);
      const thinkingConfig = requireThinkingConfig(generationConfig);
      expect(generationConfig.maxOutputTokens).toBe(128);
      expect(thinkingConfig.thinkingLevel).toBe(level);
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
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

    const generationConfig = requireGenerationConfig(params);
    const thinkingConfig = requireThinkingConfig(generationConfig);
    expect(thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
    expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
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

    const generationConfig = requireGenerationConfig(params);
    const thinkingConfig = requireThinkingConfig(generationConfig);
    expect(thinkingConfig.includeThoughts).toBe(true);
    expect(thinkingConfig).not.toHaveProperty("thinkingLevel");
    expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
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

    const generationConfig = requireGenerationConfig(params);
    expect(requireThinkingConfig(generationConfig)).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
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

    const generationConfig = requireGenerationConfig(params);
    expect(requireThinkingConfig(generationConfig)).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
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

    const generationConfig = requireGenerationConfig(params);
    expect(requireThinkingConfig(generationConfig)).toEqual({
      includeThoughts: true,
      thinkingBudget: expectedBudget,
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
    expect(events[3]?.type).toBe("thinking_delta");
    expect(events[3]).toHaveProperty("delta", "");
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
