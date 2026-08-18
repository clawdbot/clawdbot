// Google tests cover transport stream plugin behavior.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { Model, ProviderContext } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGoogleVertexAdcState } from "./google-oauth.test-support.js";

const {
  buildGuardedModelFetchMock,
  guardedFetchMock,
  googleAuthGetAccessTokenMock,
  googleAuthMock,
} = vi.hoisted(() => {
  const googleAuthGetAccessTokenMockLocal = vi.fn();
  return {
    buildGuardedModelFetchMock: vi.fn(),
    guardedFetchMock: vi.fn(),
    googleAuthGetAccessTokenMock: googleAuthGetAccessTokenMockLocal,
    googleAuthMock: vi.fn(function GoogleAuthMock() {
      return {
        getAccessToken: googleAuthGetAccessTokenMockLocal,
      };
    }),
  };
});

vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: googleAuthMock,
}));

let buildGoogleGenerativeAiParams: typeof import("./transport-stream.js").buildGoogleGenerativeAiParams;
let createGoogleGenerativeAiTransportStreamFn: typeof import("./transport-stream.js").createGoogleGenerativeAiTransportStreamFn;
let createGoogleVertexTransportStreamFn: typeof import("./transport-stream.js").createGoogleVertexTransportStreamFn;
let resolveGoogleVertexAuthorizedUserHeaders: typeof import("./vertex-adc.js").resolveGoogleVertexAuthorizedUserHeaders;

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

function buildGeminiUserParams(
  model: Partial<Model<"google-generative-ai">> = {},
  options?: Record<string, unknown>,
) {
  return buildGoogleGenerativeAiParams(
    buildGeminiModel(model),
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as never,
    options as never,
  );
}

function buildGeminiReplayParams(messages: Record<string, unknown>[]) {
  return buildGoogleGenerativeAiParams(
    buildGeminiModel({
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
    }),
    { messages } as never,
  );
}

async function runGeminiStreamResult(
  params: {
    model?: Model<"google-generative-ai">;
    context?: Parameters<ReturnType<typeof createGoogleGenerativeAiTransportStreamFn>>[1];
    options?: Record<string, unknown>;
  } = {},
) {
  const streamFn = createGoogleGenerativeAiTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(
      params.model ?? buildGeminiModel(),
      (params.context ?? {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      }) as Parameters<typeof streamFn>[1],
      params.options as Parameters<typeof streamFn>[2],
    ),
  );
  return stream.result();
}

function withProviderContextHandoff(
  options: Record<string, unknown>,
  handoff: () => Promise<ProviderContext>,
): Record<string, unknown> {
  return new Proxy(options, {
    get: (target, property, receiver) =>
      typeof property === "symbol" ? handoff : Reflect.get(target, property, receiver),
  });
}

async function runGoogleVertexStreamResult(params: {
  model?: Model<"google-vertex">;
  fetch: typeof guardedFetchMock;
}) {
  const streamFn = createGoogleVertexTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(
      params.model ?? buildGoogleVertexModel(),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as Parameters<
        typeof streamFn
      >[1],
      { apiKey: "gcp-vertex-credentials", fetch: params.fetch } as Parameters<typeof streamFn>[2],
    ),
  );
  return stream.result();
}

async function useGoogleAuthorizedUserCredentials(
  label: string,
  refreshToken: string,
  quotaProjectId?: string,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-google-vertex-${label}-`));
  const credentialsPath = path.join(tempDir, "application_default_credentials.json");
  await writeFile(
    credentialsPath,
    JSON.stringify({
      type: "authorized_user",
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: refreshToken,
      ...(quotaProjectId ? { quota_project_id: quotaProjectId } : {}),
    }),
    "utf8",
  );
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
  return credentialsPath;
}

async function useGoogleAuthLibraryCredentials(label: string, token?: string): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-google-vertex-${label}-`));
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
  vi.stubEnv("HOME", path.join(tempDir, "home"));
  vi.stubEnv("APPDATA", "");
  if (token !== undefined) {
    googleAuthGetAccessTokenMock.mockResolvedValueOnce(token);
  }
}

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return buildRawSseResponse(sse);
}

function mockGoogleTextResponse(text = "ok"): void {
  guardedFetchMock.mockResolvedValueOnce(
    buildSseResponse([{ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }]),
  );
}

function buildRateLimitResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "quota exceeded", status: "RESOURCE_EXHAUSTED" },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function buildRawSseResponse(sse: string): Response {
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

function buildOpenRawSseResponse(params: { sse: string; onCancel: () => void }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(params.sse));
    },
    cancel() {
      params.onCancel();
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

type GoogleTestContentTurn = Record<string, unknown> & {
  parts: Array<Record<string, unknown>>;
};

function isModelTurnWithParts(content: Record<string, unknown>): content is GoogleTestContentTurn {
  return content.role === "model" && Array.isArray(content.parts);
}

function getFirstModelTurn(contents: Array<Record<string, unknown>>): GoogleTestContentTurn {
  const turn = contents.find(isModelTurnWithParts);
  if (!turn) {
    throw new Error("Expected at least one Google model turn");
  }
  return turn;
}

function getLastModelTurn(contents: Array<Record<string, unknown>>): GoogleTestContentTurn {
  const turn = contents.toReversed().find(isModelTurnWithParts);
  if (!turn) {
    throw new Error("Expected at least one Google model turn");
  }
  return turn;
}

function googleToolCallAssistantTurn({
  timestamp = 0,
  provider = "google",
  api = "google-generative-ai",
  model = "gemini-3.1-pro-preview",
  id = "call_1",
  name = "lookup",
  args = { q: "hello" },
  thoughtSignature,
}: {
  timestamp?: number;
  provider?: string;
  api?: string;
  model?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  thoughtSignature?: string;
} = {}): Record<string, unknown> {
  return {
    role: "assistant",
    provider,
    api,
    model,
    stopReason: "toolUse",
    timestamp,
    content: [
      {
        type: "toolCall",
        id,
        name,
        arguments: args,
        ...(thoughtSignature ? { thoughtSignature } : {}),
      },
    ],
  };
}

function toolResultTurn(toolCallId = "call_1", timestamp = 1): Record<string, unknown> {
  return {
    role: "toolResult",
    timestamp,
    content: [
      {
        type: "toolResult",
        toolCallId,
        content: [{ type: "text", text: "ok" }],
      },
    ],
  };
}

function parallelGoogleToolCallAssistantTurn(): Record<string, unknown> {
  return {
    role: "assistant",
    provider: "google",
    api: "google-generative-ai",
    model: "gemini-2.5-flash",
    stopReason: "toolUse",
    timestamp: 0,
    content: [
      { type: "toolCall", id: "call_1", name: "screenshot", arguments: {} },
      { type: "toolCall", id: "call_2", name: "weather", arguments: {} },
    ],
  };
}

function googleToolResultMessage(name: "screenshot" | "weather"): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId: name === "screenshot" ? "call_1" : "call_2",
    toolName: name,
    content:
      name === "screenshot"
        ? [{ type: "image", mimeType: "image/png", data: "png-bytes" }]
        : [{ type: "text", text: "Sunny, 21C" }],
    isError: false,
    timestamp: 1,
  };
}

function buildGoogleToolResultParams(
  content: Array<Record<string, unknown>>,
  options: {
    model?: Partial<Model<"google-generative-ai">>;
    toolName?: string;
  } = {},
) {
  return buildGoogleGenerativeAiParams(buildGeminiModel(options.model), {
    messages: [
      googleToolCallAssistantTurn(),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: options.toolName ?? "lookup",
        content,
        isError: false,
        timestamp: 1,
      },
    ],
  } as never);
}

