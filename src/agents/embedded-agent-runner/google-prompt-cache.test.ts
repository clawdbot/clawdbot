// Coverage for Google prompt-cache creation, reuse, and request rewriting.
import crypto from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { mintSecretSentinel, resolveSecretSentinel } from "../../secrets/sentinel.js";
import { prepareGooglePromptCacheStreamFn } from "./google-prompt-cache.js";
import { EmbeddedAttemptSessionTakeoverError } from "./run/attempt.session-lock.js";

type SessionCustomEntry = {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data: unknown;
};

type TestGooglePromptCacheSessionManager = {
  appendCustomEntry(customType: string, data: unknown): void | Promise<void>;
  getEntries(): SessionCustomEntry[];
};

function makeSessionManager(entries: SessionCustomEntry[] = []) {
  // Prompt-cache metadata is persisted as custom session entries, so the test
  // manager preserves append order and timestamps like SessionManager does.
  let counter = 0;
  return {
    appendCustomEntry(customType: string, data: unknown) {
      counter += 1;
      const id = `entry-${counter}`;
      entries.push({
        type: "custom",
        id,
        parentId: null,
        timestamp: new Date(counter * 1_000).toISOString(),
        customType,
        data,
      });
    },
    getEntries() {
      return entries;
    },
  };
}

function makeGoogleModel(id = "gemini-3.1-pro-preview") {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    headers: { "X-Provider": "google" },
  } satisfies Model<"google-generative-ai">;
}

function createCacheFetchMock(params: { name: string; expireTime: string }) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(params), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

// Builds a 200-OK response whose body streams more than 1 MiB with no
// Content-Length, mirroring a buggy/hostile Google cachedContents endpoint.
// The shared byte-cap reader must cancel the body before fully buffering it.
function createOversizedJsonResponse(): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(async () => undefined);
  let pullCount = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        // First chunk already exceeds the 1 MiB cap so the reader truncates
        // and cancels instead of waiting for the (never-ending) rest.
        controller.enqueue(new Uint8Array(pullCount === 1 ? 1024 * 1024 + 1 : 1));
      },
      cancel,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
  return { response, cancel };
}

function createCapturingStreamFn(result = "stream") {
  // The wrapper mutates payloads through onPayload before calling the real
  // stream; capture that final payload instead of mocking Google responses.
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn = vi.fn(
    (
      model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      const payload: Record<string, unknown> = {};
      void options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return result as never;
    },
  );
  return {
    streamFn,
    getCapturedPayload: () => capturedPayload,
  };
}

function callArg(mock: { mock: { calls: unknown[][] } }, callIndex: number, argIndex: number) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function fetchInit(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0): RequestInit {
  const init = callArg(fetchMock, callIndex, 1);
  if (!init || typeof init !== "object") {
    throw new Error(`expected fetch init for call ${callIndex}`);
  }
  return init as RequestInit;
}

function fetchUrl(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0): string {
  return String(callArg(fetchMock, callIndex, 0));
}

function streamContext(streamFn: { mock: { calls: unknown[][] } }, callIndex = 0) {
  return callArg(streamFn, callIndex, 1) as {
    systemPrompt?: unknown;
    tools?: unknown;
  };
}

function streamOptions(streamFn: { mock: { calls: unknown[][] } }, callIndex = 0) {
  return callArg(streamFn, callIndex, 2) as Record<string, unknown>;
}

function preparePromptCacheStream(params: {
  apiKey?: string;
  fetchMock: ReturnType<typeof vi.fn>;
  now: number;
  sessionManager: TestGooglePromptCacheSessionManager;
  streamFn: StreamFn;
}) {
  // Keep provider/model/cache-retention constants centralized so individual
  // tests can focus on cache lifecycle behavior.
  return prepareGooglePromptCacheStreamFn(
    {
      apiKey: params.apiKey ?? "gemini-api-key",
      extraParams: { cacheRetention: "long" },
      model: makeGoogleModel(),
      modelId: "gemini-3.1-pro-preview",
      provider: "google",
      sessionManager: params.sessionManager,
      streamFn: params.streamFn,
      systemPrompt: "Follow policy.",
    },
    {
      buildGuardedFetch: () => params.fetchMock as typeof fetch,
      now: () => params.now,
    },
  );
}