describe("google transport stream", () => {
  beforeAll(async () => {
    ({
      buildGoogleGenerativeAiParams,
      createGoogleGenerativeAiTransportStreamFn,
      createGoogleVertexTransportStreamFn,
    } = await import("./transport-stream.js"));
    ({ resolveGoogleVertexAuthorizedUserHeaders } = await import("./vertex-adc.js"));
  });

  beforeEach(() => {
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    googleAuthGetAccessTokenMock.mockReset();
    googleAuthMock.mockClear();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    resetGoogleVertexAdcState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/provider-transport-runtime");
    vi.doUnmock("google-auth-library");
    vi.resetModules();
  });

  it("resolves qualified AI Studio video after payload hooks and preserves part order", async () => {
    mockGoogleTextResponse();
    const videoData = "current-video-base64";
    const quicktimeData = "current-quicktime-base64";
    const imageData = "current-image-base64";
    const providerContext: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", mimeType: "image/png", data: imageData },
            { type: "video", mimeType: "video/mp4", data: videoData },
            { type: "video", mimeType: "video/quicktime", data: quicktimeData },
            { type: "text", text: "after" },
          ],
          timestamp: 0,
        },
      ],
    };
    const handoff = vi.fn(async () => providerContext);
    const onPayload = vi.fn((payload: unknown) => {
      expect(JSON.stringify(payload)).not.toContain(videoData);
      expect(JSON.stringify(payload)).not.toContain(quicktimeData);
      expect(JSON.stringify(payload)).toContain("native video slot unavailable");
      return payload;
    });

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({ input: ["text", "image", "video"] as never }),
      context: { messages: [{ role: "user", content: "fallback", timestamp: 0 }] },
      options: withProviderContextHandoff({ onPayload }, handoff),
    });
    expect(result.errorMessage).toBeUndefined();

    const body = parseRequestJsonBody(
      requireRequestInit(requireMockCall(guardedFetchMock, 0, "guarded fetch"), "guarded fetch"),
    ) as { contents: GoogleTestContentTurn[] };
    expect(body.contents[0]?.parts).toEqual([
      { text: "before" },
      { inlineData: { mimeType: "image/png", data: imageData } },
      { inlineData: { mimeType: "video/mp4", data: videoData } },
      { inlineData: { mimeType: "video/quicktime", data: quicktimeData } },
      { text: "after" },
    ]);
    expect(handoff).toHaveBeenCalledOnce();
    expect(onPayload).toHaveBeenCalledOnce();
  });

  it("omits cloned and hook-injected video slots", async () => {
    mockGoogleTextResponse();
    const trustedData = "trusted-video-base64";
    const injectedData = "injected-video-base64";
    const providerContext: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [{ type: "video", mimeType: "video/mp4", data: trustedData }],
          timestamp: 0,
        },
      ],
    };
    await runGeminiStreamResult({
      model: buildGeminiModel({ input: ["text", "image", "video"] as never }),
      options: withProviderContextHandoff(
        {
          onPayload: (payload: unknown) => {
            const cloned = structuredClone(payload) as {
              contents: GoogleTestContentTurn[];
            };
            cloned.contents[0]?.parts.push({
              inlineData: { mimeType: "video/mp4", data: injectedData },
            });
            return cloned;
          },
        },
        async () => providerContext,
      ),
    });
    const bodyText = requireRequestInit(
      requireMockCall(guardedFetchMock, 0, "guarded fetch"),
      "guarded fetch",
    ).body as string;
    expect(bodyText).not.toContain(trustedData);
    expect(bodyText).not.toContain(injectedData);
    expect(bodyText).toContain("native video slot unavailable");
  });

  it("rejects unsupported Google video MIME after the payload hook", async () => {
    mockGoogleTextResponse();
    const videoData = "unsupported-mime-video";
    const onPayload = vi.fn((payload: unknown) => {
      expect(JSON.stringify(payload)).not.toContain(videoData);
      return payload;
    });
    await runGeminiStreamResult({
      model: buildGeminiModel({ input: ["text", "image", "video"] as never }),
      options: withProviderContextHandoff({ onPayload }, async () => ({
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/x-msvideo", data: videoData }],
            timestamp: 0,
          },
        ],
      })),
    });
    const body = requireRequestInit(
      requireMockCall(guardedFetchMock, 0, "guarded fetch"),
      "guarded fetch",
    ).body as string;
    expect(body).not.toContain(videoData);
    expect(body).toContain("unsupported Google video MIME type");
  });

  it("evicts trusted video until the exact serialized request is below 20MB", async () => {
    mockGoogleTextResponse();
    const providerContext: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [{ type: "video", mimeType: "video/mp4", data: "A".repeat(20_000_000) }],
          timestamp: 0,
        },
      ],
    };
    await runGeminiStreamResult({
      model: buildGeminiModel({ input: ["text", "image", "video"] as never }),
      options: withProviderContextHandoff({}, async () => providerContext),
    });
    const body = requireRequestInit(
      requireMockCall(guardedFetchMock, 0, "guarded fetch"),
      "guarded fetch",
    ).body as string;
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(20_000_000);
    expect(body).toContain("native video slot unavailable");
  });

  it("returns a useful provider error when the non-video request still exceeds 20MB", async () => {
    const result = await runGeminiStreamResult({
      context: {
        messages: [{ role: "user", content: "A".repeat(20_000_000), timestamp: 0 }],
      },
    });
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Google request body must be smaller than 20000000 bytes",
    });
    expect(guardedFetchMock).not.toHaveBeenCalled();
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
                  { thought: true, text: "draft", thoughtSignature: "c2lnXzE=" },
                  { text: "answer" },
                  {
                    thoughtSignature: "Y2FsbF9zaWdfMQ==",
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
      buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        baseUrl: "https://generativelanguage.googleapis.com",
        headers: { "X-Provider": "google" },
      }),
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
    expect(new Headers(init.headers).get("x-goog-api-client")).toMatch(/^openclaw\//u);

    const payload = parseRequestJsonBody(init);
    expect(payload.cachedContent).toBe("cachedContents/request-cache");
    expect(payload.systemInstruction).toBeUndefined();
    expect(payload.tools).toBeUndefined();
    expect(payload.toolConfig).toBeUndefined();
    expect((payload.generationConfig as { thinkingConfig?: unknown }).thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
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
      thinkingSignature: "c2lnXzE=",
    });
    expect(result.content[1]?.type).toBe("text");
    expect(result.content[1]).toHaveProperty("text", "answer");
    expect(result.content[2]?.type).toBe("toolCall");
    expect(result.content[2]).toHaveProperty("name", "lookup");
    expect(result.content[2]).toHaveProperty("arguments", { q: "hello" });
    expect(result.content[2]).toHaveProperty("thoughtSignature", "Y2FsbF9zaWdfMQ==");
  });

  it.each([
    {
      name: "includes billed tool-result prompt tokens in input accounting",
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
        toolUsePromptTokenCount: 5,
        totalTokenCount: 19,
      },
      expectedInput: 13,
      expectedTotal: 19,
    },
    {
      name: "derives the total when Google omits its optional aggregate",
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
      },
      expectedInput: 8,
      expectedTotal: 14,
    },
  ])("$name", async ({ usageMetadata, expectedInput, expectedTotal }) => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([{ candidates: [{ finishReason: "STOP" }], usageMetadata }]),
    );

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({
        cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
      }),
      options: { apiKey: "gemini-api-key" },
    });

    expect(result.usage).toMatchObject({
      input: expectedInput,
      output: 4,
      cacheRead: 2,
      totalTokens: expectedTotal,
      cost: { input: expectedInput / 1_000_000 },
    });
  });

  it("retains prompt, cache, and tool-token facts across sparse Google usage chunks", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 40,
            toolUsePromptTokenCount: 6,
            candidatesTokenCount: 1,
            totalTokenCount: 107,
          },
        },
        {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { candidatesTokenCount: 12, thoughtsTokenCount: 3 },
        },
      ]),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.usage).toMatchObject({ input: 66, output: 15, cacheRead: 40, totalTokens: 121 });
  });

  it.each([
    {
      provider: "google",
      feedback: { blockReason: "SAFETY" },
      expectedCode: "SAFETY",
      expectedMessage: "Google prompt blocked (SAFETY)",
    },
    {
      provider: "google",
      feedback: {},
      expectedCode: "PROMPT_BLOCKED",
      expectedMessage: "Google prompt blocked (PROMPT_BLOCKED)",
    },
    {
      provider: "google-vertex",
      feedback: {
        blockReason: "PROHIBITED_CONTENT",
        blockReasonMessage: "Prompt violates provider safety policy",
      },
      expectedCode: "PROHIBITED_CONTENT",
      expectedMessage:
        "Google prompt blocked (PROHIBITED_CONTENT): Prompt violates provider safety policy",
    },
    {
      provider: "google-vertex",
      feedback: { blockReasonMessage: "Prompt violates provider safety policy" },
      expectedCode: "PROMPT_BLOCKED",
      expectedMessage:
        "Google prompt blocked (PROMPT_BLOCKED): Prompt violates provider safety policy",
    },
  ])(
    "surfaces blocked $provider prompts as typed stream errors",
    async ({ provider, feedback, expectedCode, expectedMessage }) => {
      guardedFetchMock.mockResolvedValueOnce(buildSseResponse([{ promptFeedback: feedback }]));
      if (provider === "google-vertex") {
        vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
        vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
        googleAuthGetAccessTokenMock.mockResolvedValueOnce("ya29.vertex-token");
      }

      const result =
        provider === "google-vertex"
          ? await runGoogleVertexStreamResult({ fetch: guardedFetchMock })
          : await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

      expect(result).toMatchObject({
        stopReason: "error",
        errorCode: expectedCode,
        errorType: "google_prompt_blocked",
        errorMessage: expectedMessage,
        content: [],
      });
    },
  );

  it.each(["google", "google-vertex"] as const)(
    "rejects an unfinished %s stream instead of silently completing partial output",
    async (provider) => {
      guardedFetchMock.mockResolvedValueOnce(
        buildSseResponse([{ candidates: [{ content: { parts: [{ text: "partial output" }] } }] }]),
      );
      if (provider === "google-vertex") {
        vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
        vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
        googleAuthGetAccessTokenMock.mockResolvedValueOnce("ya29.vertex-token");
      }

      const result =
        provider === "google-vertex"
          ? await runGoogleVertexStreamResult({ fetch: guardedFetchMock })
          : await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

      expect(result).toMatchObject({
        stopReason: "error",
        errorCode: "STREAM_INCOMPLETE",
        errorType: "google_incomplete_stream",
        errorMessage: "Google stream ended before a terminal finish reason",
      });
    },
  );

  it.each(["SAFETY", "MALFORMED_FUNCTION_CALL"] as const)(
    "preserves the actionable %s candidate finish message",
    async (finishReason) => {
      guardedFetchMock.mockResolvedValueOnce(
        buildSseResponse([
          {
            candidates: [
              {
                finishReason,
                finishMessage: "Provider rejected the generated response",
              },
            ],
          },
        ]),
      );

      const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

      expect(result).toMatchObject({
        stopReason: "error",
        errorCode: finishReason,
        errorType: "google_generation_failed",
        errorMessage: `Google generation stopped (${finishReason}): Provider rejected the generated response`,
      });
    },
  );

  it("closes partial text before reporting a failed candidate", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: "partial output" }] },
              finishReason: "SAFETY",
              finishMessage: "Provider rejected the generated response",
            },
          ],
        },
      ]),
    );
    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        buildGeminiModel(),
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as never,
        { apiKey: "gemini-api-key" } as never,
      ),
    );
    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
    expect((await stream.result()).errorCode).toBe("SAFETY");
  });

  it("rotates Gemini LLM API keys when a pre-stream request is rate limited", async () => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "gemini-key-2");
    guardedFetchMock.mockResolvedValueOnce(buildRateLimitResponse()).mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [{ content: { parts: [{ text: "recovered" }] }, finishReason: "STOP" }],
        },
      ]),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-key-1" } });

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(guardedFetchMock).toHaveBeenCalledTimes(2);
    expectHeaders(
      requireRequestInit(requireMockCall(guardedFetchMock, 0, "guarded fetch"), "guarded fetch"),
      { "x-goog-api-key": "gemini-key-1" },
    );
    expectHeaders(
      requireRequestInit(requireMockCall(guardedFetchMock, 1, "guarded fetch"), "guarded fetch"),
      { "x-goog-api-key": "gemini-key-2" },
    );
    const firstBody = requireRequestInit(
      requireMockCall(guardedFetchMock, 0, "guarded fetch"),
      "guarded fetch",
    ).body;
    const secondBody = requireRequestInit(
      requireMockCall(guardedFetchMock, 1, "guarded fetch"),
      "guarded fetch",
    ).body;
    expect(secondBody).toBe(firstBody);
  });

  it.each([
    {
      name: "does not rotate OAuth JSON credentials through configured Gemini API keys",
      options: { apiKey: JSON.stringify({ token: "oauth-token", projectId: "demo" }) },
      expectedHeaders: {
        Authorization: "Bearer oauth-token",
        "Content-Type": "application/json",
      },
      omitApiKeyHeader: true,
    },
    {
      name: "does not rotate when request headers override Gemini authentication",
      options: {
        apiKey: "explicit-option-key",
        headers: { "x-goog-api-key": "header-key" },
      },
      expectedHeaders: { "x-goog-api-key": "header-key" },
    },
    {
      name: "does not rotate global Gemini API keys into custom Gemini endpoints",
      model: {
        provider: "custom-google",
        baseUrl: "https://proxy.example.com/gemini/v1beta",
      },
      options: { apiKey: "explicit-proxy-key" },
      expectedHeaders: { "x-goog-api-key": "explicit-proxy-key" },
      expectedUrl:
        "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    },
    {
      name: "does not rotate global Gemini API keys into non-TLS Gemini endpoints",
      model: { baseUrl: "http://generativelanguage.googleapis.com/v1beta" },
      options: { apiKey: "explicit-http-key" },
      expectedHeaders: { "x-goog-api-key": "explicit-http-key" },
      expectedUrl:
        "http://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    },
  ])("$name", async ({ model, options, expectedHeaders, expectedUrl, omitApiKeyHeader }) => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "gemini-env-key");
    guardedFetchMock.mockResolvedValueOnce(buildRateLimitResponse());

    const result = await runGeminiStreamResult({ model: buildGeminiModel(model), options });

    expect(result.stopReason).toBe("error");
    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    const init = requireRequestInit(guardedCall, "guarded fetch");
    expectHeaders(init, Object.fromEntries(Object.entries(expectedHeaders)));
    if (expectedUrl) {
      expect(guardedCall[0]).toBe(expectedUrl);
    }
    if (omitApiKeyHeader) {
      expect(new Headers(init.headers).has("x-goog-api-key")).toBe(false);
    }
  });

  it("preserves MAX_TOKENS when the partial response contains a function call", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "lookup", args: { q: "hello" } } }],
              },
              finishReason: "MAX_TOKENS",
            },
          ],
        },
      ]),
    );

    const result = await runGeminiStreamResult({
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object" } }],
      } as Parameters<ReturnType<typeof createGoogleGenerativeAiTransportStreamFn>>[1],
      options: { apiKey: "gemini-api-key" },
    });

    expect(result.stopReason).toBe("length");
    expect(result.content).toEqual([expect.objectContaining({ type: "toolCall", name: "lookup" })]);
  });

  it("strips redundant google provider prefixes from Gemini API model paths", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([{ candidates: [{ finishReason: "STOP" }] }]),
    );

    const model = buildGeminiModel({
      id: "google/gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
    });
    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        { apiKey: "gemini-api-key" } as Parameters<typeof streamFn>[2],
      ),
    );
    expect((await stream.result()).stopReason).toBe("stop");

    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(guardedCall[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
    );
  });

  it("merges tool-call thought signatures from sibling SSE parts", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: "call_1", name: "lookup", args: { q: "hello" } },
                  },
                  { thoughtSignature: "Y2FsbF9zaWdfbWVyZ2VkXzE=" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
    );

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
      }),
    });

    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { q: "hello" },
        thoughtSignature: "Y2FsbF9zaWdfbWVyZ2VkXzE=",
      },
    ]);
  });

  it("keeps duplicate tool-call ids and their own thought signatures distinct", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call_1",
                      name: "first",
                      args: { value: 1 },
                    },
                    thoughtSignature: "first_signature",
                  },
                  {
                    functionCall: {
                      id: "call_1",
                      name: "second",
                      args: { value: 2 },
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
    );

    const result = await runGeminiStreamResult();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      id: "call_1",
      name: "first",
      arguments: { value: 1 },
      thoughtSignature: "first_signature",
    });
    expect(toolCalls[1]).toMatchObject({
      name: "second",
      arguments: { value: 2 },
    });
    expect(toolCalls[1]).not.toHaveProperty("thoughtSignature", "first_signature");
    expect(toolCalls[1]?.id).not.toBe("call_1");
  });

  it("keeps explicit thinking signatures after tool-call SSE parts", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: "call_1", name: "lookup", args: { q: "hello" } },
                  },
                  { thought: true, thoughtSignature: "dGhvdWdodF9zaWdfYWZ0ZXJfY2FsbA==" },
                  { thought: true, text: "draft" },
                  { text: "answer" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
    );

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
      }),
    });

    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { q: "hello" },
    });
    expect(result.content[1]).toEqual({
      type: "thinking",
      thinking: "draft",
      thinkingSignature: "dGhvdWdodF9zaWdfYWZ0ZXJfY2FsbA==",
    });
    expect(result.content[2]).toEqual({ type: "text", text: "answer" });
  });

  it("wraps malformed Gemini SSE JSON", async () => {
    guardedFetchMock.mockResolvedValueOnce(buildRawSseResponse("data: {not json\n\n"));

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Google SSE stream returned malformed JSON");
  });

  it("rejects an incomplete SSE frame after an otherwise terminal Google response", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse(
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\ndata: {"candidates":[',
      ),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("incomplete");
  });

  it.each([
    { label: "keepalive comment", tail: ": keepalive\n" },
    { label: "control fields", tail: "event: ping\nid: heartbeat" },
    { label: "empty data field", tail: "data:\n" },
  ])("ignores trailing $label when the Google SSE connection closes", async ({ tail }) => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse(`data: {"candidates":[{"finishReason":"STOP"}]}\n\r${tail}`),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("stop");
  });

  it("surfaces a framed provider error arriving after a terminal Google response", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse(
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n' +
          'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}\n\n',
      ),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "RESOURCE_EXHAUSTED",
      errorMessage: expect.stringContaining("quota exceeded"),
    });
  });

  it.each([
    { label: "carriage-return-only", delimiter: "\r\r" },
    { label: "line-feed then carriage-return", delimiter: "\n\r" },
    { label: "line-feed then CRLF", delimiter: "\n\r\n" },
    { label: "CRLF then carriage-return", delimiter: "\r\n\r" },
    { label: "CRLF then line-feed", delimiter: "\r\n\n" },
    { label: "carriage-return then CRLF", delimiter: "\r\r\n" },
  ])("accepts $label SSE frame delimiters", async ({ delimiter }) => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse(`data: {"candidates":[{"finishReason":"STOP"}]}${delimiter}`),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("stop");
  });

  it("does not mistake one CRLF for an SSE frame delimiter", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse('data: {"candidates":[{"finishReason":"STOP"}]}\r\n'),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("incomplete");
  });

  it("keeps CRLF-separated data lines in the same SSE event", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse('data: {"candidates":[\r\ndata: {"finishReason":"STOP"}]}\r\n\r\n'),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("stop");
  });

  it("cancels open Gemini SSE bodies when parsing fails", async () => {
    let cancelCalled = false;
    guardedFetchMock.mockResolvedValueOnce(
      buildOpenRawSseResponse({
        sse: "data: {not json\n\n",
        onCancel: () => {
          cancelCalled = true;
        },
      }),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Google SSE stream returned malformed JSON");
    expect(cancelCalled).toBe(true);
  });

  it.each(["request headers", "response body"] as const)(
    "retries Gemini 3 requests with lean thinking when the first %s stalls",
    async (stalledPhase) => {
      vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
      guardedFetchMock
        .mockImplementationOnce((_url: string, init?: RequestInit) =>
          stalledPhase === "response body"
            ? Promise.resolve(
                new Response(new ReadableStream<Uint8Array>(), {
                  headers: { "content-type": "text/event-stream" },
                }),
              )
            : new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  reject(
                    toLintErrorObject(
                      init.signal?.reason ?? new Error("aborted"),
                      "Non-Error rejection",
                    ),
                  );
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

      const result = await runGeminiStreamResult({
        model: buildGeminiModel({
          id: "gemini-3.1-pro-preview",
          name: "Gemini 3.1 Pro Preview",
        }),
        context: {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
        } as Parameters<ReturnType<typeof createGoogleGenerativeAiTransportStreamFn>>[1],
        options: { reasoning: "high" },
      });

      expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
      expect(guardedFetchMock).toHaveBeenCalledTimes(2);
      const firstBody = parseRequestJsonBody(
        requireRequestInit(requireMockCall(guardedFetchMock, 0, "guarded fetch"), "guarded fetch"),
      );
      const retryBody = parseRequestJsonBody(
        requireRequestInit(requireMockCall(guardedFetchMock, 1, "guarded fetch"), "guarded fetch"),
      );
      const firstGenerationConfig = requireGenerationConfig(firstBody);
      const retryGenerationConfig = requireGenerationConfig(retryBody);
      expect(firstGenerationConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: "HIGH",
      });
      expect(retryGenerationConfig.thinkingConfig).toEqual({
        thinkingLevel: "LOW",
      });
      expect(retryBody.tools).toEqual(firstBody.tools);
    },
  );

  it("keeps oversized-video shedding in the Gemini 3 retry payload", async () => {
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    guardedFetchMock
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>(), {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        buildSseResponse([
          {
            candidates: [{ content: { parts: [{ text: "recovered" }] }, finishReason: "STOP" }],
          },
        ]),
      );

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        input: ["text", "image", "video"] as never,
      }),
      options: withProviderContextHandoff({ reasoning: "high" }, async () => ({
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "A".repeat(20_000_000) }],
            timestamp: 0,
          },
        ],
      })),
    });

    expect(result.errorMessage).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(guardedFetchMock).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      const body = requireRequestInit(
        requireMockCall(guardedFetchMock, index, "guarded fetch"),
        "guarded fetch",
      ).body as string;
      expect(new TextEncoder().encode(body).byteLength).toBeLessThan(20_000_000);
      expect(body).toContain("native video slot unavailable");
    }
  });

  it("does not retry a genuinely empty Gemini 3 response", async () => {
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    guardedFetchMock.mockResolvedValueOnce(buildRawSseResponse(""));

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({ id: "gemini-3.1-pro-preview" }),
      options: { reasoning: "high" },
    });

    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "STREAM_INCOMPLETE",
    });
    expect(guardedFetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry when an external abort interrupts a stalled Gemini 3 response body", async () => {
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "1000");
    const controller = new AbortController();
    let resolveBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      resolveBodyRead = resolve;
    });
    const cancel = vi.fn();
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            resolveBodyRead();
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

    const result = runGeminiStreamResult({
      model: buildGeminiModel({ id: "gemini-3.1-pro-preview" }),
      options: { reasoning: "high", signal: controller.signal },
    });
    await bodyRead;
    controller.abort(
      Object.assign(new Error("operator canceled the request"), { code: "OPERATOR_CANCELLED" }),
    );

    await expect(result).resolves.toMatchObject({
      stopReason: "aborted",
      errorCode: "OPERATOR_CANCELLED",
      errorMessage: "operator canceled the request",
    });
    expect(guardedFetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
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

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
      }),
      options: { reasoning: "high" },
    });

    expect(result.content).toEqual([{ type: "text", text: "first second" }]);
    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses bearer auth when the Google api key is an OAuth JSON payload", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([{ candidates: [{ finishReason: "STOP" }] }]),
    );

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

    await runGeminiStreamResult({
      model,
      options: { apiKey: JSON.stringify({ token: "oauth-token", projectId: "demo" }) },
    });

    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(typeof guardedCall[0]).toBe("string");
    const init = requireRequestInit(guardedCall, "guarded fetch");
    expectHeaders(init, {
      Authorization: "Bearer oauth-token",
      "Content-Type": "application/json",
    });
  });

  it.each([
    ["eu", "https://aiplatform.eu.rep.googleapis.com"],
    ["us", "https://aiplatform.us.rep.googleapis.com"],
  ])(
    "routes the %s Vertex multi-region through the production stream",
    async (location, origin) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-region-"));
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
      vi.stubEnv("HOME", path.join(tempDir, "home"));
      vi.stubEnv("APPDATA", "");
      vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo");
      vi.stubEnv("GOOGLE_CLOUD_LOCATION", location);
      googleAuthGetAccessTokenMock.mockResolvedValueOnce("oauth-token");
      guardedFetchMock.mockResolvedValueOnce(
        buildSseResponse([{ candidates: [{ finishReason: "STOP" }] }]),
      );
      const streamFn = createGoogleVertexTransportStreamFn();
      const stream = await Promise.resolve(
        streamFn(
          buildGoogleVertexModel(),
          { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as Parameters<
            typeof streamFn
          >[1],
          {
            apiKey: "gcp-vertex-credentials",
            fetch: vi.fn(),
          } as Parameters<typeof streamFn>[2],
        ),
      );
      await stream.result();

      const [url] = requireMockCall(guardedFetchMock, 0, "guarded fetch");
      expect(String(url)).toBe(
        `${origin}/v1/projects/demo/locations/${location}/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse`,
      );
    },
  );

  it("resolves non-file Vertex ADC through google-auth-library without OAuth refresh fetch", async () => {
    await useGoogleAuthLibraryCredentials("authlib", "ya29.google-auth-token");
    const tokenFetchMock = vi.fn();

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer ya29.google-auth-token",
    });

    expect(googleAuthMock).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      clientOptions: { transporterOptions: { timeout: 30_000 } },
    });
    expect(googleAuthGetAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(tokenFetchMock).not.toHaveBeenCalled();
  });

  it("never refreshes stale home ADC when the selected Cloud SDK directory has no credentials", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-stale-home-"));
    const homeCredentialsDir = path.join(tempDir, "home", ".config", "gcloud");
    await mkdir(homeCredentialsDir, { recursive: true });
    await writeFile(
      path.join(homeCredentialsDir, "application_default_credentials.json"),
      JSON.stringify({
        type: "authorized_user",
        client_id: "stale-client",
        client_secret: "stale-secret",
        refresh_token: "stale-refresh",
      }),
      "utf8",
    );
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("CLOUDSDK_CONFIG", path.join(tempDir, "missing-cloud-sdk"));
    vi.stubEnv("HOME", path.join(tempDir, "home"));
    vi.stubEnv("APPDATA", "");
    googleAuthGetAccessTokenMock.mockResolvedValueOnce("fixture-google-auth-token");
    const tokenFetchMock = vi.fn();

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer fixture-google-auth-token",
    });
    expect(googleAuthMock).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      clientOptions: { transporterOptions: { timeout: 30_000 } },
    });
    expect(tokenFetchMock).not.toHaveBeenCalled();
  });

  it("bounds Google Vertex ADC files before google-auth-library reads them", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-adc-file-"));
    const credentialsPath = path.join(tempDir, "application_default_credentials.json");
    const credentials = {
      type: "service_account",
      client_email: "vertex@example.iam.gserviceaccount.com",
    };
    const json = JSON.stringify(credentials);
    await writeFile(credentialsPath, `${json}${" ".repeat(1024 * 1024 - json.length)}`, "utf8");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
    googleAuthGetAccessTokenMock.mockResolvedValueOnce("ya29.file-token");

    await expect(resolveGoogleVertexAuthorizedUserHeaders(vi.fn())).resolves.toEqual({
      Authorization: "Bearer ya29.file-token",
    });
    expect(googleAuthMock).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      credentials,
      clientOptions: { transporterOptions: { timeout: 30_000 } },
    });

    resetGoogleVertexAdcState();
    await writeFile(credentialsPath, `${json}${" ".repeat(1024 * 1024 + 1 - json.length)}`, "utf8");
    await expect(resolveGoogleVertexAuthorizedUserHeaders(vi.fn())).rejects.toMatchObject({
      name: "FsSafeError",
      code: "too-large",
      message: `Google Vertex ADC credentials file at ${credentialsPath} exceeds 1048576 bytes.`,
    });
  });

  it("bounds google-auth-library ADC token resolution at the Vertex owner", async () => {
    await useGoogleAuthLibraryCredentials("authlib-timeout");
    vi.useFakeTimers();
    googleAuthGetAccessTokenMock
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce("ya29.recovered-token");

    const pendingRefresh = resolveGoogleVertexAuthorizedUserHeaders(vi.fn());
    const refreshError = pendingRefresh.catch((error: unknown) => error);
    await vi.waitFor(() => expect(googleAuthGetAccessTokenMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(refreshError).resolves.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(vi.fn())).resolves.toEqual({
      Authorization: "Bearer ya29.recovered-token",
    });
    expect(googleAuthMock).toHaveBeenCalledTimes(2);
    expect(googleAuthGetAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache google-auth ADC tokens when fallback expiry would exceed Date range", async () => {
    await useGoogleAuthLibraryCredentials("authlib-expiry");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    googleAuthGetAccessTokenMock
      .mockResolvedValueOnce("ya29.first-token")
      .mockResolvedValueOnce("ya29.second-token");
    const tokenFetchMock = vi.fn();

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer ya29.first-token",
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer ya29.second-token",
    });

    expect(googleAuthGetAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(tokenFetchMock).not.toHaveBeenCalled();
  });

  it("uses google-auth-library bearer auth for Google Vertex credential marker requests", async () => {
    await useGoogleAuthLibraryCredentials("authlib-stream", "ya29.transport-token");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    const tokenFetchMock = vi.fn();
    mockGoogleTextResponse();

    await runGoogleVertexStreamResult({ fetch: tokenFetchMock });

    expect(tokenFetchMock).not.toHaveBeenCalled();
    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    const guardedInit = requireRequestInit(guardedCall, "guarded fetch");
    expectHeaders(guardedInit, {
      Authorization: "Bearer ya29.transport-token",
      "Content-Type": "application/json",
      accept: "text/event-stream",
    });
    expect(new Headers(guardedInit.headers).has("x-goog-api-key")).toBe(false);
  });

  it.each([
    {
      scenario: "authorized-user ADC quota project",
      credentialType: "authorized_user",
      credentialQuotaProject: "fixture-json-billing",
      envQuotaProject: "",
      expectedQuotaProject: "fixture-json-billing",
    },
    {
      scenario: "environment quota project overriding authorized-user ADC",
      credentialType: "authorized_user",
      credentialQuotaProject: "fixture-json-billing",
      envQuotaProject: "fixture-env-billing",
      expectedQuotaProject: "fixture-env-billing",
    },
    {
      scenario: "google-auth service-account ADC quota project",
      credentialType: "service_account",
      credentialQuotaProject: "fixture-service-billing",
      envQuotaProject: "",
      expectedQuotaProject: "fixture-service-billing",
    },
    {
      scenario: "google-auth metadata ADC environment quota project",
      credentialType: "metadata",
      credentialQuotaProject: "",
      envQuotaProject: "fixture-metadata-billing",
      expectedQuotaProject: "fixture-metadata-billing",
    },
  ])(
    "forwards the $scenario on the actual Vertex request",
    async ({ credentialType, credentialQuotaProject, envQuotaProject, expectedQuotaProject }) => {
      const tokenFetchMock = vi.fn();
      vi.stubEnv("GOOGLE_CLOUD_PROJECT", "fixture-project");
      vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
      vi.stubEnv("GOOGLE_CLOUD_QUOTA_PROJECT", envQuotaProject);
      if (credentialType === "authorized_user") {
        await useGoogleAuthorizedUserCredentials(
          "quota-authorized-user",
          "fixture-refresh-token",
          credentialQuotaProject,
        );
        tokenFetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "fixture-vertex-token", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } else if (credentialType === "service_account") {
        const tempDir = await mkdtemp(
          path.join(os.tmpdir(), "openclaw-google-vertex-quota-service-"),
        );
        const credentialsPath = path.join(tempDir, "application_default_credentials.json");
        await writeFile(
          credentialsPath,
          JSON.stringify({
            type: "service_account",
            client_email: "fixture@example.invalid",
            quota_project_id: credentialQuotaProject,
          }),
          "utf8",
        );
        vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
        googleAuthGetAccessTokenMock.mockResolvedValueOnce("fixture-vertex-token");
      } else {
        const tempDir = await mkdtemp(
          path.join(os.tmpdir(), "openclaw-google-vertex-quota-metadata-"),
        );
        vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
        vi.stubEnv("HOME", path.join(tempDir, "home"));
        vi.stubEnv("APPDATA", "");
        googleAuthGetAccessTokenMock.mockResolvedValueOnce("fixture-vertex-token");
      }
      guardedFetchMock.mockResolvedValueOnce(
        buildSseResponse([
          {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          },
        ]),
      );

      await runGoogleVertexStreamResult({ fetch: tokenFetchMock });

      const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
      expectHeaders(requireRequestInit(guardedCall, "guarded fetch"), {
        Authorization: "Bearer fixture-vertex-token",
        "x-goog-user-project": expectedQuotaProject,
      });
    },
  );

  it("strips redundant google provider prefixes from Google Vertex model paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-prefix-"));
    vi.stubEnv("HOME", path.join(tempDir, "home"));
    vi.stubEnv("APPDATA", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    googleAuthGetAccessTokenMock.mockResolvedValueOnce("ya29.transport-token");
    const tokenFetchMock = vi.fn();
    mockGoogleTextResponse();

    await runGoogleVertexStreamResult({
      model: buildGoogleVertexModel({ id: "google/gemini-3.1-pro-preview" }),
      fetch: tokenFetchMock,
    });

    // The provider prefix must be stripped from the Vertex model path, matching
    // resolveGoogleModelPath; otherwise the id becomes models/google%2F... (404).
    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expect(guardedCall[0]).toContain(
      "/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent",
    );
    expect(guardedCall[0]).not.toContain("google%2F");
  });

  it("refreshes authorized_user ADC before Google Vertex requests", async () => {
    await useGoogleAuthorizedUserCredentials("adc", "refresh-token");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
    const tokenFetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ya29.vertex-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mockGoogleTextResponse();

    const result = await runGoogleVertexStreamResult({ fetch: tokenFetchMock });

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

  it("times out an authorized_user ADC token refresh", async () => {
    await useGoogleAuthorizedUserCredentials("adc-timeout", "timeout-refresh-token");
    vi.useFakeTimers();

    let observedSignal: AbortSignal | undefined;
    const tokenFetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected token refresh deadline signal");
      }
      observedSignal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const pendingRefresh = resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock);
    // Attach the rejection handler before advancing fake time so the expected
    // timeout cannot surface as an unhandled rejection between timer ticks.
    const refreshError = pendingRefresh.catch((error: unknown) => error);
    await vi.waitFor(() => expect(tokenFetchMock).toHaveBeenCalledOnce());
    const signal = observedSignal;
    if (!signal) {
      throw new Error("expected token refresh deadline signal");
    }
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(signal.aborted).toBe(true);
    await expect(refreshError).resolves.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
  });

  it("refreshes authorized_user ADC from a compressed token response", async () => {
    await useGoogleAuthorizedUserCredentials("adc-gzip", "gzip-refresh-token");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
    const tokenFetchMock = vi.fn().mockResolvedValue(
      new Response(
        gzipSync(JSON.stringify({ access_token: "ya29.gzip-token", expires_in: 3600 })),
        {
          status: 200,
          headers: {
            "content-encoding": "gzip",
            "content-type": "application/json",
          },
        },
      ),
    );
    mockGoogleTextResponse();

    await runGoogleVertexStreamResult({ fetch: tokenFetchMock });

    expect(tokenFetchMock).toHaveBeenCalledTimes(1);
    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    expectHeaders(requireRequestInit(guardedCall, "guarded fetch"), {
      Authorization: "Bearer ya29.gzip-token",
    });
  });

  it("rejects oversized authorized_user ADC token responses", async () => {
    await useGoogleAuthorizedUserCredentials("adc-large", "large-refresh-token");
    const tokenFetchMock = vi
      .fn()
      .mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).rejects.toThrow(
      "Google OAuth token response exceeds 1048576 bytes",
    );
  });

  it("rejects authorized_user ADC gzip responses that expand past the limit", async () => {
    await useGoogleAuthorizedUserCredentials("adc-bomb", "bomb-refresh-token");
    const tokenFetchMock = vi.fn().mockResolvedValue(
      new Response(gzipSync("x".repeat(1024 * 1024 + 1)), {
        status: 200,
        headers: { "content-encoding": "gzip" },
      }),
    );

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).rejects.toThrow(
      "Google OAuth token response exceeds 1048576 decompressed bytes",
    );
  });

  it("does not reuse authorized_user ADC tokens with unsafe expiry lifetimes", async () => {
    await useGoogleAuthorizedUserCredentials("unsafe-adc", "refresh-token");
    const tokenFetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "ya29.unsafe-token",
            expires_in: Number.MAX_SAFE_INTEGER,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.fresh-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer ya29.unsafe-token",
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer ya29.fresh-token",
    });

    expect(tokenFetchMock).toHaveBeenCalledTimes(2);
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
    mockGoogleTextResponse();

    await runGoogleVertexStreamResult({ fetch: tokenFetchMock });

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

  it.each([
    {
      name: "replays Gemini tool call thought signatures for same-model history",
      modelId: "gemini-3-flash-preview",
      signature: "Y2FsbF9zaWdfMQ==",
      messages: [
        googleToolCallAssistantTurn({
          model: "gemini-3-flash-preview",
          thoughtSignature: "Y2FsbF9zaWdfMQ==",
        }),
      ],
    },
    {
      name: "re-attaches replayed Gemini thought signatures when a later tool call is missing one",
      modelId: "gemini-3.1-pro-preview",
      signature: "Y2FsbF9zaWdfcmVwbGF5XzE=",
      messages: [
        googleToolCallAssistantTurn({ thoughtSignature: "Y2FsbF9zaWdfcmVwbGF5XzE=" }),
        toolResultTurn(),
        googleToolCallAssistantTurn({ timestamp: 2 }),
      ],
    },
    {
      name: "treats the Google transport alias as the same route for signature replay",
      modelId: "gemini-3.1-pro-preview",
      api: "openclaw-google-generative-ai-transport",
      signature: "Y2FsbF9zaWdfYWxpYXNfMQ==",
      messages: [
        googleToolCallAssistantTurn({ thoughtSignature: "Y2FsbF9zaWdfYWxpYXNfMQ==" }),
        toolResultTurn(),
        googleToolCallAssistantTurn({ timestamp: 2 }),
      ],
    },
    {
      name: "preserves opaque same-route Gemini thought signatures during replay",
      modelId: "gemini-3.1-pro-preview",
      signature: "b3BhcXVlLnNpZy11cmxfc2FmZX4x",
      messages: [
        googleToolCallAssistantTurn({ thoughtSignature: "b3BhcXVlLnNpZy11cmxfc2FmZX4x" }),
        toolResultTurn(),
        googleToolCallAssistantTurn({ timestamp: 2 }),
      ],
    },
  ])("$name", ({ modelId, api, signature, messages }) => {
    const model = {
      ...buildGeminiModel({
        id: modelId,
        name:
          modelId === "gemini-3-flash-preview"
            ? "Gemini 3 Flash Preview"
            : "Gemini 3.1 Pro Preview",
      }),
      ...(api ? { api } : {}),
    } as Parameters<typeof buildGoogleGenerativeAiParams>[0];
    const params = buildGoogleGenerativeAiParams(model, { messages } as never);

    expect(getLastModelTurn(params.contents)).toEqual({
      role: "model",
      parts: [
        {
          thoughtSignature: signature,
          functionCall: { name: "lookup", args: { q: "hello" } },
        },
      ],
    });
  });

  it("keeps text and thinking signatures when the request uses the Google transport alias", () => {
    const model = {
      ...buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
      }),
      api: "openclaw-google-generative-ai-transport",
    } as Model<"openclaw-google-generative-ai-transport">;

    const params = buildGoogleGenerativeAiParams(model, {
      messages: [
        {
          role: "assistant",
          provider: "google",
          api: "google-generative-ai",
          model: "gemini-3.1-pro-preview",
          stopReason: "stop",
          timestamp: 0,
          content: [
            {
              type: "thinking",
              thinking: "plan",
              thinkingSignature: "dGhpbmtfc2lnX2FsaWFzXzE=",
            },
            {
              type: "text",
              text: "answer",
              textSignature: "dGV4dF9zaWdfYWxpYXNfMQ==",
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toEqual({
      role: "model",
      parts: [
        {
          thought: true,
          text: "plan",
          thoughtSignature: "dGhpbmtfc2lnX2FsaWFzXzE=",
        },
        {
          text: "answer",
          thoughtSignature: "dGV4dF9zaWdfYWxpYXNfMQ==",
        },
      ],
    });
  });

  it.each([
    {
      name: "keeps a tool call's own Gemini thought signature before replay fallback",
      firstSignature: "Y2FsbF9zaWdfZmlyc3RfMQ==",
      secondSignature: "Y2FsbF9zaWdfc2Vjb25kXzE=",
    },
    {
      name: "does not replay Gemini thought signatures from later turns",
      firstSignature: undefined,
      secondSignature: "Y2FsbF9zaWdfZnV0dXJlXzE=",
    },
  ])("$name", ({ firstSignature, secondSignature }) => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" }),
      {
        messages: [
          googleToolCallAssistantTurn({ thoughtSignature: firstSignature }),
          toolResultTurn(),
          googleToolCallAssistantTurn({ timestamp: 2, thoughtSignature: secondSignature }),
        ],
      } as never,
    );

    const modelTurns = params.contents.filter(isModelTurnWithParts);
    expect(modelTurns).toHaveLength(2);
    for (const [index, thoughtSignature] of [
      firstSignature ?? "skip_thought_signature_validator",
      secondSignature,
    ].entries()) {
      expect(modelTurns[index]).toMatchObject({
        parts: [{ thoughtSignature, functionCall: { name: "lookup", args: { q: "hello" } } }],
      });
    }
  });

  it("does not re-attach replayed Gemini thought signatures to a different tool-call part", () => {
    const params = buildGeminiReplayParams([
      googleToolCallAssistantTurn({ thoughtSignature: "Y2FsbF9zaWdfcmVwbGF5XzE=" }),
      toolResultTurn(),
      googleToolCallAssistantTurn({ timestamp: 2, args: { q: "hello-again" } }),
    ]);

    expect(getLastModelTurn(params.contents)).toMatchObject({
      role: "model",
      parts: [
        {
          thoughtSignature: "skip_thought_signature_validator",
          functionCall: { name: "lookup", args: { q: "hello-again" } },
        },
      ],
    });
  });

  it("does not replay tool-call thought signatures from a different provider route", () => {
    // Prior turn came from an Anthropic route — its signature looks valid base64
    // but must NOT be replayed into a Gemini request.
    const params = buildGeminiReplayParams([
      googleToolCallAssistantTurn({
        provider: "anthropic",
        api: "anthropic",
        model: "claude-sonnet-4",
        id: "call_foreign",
        // Plausible-looking base64 from a non-Gemini provider.
        thoughtSignature: "bXNnXzAxWEZEVURZSmdBQUNjblNNMlRUZ1FzQQ==",
      }),
      toolResultTurn("call_foreign"),
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ]);

    // The foreign signature should not be replayed into the Gemini payload.
    // Gemini 3 still needs the documented skip fallback for unsigned function
    // calls that came from another route.
    const firstModelTurn = getFirstModelTurn(params.contents);
    expect(firstModelTurn).toMatchObject({
      role: "model",
      parts: [
        {
          thoughtSignature: "skip_thought_signature_validator",
          functionCall: { name: "lookup", args: { q: "hello" } },
        },
      ],
    });
    expect(
      expectDefined(firstModelTurn.parts[0], "first Gemini model part").thoughtSignature,
    ).not.toBe("bXNnXzAxWEZEVURZSmdBQUNjblNNMlRUZ1FzQQ==");
  });

  it("does not replay prior Gemini thought signatures onto a later foreign route", () => {
    const params = buildGeminiReplayParams([
      googleToolCallAssistantTurn({ thoughtSignature: "Y2FsbF9zaWdfZ29vZ2xlXzE=" }),
      toolResultTurn(),
      googleToolCallAssistantTurn({
        provider: "anthropic",
        api: "anthropic",
        model: "claude-sonnet-4",
        timestamp: 2,
      }),
    ]);

    const modelTurns = params.contents.filter(isModelTurnWithParts);
    expect(modelTurns).toHaveLength(2);
    expect(modelTurns[1]).toMatchObject({
      parts: [
        {
          thoughtSignature: "skip_thought_signature_validator",
          functionCall: { name: "lookup", args: { q: "hello" } },
        },
      ],
    });
    const laterTurn = expectDefined(modelTurns[1], "later Gemini model turn");
    expect(expectDefined(laterTurn.parts[0], "later Gemini model part").thoughtSignature).not.toBe(
      "Y2FsbF9zaWdfZ29vZ2xlXzE=",
    );
  });

  it.each([
    {
      name: "replaces invalid Gemini tool-call sentinel signatures with the skip fallback",
      signature: "reasoning",
    },
    {
      name: "preserves the skip-validator fallback for unsigned Gemini tool-call replay",
      signature: "skip_thought_signature_validator",
    },
  ])("$name", ({ signature }) => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" }),
      { messages: [googleToolCallAssistantTurn({ thoughtSignature: signature })] } as never,
    );
    expect(getFirstModelTurn(params.contents).parts[0]).toMatchObject({
      thoughtSignature: "skip_thought_signature_validator",
      functionCall: { name: "lookup", args: { q: "hello" } },
    });
  });

  it("adds skip-validator fallback to unsigned sibling Gemini 3 tool calls", () => {
    const params = buildGeminiReplayParams([
      {
        role: "assistant",
        provider: "google",
        api: "google-generative-ai",
        model: "gemini-3.1-pro-preview",
        stopReason: "toolUse",
        timestamp: 0,
        content: [
          {
            type: "toolCall",
            id: "call_math",
            name: "math_eval",
            arguments: { expression: "17*23" },
            thoughtSignature: "cmVhbF9zaWdfMQ==",
          },
          {
            type: "toolCall",
            id: "call_lookup",
            name: "lookup_fact",
            arguments: { key: "beta" },
          },
          {
            type: "toolCall",
            id: "call_transform",
            name: "string_transform",
            arguments: { text: "claw", mode: "reverse" },
          },
        ],
      },
    ]);

    const parts = (params.contents[0] as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      thoughtSignature: "cmVhbF9zaWdfMQ==",
      functionCall: { name: "math_eval", args: { expression: "17*23" } },
    });
    expect(parts[1]).toMatchObject({
      thoughtSignature: "skip_thought_signature_validator",
      functionCall: { name: "lookup_fact", args: { key: "beta" } },
    });
    expect(parts[2]).toMatchObject({
      thoughtSignature: "skip_thought_signature_validator",
      functionCall: { name: "string_transform", args: { text: "claw", mode: "reverse" } },
    });
  });

  it.each([
    ["gemini-pro-latest", "Gemini Pro Latest"],
    ["gemini-flash-latest", "Gemini Flash Latest"],
    ["gemini-flash-lite-latest", "Gemini Flash Lite Latest"],
  ])(
    "adds skip-validator fallback to first-turn unsigned Gemini 3 tool calls for %s",
    (modelId, modelName) => {
      const model = buildGeminiModel({ id: modelId, name: modelName });
      const params = buildGoogleGenerativeAiParams(model, {
        messages: [
          googleToolCallAssistantTurn({ model: modelId }),
          toolResultTurn(),
          googleToolCallAssistantTurn({ timestamp: 2, model: modelId }),
        ],
      } as never);

      const modelTurns = params.contents.filter(isModelTurnWithParts);
      expect(modelTurns).toHaveLength(2);
      expect(modelTurns[0]).toMatchObject({
        parts: [
          {
            thoughtSignature: "skip_thought_signature_validator",
            functionCall: { name: "lookup", args: { q: "hello" } },
          },
        ],
      });
    },
  );

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
              thoughtSignature: "Zm9yZWlnbl9zaWc=",
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "lookup", args: { q: "hello" } } }],
    });
    expect(JSON.stringify(params.contents)).not.toContain("Zm9yZWlnbl9zaWc=");
    expect(JSON.stringify(params.contents)).not.toContain("skip_thought_signature_validator");
  });

  it("builds direct Gemini payloads without negative fallback thinking budgets", () => {
    const model = buildGeminiModel({
      id: "custom-gemini-model",
      name: "Custom Gemini",
      provider: "custom-google",
      baseUrl: "https://proxy.example.com/gemini/v1beta",
    });

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

  it.each([
    {
      name: "does not send thinkingConfig when the resolved Google model disables reasoning",
      model: { id: "gemma-4-26b-a4b-it", reasoning: false },
      options: { reasoning: "medium" },
    },
    {
      name: "omits disabled thinkingBudget=0 for Gemini 2.5 Pro direct payloads",
      model: {},
      options: { maxTokens: 128 },
      maxOutputTokens: 128,
    },
  ])("$name", ({ model, options, maxOutputTokens }) => {
    const generationConfig = buildGeminiUserParams(model, options).generationConfig ?? {};
    expect(generationConfig).not.toHaveProperty("thinkingConfig");
    if (maxOutputTokens !== undefined) {
      expect(generationConfig).toHaveProperty("maxOutputTokens", maxOutputTokens);
    }
  });

  it.each([
    {
      name: "forwards configured stop sequences to the Gemini generationConfig",
      stop: ["</tool>", "\n\nObservation:"],
      expected: ["</tool>", "\n\nObservation:"],
    },
    { name: "omits stopSequences when the stop list is empty", stop: [], expected: undefined },
  ])("$name", ({ stop, expected }) => {
    const generationConfig = buildGeminiUserParams({}, { stop }).generationConfig ?? {};
    if (expected) {
      expect(generationConfig).toHaveProperty("stopSequences", expected);
    } else {
      expect(generationConfig).not.toHaveProperty("stopSequences");
    }
  });

  it("sends stopSequences in the serialized Gemini request body via the guarded fetch transport", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([{ candidates: [{ finishReason: "STOP" }] }]),
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
      } satisfies Model<"google-generative-ai">,
      {},
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "gemini-api-key",
          stop: ["</tool>", "\n\nObservation:"],
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    const guardedCall = requireMockCall(guardedFetchMock, 0, "guarded fetch");
    const init = requireRequestInit(guardedCall, "guarded fetch");
    const payload = parseRequestJsonBody(init);
    const generationConfig = requireGenerationConfig(payload);
    expect(generationConfig.stopSequences).toEqual(["</tool>", "\n\nObservation:"]);
  });

  it("strips explicit thinkingBudget=0 but preserves includeThoughts for Gemini 2.5 Pro", () => {
    const thinkingConfig = requireThinkingConfig(
      requireGenerationConfig(
        buildGeminiUserParams({}, { thinking: { enabled: true, budgetTokens: 0 } }),
      ),
    );
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
      const generationConfig = requireGenerationConfig(
        buildGeminiUserParams({ id }, { maxTokens: 128 }),
      );
      const thinkingConfig = requireThinkingConfig(generationConfig);
      expect(generationConfig.maxOutputTokens).toBe(128);
      expect(thinkingConfig.thinkingLevel).toBe(level);
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    },
  );

  it("maps explicit Gemini 3 thinking budgets to thinkingLevel", () => {
    const params = buildGeminiUserParams(
      { id: "gemini-3-flash-preview" },
      { thinking: { enabled: true, budgetTokens: 8192 } },
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
    const params = buildGeminiUserParams(
      { id: "gemini-3-flash-preview" },
      { reasoning: "adaptive" },
    );

    const generationConfig = requireGenerationConfig(params);
    const thinkingConfig = requireThinkingConfig(generationConfig);
    expect(thinkingConfig.includeThoughts).toBe(true);
    expect(thinkingConfig).not.toHaveProperty("thinkingLevel");
    expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
  });

  it("maps adaptive Gemini 2.5 thinking to dynamic thinkingBudget", () => {
    const params = buildGeminiUserParams({ id: "gemini-2.5-flash" }, { reasoning: "adaptive" });

    const generationConfig = requireGenerationConfig(params);
    expect(requireThinkingConfig(generationConfig)).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    });
  });

  it("normalizes explicit Gemini 3 Pro thinking levels", () => {
    const params = buildGeminiUserParams(
      { id: "gemini-3.1-pro-preview" },
      { thinking: { enabled: true, level: "MINIMAL" } },
    );

    const generationConfig = requireGenerationConfig(params);
    expect(requireThinkingConfig(generationConfig)).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    });
  });

  it("keeps Gemini function declaration bytes stable across discovery orders", () => {
    const tools = [
      {
        name: "zeta_lookup",
        description: "Look up the last value",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
      {
        name: "alpha_lookup",
        description: "Look up the first value",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ];
    const buildParams = (orderedTools: typeof tools) =>
      buildGoogleGenerativeAiParams(buildGeminiModel(), {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: orderedTools,
      } as never);

    const first = buildParams(tools);
    const reversed = buildParams(tools.toReversed());

    expect(reversed.tools).toEqual(first.tools);
    expect(first.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({ name: "alpha_lookup" }),
          expect.objectContaining({ name: "zeta_lookup" }),
        ],
      },
    ]);
  });

  it("includes cachedContent in direct Gemini payloads when requested", () => {
    const params = buildGeminiUserParams(
      {},
      {
        cachedContent: "cachedContents/prebuilt-context",
      },
    );

    expect(params.cachedContent).toBe("cachedContents/prebuilt-context");
  });

  it("omits per-request system and tool settings when using cachedContent", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel(),
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
      } as never,
      {
        cachedContent: " cachedContents/prebuilt-context ",
        toolChoice: "auto",
      },
    );

    expect(params.cachedContent).toBe("cachedContents/prebuilt-context");
    expect(params.systemInstruction).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(params.toolConfig).toBeUndefined();
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

  it("serializes structured-only Google tool results before fallback", () => {
    const params = buildGoogleToolResultParams([
      {
        type: "json",
        value: { city: "Paris", temperatureC: 21 },
        apiToken: "secret-token-123",
      },
    ]);

    const responseTurn = params.contents[1] as GoogleTestContentTurn;
    const functionResponse = expectDefined(responseTurn.parts[0], "JSON tool response part")
      .functionResponse as { response: { output: string } };

    expect(functionResponse).toMatchObject({ name: "lookup" });
    expect(functionResponse.response.output).toContain('"city":"Paris"');
    expect(functionResponse.response.output).toContain('"temperatureC":21');
    expect(functionResponse.response.output).toContain('"apiToken":"');
    expect(functionResponse.response.output).not.toContain("secret-token-123");
  });

  it("keeps explicit Google tool-result text before structured fallback", () => {
    const params = buildGoogleToolResultParams([
      { type: "json", value: { ignored: true } },
      { type: "text", text: "explicit result" },
    ]);

    expect(params.contents[1]).toMatchObject({
      parts: [{ functionResponse: { response: { output: "explicit result" } } }],
    });
  });

  it("redacts opaque and binary structured Google tool-result fields", () => {
    const params = buildGoogleToolResultParams([
      {
        type: "resource",
        mimeType: "image/png",
        data: "abcdef",
        encrypted_content: "opaque",
        text: "data:image/png;base64,abcdef",
      },
    ]);

    const responseTurn = params.contents[1] as GoogleTestContentTurn;
    const functionResponse = expectDefined(responseTurn.parts[0], "resource tool response part")
      .functionResponse as { response: { output: string } };

    expect(functionResponse.response.output).toContain('"data":"[binary data omitted: 6 chars]"');
    expect(functionResponse.response.output).toContain(
      '"encrypted_content":"[omitted encrypted_content]"',
    );
    expect(functionResponse.response.output).toContain('"text":"[inline data URI: 23 chars]"');
  });

  it("uses shared structured redaction for Google tool-result fields", () => {
    const params = buildGoogleToolResultParams([
      {
        type: "json",
        privateKey: "leaked-private-key-value-12345",
        private_key: "leaked-private-key-snake-12345",
        key: "leaked-generic-key-value-12345",
        keyMaterial: "leaked-key-material-value-12345",
        jwt: "leaked-jwt-value-1234567890",
        session: "leaked-session-value-123456",
        code: "code-value-1234567890",
        error: { code: "ERR_VISIBLE_GOOGLE_CODE" },
        oauth: { code: "OPAQUEGOOGLECODE1234567890" },
        providerError: { error: { code: "ERR_VISIBLE_PROVIDER_GOOGLE_CODE" } },
        signature: "leaked-signature-value-12345",
        cookie: "leaked-cookie-value-123456",
        "set-cookie": "leaked-set-cookie-value-12345",
        paymentCredential: "leaked-payment-credential-12345",
        cardNumber: "41111111111111112222",
        visible: "safe-value",
      },
    ]);

    const responseTurn = params.contents[1] as GoogleTestContentTurn;
    const functionResponse = expectDefined(responseTurn.parts[0], "redacted tool response part")
      .functionResponse as { response: { output: string } };

    expect(functionResponse.response.output).toContain('"visible":"safe-value"');
    expect(functionResponse.response.output).toContain('"code":"ERR_VISIBLE_GOOGLE_CODE"');
    expect(functionResponse.response.output).toContain('"code":"ERR_VISIBLE_PROVIDER_GOOGLE_CODE"');
    for (const leakedValue of [
      "leaked-private-key-value-12345",
      "leaked-private-key-snake-12345",
      "leaked-generic-key-value-12345",
      "leaked-key-material-value-12345",
      "leaked-jwt-value-1234567890",
      "leaked-session-value-123456",
      "code-value-1234567890",
      "OPAQUEGOOGLECODE1234567890",
      "leaked-signature-value-12345",
      "leaked-cookie-value-123456",
      "leaked-set-cookie-value-12345",
      "leaked-payment-credential-12345",
      "41111111111111112222",
    ]) {
      expect(functionResponse.response.output).not.toContain(leakedValue);
    }
  });

  it("keeps Google media-only tool results on media placeholders", () => {
    const params = buildGoogleToolResultParams([
      { type: "audio", mimeType: "audio/wav", data: "wav-bytes" },
    ]);

    expect(params.contents[1]).toMatchObject({
      parts: [{ functionResponse: { response: { output: "(see attached audio)" } } }],
    });
  });

  it("does not emit inline data or media placeholders for payload-less tool images", () => {
    const params = buildGoogleToolResultParams(
      [{ type: "image", mimeType: "image/png", data: "" }],
      {
        model: { id: "gemini-3-flash", input: ["text", "image"] },
        toolName: "screenshot",
      },
    );

    const serialized = JSON.stringify(params.contents);
    expect(serialized).toContain('"output":""');
    expect(serialized).not.toContain("inlineData");
    expect(serialized).not.toContain("see attached image");
  });

  it.each([
    ["bare Gemini 2.5 image first", "gemini-2.5-flash", ["screenshot", "weather"]],
    ["bare Gemini 2.5 image last", "gemini-2.5-flash", ["weather", "screenshot"]],
    [
      "provider-prefixed Gemini 2.5 image first",
      "google/gemini-2.5-pro",
      ["screenshot", "weather"],
    ],
    ["models-prefixed Gemini 2.5 image last", "models/gemini-2.5-pro", ["weather", "screenshot"]],
  ] as const)(
    "keeps parallel function responses in tool-call order and retains the deferred result for %s",
    (_label, modelId, resultOrder) => {
      const params = buildGoogleGenerativeAiParams(
        buildGeminiModel({ id: modelId, input: ["text", "image"] }),
        {
          messages: [
            { role: "user", content: "Screenshot the page and check the weather.", timestamp: 0 },
            parallelGoogleToolCallAssistantTurn(),
            ...resultOrder.map(googleToolResultMessage),
          ],
        } as never,
      );

      expect(params.contents.map((content) => content.role)).toEqual([
        "user",
        "model",
        "user",
        "user",
      ]);
      expect(params.contents[2]).toEqual({
        role: "user",
        parts: ["screenshot", "weather"].map((name) => ({
          functionResponse: {
            name,
            response:
              name === "screenshot" ? { output: "(see attached image)" } : { output: "Sunny, 21C" },
          },
        })),
      });
      expect(params.contents[3]).toEqual({
        role: "user",
        parts: [
          { text: "Tool result image:" },
          { inlineData: { mimeType: "image/png", data: "png-bytes" } },
        ],
      });
    },
  );

  it.each(["google/gemini-3.1-pro-preview", "models/gemini-3.1-pro-preview"])(
    "keeps image parts inside function responses for prefixed Gemini 3 model %s",
    (modelId) => {
      const params = buildGoogleGenerativeAiParams(
        buildGeminiModel({ id: modelId, input: ["text", "image"] }),
        {
          messages: [
            { role: "user", content: "Take a screenshot.", timestamp: 0 },
            googleToolCallAssistantTurn({
              model: modelId,
              name: "screenshot",
              args: {},
            }),
            googleToolResultMessage("screenshot"),
          ],
        } as never,
      );

      const functionResponse = (params.contents[2] as GoogleTestContentTurn).parts[0]
        ?.functionResponse as { parts?: unknown };
      expect(params.contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
      expect(functionResponse.parts).toEqual([
        { inlineData: { mimeType: "image/png", data: "png-bytes" } },
      ]);
    },
  );

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
    const params = buildGeminiUserParams({ id }, { reasoning });

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
                  { thought: true, text: "draft", thoughtSignature: "c2lnXzE=" },
                  { thoughtSignature: "c2lnXzI=" },
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
      { type: "thinking", thinking: "draft", thinkingSignature: "c2lnXzI=" },
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
                  { thoughtSignature: "c2lnXzE=" },
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

    const result = await runGeminiStreamResult({
      model: buildGeminiModel({
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
      }),
      context: {
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as Parameters<ReturnType<typeof createGoogleGenerativeAiTransportStreamFn>>[1],
      options: { reasoning: "high" },
    });

    expect(result.content).toEqual([
      { type: "thinking", thinking: "draft", thinkingSignature: "c2lnXzE=" },
      { type: "text", text: "answer" },
    ]);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