describe("google prompt cache", () => {
  it("parses sentinel-backed OAuth JSON before guarded cache egress", async () => {
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/oauth-cache",
      expireTime: new Date(2_000_000).toISOString(),
    });
    const { streamFn } = createCapturingStreamFn();
    const oauthJson = JSON.stringify({ token: "google-oauth-token", projectId: "demo" });
    const sentinel = mintSecretSentinel(oauthJson, { label: "model-auth:google" });
    const wrapped = await preparePromptCacheStream({
      apiKey: sentinel,
      fetchMock,
      now: 1_000_000,
      sessionManager: makeSessionManager([]),
      streamFn,
    });

    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    const headers = fetchInit(fetchMock).headers as Record<string, string>;
    expect(
      resolveSecretSentinel(
        expectDefined(headers.Authorization, "headers.Authorization test invariant"),
      ),
    ).toBe("Bearer google-oauth-token");
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("registers parsed OAuth headers when sentinels are disabled", async () => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/oauth-cache",
      expireTime: new Date(2_000_000).toISOString(),
    });
    const { streamFn } = createCapturingStreamFn();
    const oauthJson = JSON.stringify({ token: "google-kill-switch-token", projectId: "demo" });
    const apiKey = mintSecretSentinel(oauthJson, { label: "model-auth:google" });

    try {
      const wrapped = await preparePromptCacheStream({
        apiKey,
        fetchMock,
        now: 1_000_000,
        sessionManager: makeSessionManager([]),
        streamFn,
      });
      await Promise.resolve(
        wrapped?.(
          makeGoogleModel(),
          { systemPrompt: "Follow policy.", messages: [] } as never,
          {} as never,
        ),
      );

      const headers = fetchInit(fetchMock).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer google-kill-switch-token");
      expect(
        isSecretValueRegisteredForRedaction(
          expectDefined(headers.Authorization, "headers.Authorization test invariant"),
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates cached content from the system prompt and strips that prompt from live requests", async () => {
    // Cached system prompts should move out of live request context and into the
    // cachedContent option to avoid paying prompt tokens repeatedly.
    const now = 1_000_000;
    const expireTime = new Date(now + 3_600_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-1",
      expireTime,
    });
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    expect(wrapped).toBeTypeOf("function");
    expect(fetchMock).not.toHaveBeenCalled();
    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        {
          systemPrompt: "Follow policy.",
          messages: [],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: { type: "object" },
            },
          ],
        } as never,
        { temperature: 0.2, toolChoice: "auto" } as never,
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArg(fetchMock, 0, 0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
    );
    const createInit = fetchInit(fetchMock);
    expect(createInit.method).toBe("POST");
    const createHeaders = createInit.headers as Record<string, string>;
    expect(createHeaders["x-goog-api-key"]).toBe("gemini-api-key");
    expect(createHeaders["x-goog-api-client"]).toMatch(/^openclaw\//u);
    expect(createHeaders["X-Provider"]).toBe("google");
    expect(typeof createInit.body).toBe("string");
    const createBody = JSON.parse(createInit.body as string) as Record<string, unknown>;
    expect(createBody).toEqual({
      model: "models/gemini-3.1-pro-preview",
      ttl: "3600s",
      systemInstruction: {
        parts: [{ text: "Follow policy." }],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "Look up a value",
              parametersJsonSchema: { type: "object" },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    });
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(innerStreamFn).systemPrompt).toBeUndefined();
    expect(streamContext(innerStreamFn).tools).toBeUndefined();
    expect(streamOptions(innerStreamFn).temperature).toBe(0.2);
    expect(streamOptions(innerStreamFn).toolChoice).toBe("auto");
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/system-cache-1");
    expect(entries).toEqual([
      {
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: new Date(1_000).toISOString(),
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "ready",
          timestamp: now,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheConfigDigest: expect.any(String),
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-1",
          expireTime,
        },
      },
    ]);
  });

  it("cancels failed cache creation response bodies", async () => {
    const now = 1_500_000;
    const response = new Response("permission denied", { status: 403 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchMock = vi.fn(async () => response);
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const innerStreamFn = vi.fn(() => "stream" as never);

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(innerStreamFn).systemPrompt).toBe("Follow policy.");
    expect(entries[0]?.data).toMatchObject({
      status: "failed",
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
    });
  });

  it("reuses a persisted cache entry without creating a second cache", async () => {
    const now = 2_000_000;
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-2",
      expireTime: new Date(now + 3_600_000).toISOString(),
    });

    const firstWrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: vi.fn(() => "first" as never),
    });
    await Promise.resolve(
      firstWrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    fetchMock.mockClear();
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn("second");
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: now + 30_000,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(innerStreamFn).systemPrompt).toBeUndefined();
    expect(typeof streamOptions(innerStreamFn)).toBe("object");
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/system-cache-2");
  });

  it("propagates session takeover errors from cache entry persistence", async () => {
    const now = 2_500_000;
    const takeoverError = new EmbeddedAttemptSessionTakeoverError("/tmp/session.jsonl");
    const sessionManager = {
      appendCustomEntry: vi.fn(async () => {
        throw takeoverError;
      }),
      getEntries: vi.fn(() => []),
    };
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-takeover",
      expireTime: new Date(now + 3_600_000).toISOString(),
    });
    const innerStreamFn = vi.fn(() => "stream" as never);

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await expect(
      Promise.resolve(
        wrapped?.(
          makeGoogleModel(),
          { systemPrompt: "Follow policy.", messages: [] } as never,
          {} as never,
        ),
      ),
    ).rejects.toBe(takeoverError);
    expect(innerStreamFn).not.toHaveBeenCalled();
  });

  it("refreshes an about-to-expire cache entry instead of creating a new one", async () => {
    const now = 3_000_000;
    const expireSoon = new Date(now + 60_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager([
      {
        id: "entry-1",
        parentId: null,
        timestamp: new Date(now - 5_000).toISOString(),
        type: "custom",
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "ready",
          timestamp: now - 5_000,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-3",
          expireTime: expireSoon,
        },
      },
    ]);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-3",
      expireTime: new Date(now + 3_600_000).toISOString(),
    });
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/system-cache-3?updateMask=ttl",
    );
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(innerStreamFn).systemPrompt).toBeUndefined();
    expect(typeof streamOptions(innerStreamFn)).toBe("object");
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/system-cache-3");
  });

  it("cancels failed cache refresh response bodies", async () => {
    const now = 3_500_000;
    const expireSoon = new Date(now + 60_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const entries: SessionCustomEntry[] = [
      {
        id: "entry-1",
        parentId: null,
        timestamp: new Date(now - 5_000).toISOString(),
        type: "custom",
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "ready",
          timestamp: now - 5_000,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-4",
          expireTime: expireSoon,
        },
      },
    ];
    const response = new Response("refresh denied", { status: 403 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchMock = vi.fn(async () => response);
    const sessionManager = makeSessionManager(entries);
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/system-cache-4");
  });

  it("does not bypass failed-cache backoff when the process clock is invalid", async () => {
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager([
      {
        id: "entry-1",
        parentId: null,
        timestamp: new Date(1_000).toISOString(),
        type: "custom",
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "failed",
          timestamp: 1_000,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheRetention: "long",
          retryAfter: Date.parse("2030-01-01T00:00:00.000Z"),
        },
      },
    ]);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-invalid-clock",
      expireTime: "2030-01-01T00:00:00.000Z",
    });
    const innerStreamFn = vi.fn(() => "stream" as never);

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: Number.NaN,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way when cachedContent is already configured explicitly", async () => {
    const fetchMock = vi.fn();

    const wrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: {
          cacheRetention: "long",
          cachedContent: "cachedContents/already-set",
        },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager: makeSessionManager(),
        streamFn: vi.fn(() => "stream" as never),
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => 0,
      },
    );

    expect(wrapped).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds an oversized cache-creation response body instead of buffering it", async () => {
    const now = 4_000_000;
    const { response, cancel } = createOversizedJsonResponse();
    const fetchMock = vi.fn(async () => response);
    const sessionManager = makeSessionManager();
    const innerStreamFn = vi.fn(() => "stream" as never);

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    await expect(
      Promise.resolve(
        wrapped?.(
          makeGoogleModel(),
          { systemPrompt: "Follow policy.", messages: [] } as never,
          {} as never,
        ),
      ),
    ).rejects.toThrow(/Google prompt cache response too large: \d+ bytes/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArg(fetchMock, 0, 0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds an oversized cache-refresh response body instead of buffering it", async () => {
    const now = 4_500_000;
    const expireSoon = new Date(now + 60_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager([
      {
        id: "entry-1",
        parentId: null,
        timestamp: new Date(now - 5_000).toISOString(),
        type: "custom",
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "ready",
          timestamp: now - 5_000,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-overflow",
          expireTime: expireSoon,
        },
      },
    ]);
    const { response, cancel } = createOversizedJsonResponse();
    const fetchMock = vi.fn(async () => response);
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    // The TTL-refresh read swallows errors (.catch(() => null)) and falls back
    // to the still-valid cached content, so the oversized body must be cancelled
    // by the byte cap rather than fully buffered.
    await Promise.resolve(
      wrapped?.(
        makeGoogleModel(),
        { systemPrompt: "Follow policy.", messages: [] } as never,
        {} as never,
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/system-cache-overflow?updateMask=ttl",
    );
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(cancel).toHaveBeenCalledOnce();
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/system-cache-overflow");
  });
});
