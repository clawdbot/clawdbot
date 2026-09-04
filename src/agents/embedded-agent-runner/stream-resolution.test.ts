import type { LlmRuntime } from "@openclaw/ai";
import { defaultLlmRuntime, getApiProvider } from "@openclaw/ai/internal/runtime";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import * as providerTransportStream from "@openclaw/ai/transports";
// Stream resolution tests cover how embedded runs choose provider, boundary,
// native Codex, or custom stream functions and pass auth/cache/signal options.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import { streamSimple } from "../../llm/stream.js";
import type { Model } from "../../llm/types.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import { wrapStreamFnWithProviderPromptState } from "./provider-prompt-state.js";
import {
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentStream as resolveEmbeddedAgentStreamImpl,
} from "./stream-resolution.js";

const streamMocks = vi.hoisted(() => ({
  delegate: undefined as StreamFn | undefined,
  streamSimple: vi.fn(),
  anthropicVertex: vi.fn(),
}));

vi.mock("../anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: streamMocks.anthropicVertex,
}));

vi.mock("../../llm/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/stream.js")>();
  streamMocks.delegate = actual.streamSimple as StreamFn;
  streamMocks.streamSimple.mockImplementation(actual.streamSimple);
  return { ...actual, streamSimple: streamMocks.streamSimple };
});

// Wrap createBoundaryAwareStreamFnForModel with a spy that delegates to the
// real implementation by default so existing routing tests still observe a
// real transport stream; per-test overrideBoundaryAwareStreamFnOnce() injects
// a probe stream when a regression test needs to inspect the wrapped
// transport's options.
vi.mock("@openclaw/ai/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof providerTransportStream>();
  return {
    ...actual,
    createBoundaryAwareStreamFnForModel: vi.fn(actual.createBoundaryAwareStreamFnForModel),
  };
});

const llmRuntime = {
  ...defaultLlmRuntime,
  streamSimple: streamSimple as StreamFn,
} as LlmRuntime;

function resolveEmbeddedAgentStream(
  params: Omit<Parameters<typeof resolveEmbeddedAgentStreamImpl>[0], "llmRuntime">,
) {
  return resolveEmbeddedAgentStreamImpl({ ...params, llmRuntime });
}

const overrideBoundaryAwareStreamFnOnce = (streamFn: StreamFn): void => {
  // Boundary wrapping remains real by default; individual cases replace only
  // the inner stream when they need to inspect forwarded options.
  vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel).mockReturnValueOnce(
    streamFn,
  );
};

function useNativeStreamFn(streamFn: StreamFn): StreamFn {
  streamMocks.streamSimple.mockImplementation(streamFn);
  return streamSimple as StreamFn;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

async function expectStreamResultRecord(
  result: ReturnType<StreamFn>,
  label: string,
): Promise<Record<string, unknown>> {
  return requireRecord(await result, label);
}

afterEach(() => {
  streamMocks.streamSimple.mockReset();
  streamMocks.anthropicVertex.mockReset();
  if (streamMocks.delegate) {
    streamMocks.streamSimple.mockImplementation(streamMocks.delegate);
  }
});

describe("prepared embedded stream strategy", () => {
  it("recovers the lifecycle owner from a prepared session stream", () => {
    bindStreamLlmRuntime(streamSimple, llmRuntime);

    expect(
      resolveEmbeddedAgentStreamImpl({
        sessionId: "session-1",
        currentStreamFn: streamSimple,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }).strategy,
    ).toBe("boundary-aware:openai-responses");
  });

  it("describes provider-owned stream paths explicitly", () => {
    expect(
      resolveEmbeddedAgentStream({
        sessionId: "session-1",
        currentStreamFn: undefined,
        providerStreamFn: vi.fn() as never,
        model: {
          api: "openai-completions",
          provider: "ollama",
          id: "qwen",
        } as never,
      }).strategy,
    ).toBe("provider");
  });

  it("describes default OpenAI fallback shaping", () => {
    expect(
      resolveEmbeddedAgentStream({
        sessionId: "session-1",
        currentStreamFn: undefined,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }).strategy,
    ).toBe("boundary-aware:openai-responses");
  });

  it("describes default Codex fallback as OpenClaw native", () => {
    expect(
      resolveEmbeddedAgentStream({
        sessionId: "session-1",
        currentStreamFn: undefined,
        model: {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "codex-mini-latest",
        } as never,
      }).strategy,
    ).toBe("openclaw-native-codex-responses");
  });

  it("keeps custom session streams labeled as custom", () => {
    expect(
      resolveEmbeddedAgentStream({
        sessionId: "session-1",
        currentStreamFn: vi.fn() as never,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }).strategy,
    ).toBe("session-custom");
  });

  it.each([
    { reason: "runtime auth", provider: "cloudflare-ai-gateway", resolvedApiKey: "runtime-key" },
    { reason: "transport auth", provider: "anthropic", transportAuthAvailable: true },
    { reason: "proxied Anthropic", provider: "cloudflare-ai-gateway" },
  ])("records the selected transport for $reason", async ({ reason: _reason, ...routing }) => {
    const currentStreamFn = vi.fn<StreamFn>();
    const boundaryStreamFn = vi.fn<StreamFn>();
    overrideBoundaryAwareStreamFnOnce(boundaryStreamFn);
    const boundaryFactory = vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel);
    const initialCalls = boundaryFactory.mock.calls.length;
    const params = {
      currentStreamFn,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: routing.provider,
        id: "claude-sonnet-4-6",
      } as never,
      resolvedApiKey: "resolvedApiKey" in routing ? routing.resolvedApiKey : undefined,
      transportAuthAvailable: "transportAuthAvailable" in routing && routing.transportAuthAvailable,
    };
    const { streamFn, strategy } = resolveEmbeddedAgentStream(params);

    expect(strategy).toBe("boundary-aware:anthropic-messages");
    expect(boundaryFactory.mock.calls.slice(initialCalls)).toEqual([[params.model]]);
    await streamFn(params.model, { messages: [] });
    expect(boundaryStreamFn).toHaveBeenCalledTimes(1);
    expect(currentStreamFn).not.toHaveBeenCalled();
  });
});

describe("resolveEmbeddedAgentStream", () => {
  it("preserves sentinels for registered provider streams", async () => {
    const secret = "plugin-stream-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:plugin" });
    const providerStreamFn = vi.fn(async (model, _context, options) => ({ model, options }));
    const model = {
      api: "plugin-api",
      provider: "plugin",
      id: "plugin-model",
      headers: { Authorization: `Bearer ${sentinel}` },
    } as never;
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      providerStreamFn: providerStreamFn as never,
      sessionId: "session-1",
      model,
      resolvedApiKey: sentinel,
    });

    const result = await expectStreamResultRecord(
      streamFn(model, {} as never, {
        headers: { "X-Managed": `Bearer ${sentinel}` },
      }),
      "plugin stream result",
    );
    expect(requireRecord(result.model, "plugin model").headers).toEqual({
      Authorization: `Bearer ${sentinel}`,
    });
    expect(requireRecord(result.options, "plugin options").apiKey).toBe(sentinel);
    expect(requireRecord(result.options, "plugin options").headers).toEqual({
      "X-Managed": `Bearer ${sentinel}`,
    });
  });

  it("prefers the resolved run api key over a later authStorage lookup", async () => {
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };

    await expect(
      resolveEmbeddedAgentApiKey({
        provider: "openai",
        resolvedApiKey: "resolved-key",
        authStorage,
      }),
    ).resolves.toBe("resolved-key");
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
  });

  it("preserves run session identity in boundary-aware OpenAI transports", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
    const options = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.4" } as never, {} as never, {}),
      "boundary-aware OpenAI transport options",
    );
    expect(options.sessionId).toBe("session-1");
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("routes Codex responses fallbacks through OpenClaw native transport", async () => {
    // Codex OAuth models use the OpenClaw native transport, with prompt-cache
    // markers stripped before the harness sees system prompt text.
    const nativeStreamFn = vi.fn(async (_model, context, options) => ({ context, options }));
    useNativeStreamFn(nativeStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "codex-mini-latest",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    expect(streamFn).not.toBe(streamSimple);
    const result = await expectStreamResultRecord(
      streamFn(
        { provider: "openai", id: "codex-mini-latest" } as never,
        { systemPrompt: `intro${SYSTEM_PROMPT_CACHE_BOUNDARY}tail` } as never,
        {},
      ),
      "codex native result",
    );
    expect(requireRecord(result.context, "codex native context").systemPrompt).toBe("intro\ntail");
    expect(requireRecord(result.options, "codex native options").apiKey).toBe("oauth-bearer-token");
    expect(nativeStreamFn).toHaveBeenCalledTimes(1);
  });

  it("keeps real lifecycle-owned Codex sessions on authenticated WebSocket transport", async () => {
    const prompt = "PRIVATE-EMBEDDED-NATIVE-CODEX-PROMPT";
    const tokenHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const tokenPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-session" } }),
    ).toString("base64url");
    const accessToken = `${tokenHeader}.${tokenPayload}.signature`;
    const protectedAccessToken = mintSecretSentinel(accessToken, {
      label: "codex-session-websocket-auth",
    });
    const handshakes: Array<{ url: string; headers: Headers }> = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    const recordEvent = vi.fn();
    let rejectNextConnection = false;
    const fetchSpy = vi.fn(() => {
      throw new Error("explicit WebSocket transport must not issue an HTTP request");
    });

    class SessionWebSocket extends EventTarget {
      readyState = 1;

      constructor(url: string, options?: { headers?: Record<string, string> }) {
        super();
        if (rejectNextConnection) {
          throw new Error("session websocket connection rejected");
        }
        handshakes.push({ url, headers: new Headers(options?.headers) });
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        sentRequests.push(JSON.parse(payload) as Record<string, unknown>);
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_session_websocket",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                },
              }),
            }),
          );
          this.readyState = 3;
        });
      }

      close(): void {
        this.readyState = 3;
      }
    }

    vi.stubGlobal("WebSocket", SessionWebSocket);
    vi.stubGlobal("fetch", fetchSpy);
    const model = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.test/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    } satisfies Model<"openai-chatgpt-responses">;
    // Match createAgentSession's real auth-owning runtime wrapper without importing
    // the complete session/plugin graph into this focused stream-routing suite.
    const resolveSessionAuth = vi.fn(async () => protectedAccessToken);
    const sessionBaseStream: StreamFn = async (sessionModel, context, options) => {
      const apiKey = await resolveSessionAuth();
      return llmRuntime.streamSimple(sessionModel, context, { ...options, apiKey });
    };
    bindStreamLlmRuntime(sessionBaseStream, llmRuntime);
    const boundaryStreamFactory = vi.mocked(
      providerTransportStream.createBoundaryAwareStreamFnForModel,
    );
    const initialBoundaryCalls = boundaryStreamFactory.mock.calls.length;

    try {
      const { streamFn: embeddedStreamFn } = resolveEmbeddedAgentStreamImpl({
        currentStreamFn: sessionBaseStream,
        model,
        sessionId: "session-websocket",
        resolvedApiKey: protectedAccessToken,
      });
      const observedEmbeddedStreamFn = wrapStreamFnWithProviderPromptState({
        streamFn: embeddedStreamFn,
        state: {},
        effectiveContextTokenBudget: 128_000,
        recordEvent,
      });
      expect(boundaryStreamFactory.mock.calls.slice(initialBoundaryCalls)).toEqual([]);
      const stream = await observedEmbeddedStreamFn(
        model,
        {
          systemPrompt: prompt,
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
        { transport: "websocket" },
      );
      const result = await stream.result();

      expect(result.stopReason).toBe("stop");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(boundaryStreamFactory.mock.calls.slice(initialBoundaryCalls)).toEqual([]);
      expect(handshakes).toHaveLength(1);
      expect(handshakes[0]?.url).toBe("wss://chatgpt.test/backend-api/codex/responses");
      expect(handshakes[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(handshakes[0]?.headers.get("chatgpt-account-id")).toBe("acct-session");
      expect(handshakes[0]?.headers.get("openai-beta")).toBe("responses_websockets=2026-02-06");
      expect(handshakes[0]?.headers.get("session_id")).toBe("session-websocket");
      expect(handshakes[0]?.headers.get("x-client-request-id")).toBe("session-websocket");
      expect(sentRequests).toEqual([
        expect.objectContaining({
          type: "response.create",
          model: "gpt-5.5",
          instructions: prompt,
        }),
      ]);
      expect(recordEvent).toHaveBeenCalledWith("provider.prompt.observed", {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      });
      expect(JSON.stringify(recordEvent.mock.calls)).not.toContain(prompt);

      rejectNextConnection = true;
      const rejectedStream = await observedEmbeddedStreamFn(
        model,
        {
          systemPrompt: prompt,
          messages: [{ role: "user", content: "retry", timestamp: 2 }],
        },
        { transport: "websocket", sessionId: "session-websocket-rejected" },
      );
      const rejectedResult = await rejectedStream.result();

      expect(rejectedResult.stopReason).toBe("error");
      expect(rejectedResult.errorMessage).toContain("session websocket connection rejected");
      expect(resolveSessionAuth).toHaveBeenCalledTimes(2);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(boundaryStreamFactory.mock.calls.slice(initialBoundaryCalls)).toEqual([]);
      expect(recordEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["unbound", "different runtime"])(
    "keeps %s custom Codex session streams outside the native lifecycle path",
    (ownership) => {
      const customStream = vi.fn();
      if (ownership === "different runtime") {
        bindStreamLlmRuntime(customStream, { ...llmRuntime } as LlmRuntime);
      }

      const { streamFn } = resolveEmbeddedAgentStream({
        currentStreamFn: customStream as StreamFn,
        sessionId: "custom-session",
        model: {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "gpt-5.5",
        } as never,
      });

      expect(streamFn).toBe(customStream);
    },
  );

  it("routes GitHub Copilot fallbacks through boundary-aware transports", () => {
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("reads refreshed runtime auth for each boundary-aware model call", async () => {
    const firstSentinel = mintSecretSentinel("copilot-runtime-value-1", {
      label: "model-auth:github-copilot:first",
    });
    const secondSentinel = mintSecretSentinel("copilot-runtime-value-2", {
      label: "model-auth:github-copilot:second",
    });
    const getApiKey = vi
      .fn<(provider: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce(firstSentinel)
      .mockResolvedValueOnce(secondSentinel);
    const currentStreamFn = vi.fn(async (_model, _context, options) => options);
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.6-sol",
      } as never,
      transportAuthAvailable: true,
      authStorage: { getApiKey },
    });

    const firstResult = await expectStreamResultRecord(
      streamFn({ provider: "github-copilot", id: "gpt-5.6-sol" } as never, {} as never, {}),
      "first github copilot boundary result",
    );
    const secondResult = await expectStreamResultRecord(
      streamFn({ provider: "github-copilot", id: "gpt-5.6-sol" } as never, {} as never, {}),
      "second github copilot boundary result",
    );
    expect(firstResult.apiKey).toBe(firstSentinel);
    expect(secondResult.apiKey).toBe(secondSentinel);
    expect(currentStreamFn).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledTimes(2);
  });

  it("routes OpenClaw native OpenAI-compatible provider streams through boundary-aware transports", async () => {
    const nativeStreamFn = getApiProvider("openai-completions")?.streamSimple;
    if (!nativeStreamFn) {
      throw new Error("expected native OpenAI-compatible stream function");
    }
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);

    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: nativeStreamFn,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "llama",
        id: "qwen36-35b-a3b",
      } as never,
      resolvedApiKey: "local-token",
    });

    expect(streamFn).not.toBe(nativeStreamFn);
    const result = await expectStreamResultRecord(
      streamFn({ provider: "llama", id: "qwen36-35b-a3b" } as never, {} as never, {}),
      "openai compatible result",
    );
    expect(result.apiKey).toBe("local-token");
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("routes runtime-auth custom session streams for supported APIs through boundary-aware transports", async () => {
    const currentStreamFn = vi.fn(async (_model, _context, options) => options);
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);

    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: "cloudflare-ai-gateway",
        id: "claude-sonnet-4-6",
      } as never,
      resolvedApiKey: "anthropic-runtime-key",
    });

    expect(streamFn).not.toBe(currentStreamFn);
    const result = await expectStreamResultRecord(
      streamFn(
        { provider: "cloudflare-ai-gateway", id: "claude-sonnet-4-6" } as never,
        {} as never,
        {},
      ),
      "runtime auth result",
    );
    expect(result.apiKey).toBe("anthropic-runtime-key");
    expect(currentStreamFn).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("injects the resolved run api key into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
      resolvedApiKey: "resolved-key",
      authStorage,
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.4" } as never, {} as never, {}),
      "provider-owned result",
    );
    expect(result.apiKey).toBe("resolved-key");
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("propagates prompt cache identity separately from the session id", async () => {
    // Cron and shared runs can use a stable prompt cache key while keeping each
    // run's session id distinct for transcripts and aborts.
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
      model: {
        api: "openai-completions",
        provider: "demo-provider",
        id: "demo-model",
      } as never,
    });

    const result = await expectStreamResultRecord(
      streamFn(
        { provider: "demo-provider", id: "demo-model" } as never,
        {} as never,
        { sessionId: "run-session" } as never,
      ),
      "provider-owned prompt cache result",
    );
    expect(result.sessionId).toBe("run-session");
    expect(result.promptCacheKey).toBe("cron-cache-key");
  });

  it("does not overwrite caller-supplied prompt cache identity", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
      model: {
        api: "openai-completions",
        provider: "demo-provider",
        id: "demo-model",
      } as never,
    });

    const result = await expectStreamResultRecord(
      streamFn(
        { provider: "demo-provider", id: "demo-model" } as never,
        {} as never,
        { promptCacheKey: "caller-cache-key" } as never,
      ),
      "provider-owned caller prompt cache result",
    );
    expect(result.promptCacheKey).toBe("caller-cache-key");
  });

  it("propagates prompt cache identity into custom session streams", async () => {
    const currentStreamFn = vi.fn(async (_model, _context, options) => options);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
      model: {
        api: "custom-api",
        provider: "custom-provider",
        id: "custom-model",
      } as never,
    });

    expect(streamFn).not.toBe(currentStreamFn);
    const result = await expectStreamResultRecord(
      streamFn(
        { provider: "custom-provider", id: "custom-model" } as never,
        {} as never,
        { sessionId: "run-session" } as never,
      ),
      "custom prompt cache result",
    );
    expect(result.sessionId).toBe("run-session");
    expect(result.promptCacheKey).toBe("cron-cache-key");
  });

  it.each(["custom", "anthropic-vertex"] as const)(
    "preserves %s stream identity without cache or run cancellation",
    (provider) => {
      const currentStreamFn = vi.fn(async (_model, _context, options) => options);
      if (provider === "anthropic-vertex") {
        streamMocks.anthropicVertex.mockReturnValueOnce(currentStreamFn);
      }
      const { streamFn } = resolveEmbeddedAgentStream({
        currentStreamFn: currentStreamFn as never,
        sessionId: "session-1",
        model: {
          api: provider === "anthropic-vertex" ? "anthropic-messages" : "custom-api",
          provider,
          id: "custom-model",
        } as never,
      });

      expect(streamFn).toBe(currentStreamFn);
    },
  );

  it.each([
    ["custom", "run"],
    ["custom", "caller"],
    ["anthropic-vertex", "run"],
    ["anthropic-vertex", "caller"],
  ] as const)("cancels %s streams when their %s owner aborts", async (provider, signalOwner) => {
    // Attempt transport and compaction both resolve streams through this owner.
    const currentStreamFn = vi.fn(async (_model, _context, options) => options);
    if (provider === "anthropic-vertex") {
      streamMocks.anthropicVertex.mockReturnValueOnce(currentStreamFn);
    }
    const runController = new AbortController();
    const callerController = new AbortController();
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      signal: runController.signal,
      model: {
        api: provider === "anthropic-vertex" ? "anthropic-messages" : "custom-api",
        provider,
        id: "custom-model",
      } as never,
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider, id: "custom-model" } as never, {} as never, {
        signal: callerController.signal,
      }),
      `${provider} composed signal`,
    );
    expect(result.signal).toMatchObject({ aborted: false });

    const abortReason = new Error(`${signalOwner} canceled`);
    (signalOwner === "run" ? runController : callerController).abort(abortReason);
    expect(result.signal).toMatchObject({ aborted: true, reason: abortReason });
  });

  it.each(["run", "caller"] as const)(
    "preserves the single %s abort signal in provider-owned stream functions",
    async (signalOwner) => {
      const providerStreamFn = vi.fn(async (_model, _context, options) => options);
      const signal = new AbortController().signal;
      const { streamFn } = resolveEmbeddedAgentStream({
        currentStreamFn: undefined,
        providerStreamFn,
        sessionId: "session-1",
        signal: signalOwner === "run" ? signal : undefined,
        model: {
          api: "openai-responses",
          provider: "github-copilot",
          id: "gpt-5.4",
        } as never,
        resolvedApiKey: "resolved-key",
      });

      const result = await expectStreamResultRecord(
        streamFn(
          { provider: "github-copilot", id: "gpt-5.4" } as never,
          {} as never,
          signalOwner === "caller" ? { signal } : {},
        ),
        "provider-owned signal result",
      );
      expect(result.signal).toBe(signal);
    },
  );

  it.each([
    { owner: "run", abortBeforeResolve: false },
    { owner: "caller", abortBeforeResolve: false },
    { owner: "run", abortBeforeResolve: true },
    { owner: "caller", abortBeforeResolve: true },
  ])(
    "preserves both provider-owned cancellation sources: $owner ($abortBeforeResolve)",
    async ({ owner, abortBeforeResolve }) => {
      const providerStreamFn = vi.fn(async (_model, _context, options) => options);
      const runController = new AbortController();
      const callerController = new AbortController();
      const abortedController = owner === "run" ? runController : callerController;
      const abortReason = new Error(`${owner} canceled`);
      if (abortBeforeResolve) {
        abortedController.abort(abortReason);
      }
      const { streamFn } = resolveEmbeddedAgentStream({
        currentStreamFn: undefined,
        providerStreamFn,
        sessionId: "session-1",
        signal: runController.signal,
        model: {
          api: "openai-responses",
          provider: "github-copilot",
          id: "gpt-5.4",
        } as never,
      });

      const result = await expectStreamResultRecord(
        streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {
          signal: callerController.signal,
        }),
        "provider-owned explicit signal result",
      );
      if (!abortBeforeResolve) {
        expect(result.signal).toMatchObject({ aborted: false });
        abortedController.abort(abortReason);
      }
      expect(result.signal).toMatchObject({ aborted: true, reason: abortReason });
    },
  );

  it("injects the resolved run api key into the OpenClaw native Codex Responses fallback", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    useNativeStreamFn(nativeStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.5" } as never, {} as never, {}),
      "codex api key result",
    );
    expect(result.apiKey).toBe("oauth-bearer-token");
    expect(nativeStreamFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to authStorage when no resolved api key is available for OpenClaw native fallback", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "stored-bearer-token"),
    };
    useNativeStreamFn(nativeStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.5",
      } as never,
      authStorage,
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.5" } as never, {} as never, {}),
      "codex stored api key result",
    );
    expect(result.apiKey).toBe("stored-bearer-token");
    expect(authStorage.getApiKey).toHaveBeenCalledWith("openai");
  });

  it("forwards the run abort signal into the OpenClaw native fallback when callers omit one", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    useNativeStreamFn(nativeStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.5" } as never, {} as never, {}),
      "codex signal and api key result",
    );
    expect(result.signal).toBe(runSignal);
    expect(result.apiKey).toBe("oauth-bearer-token");
  });

  it.each(["run", "caller"] as const)(
    "cancels the authenticated OpenClaw native fallback when the %s signal aborts",
    async (signalOwner) => {
      const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
      const runController = new AbortController();
      const callerController = new AbortController();
      useNativeStreamFn(nativeStreamFn as never);
      const { streamFn } = resolveEmbeddedAgentStream({
        currentStreamFn: undefined,
        sessionId: "session-1",
        signal: runController.signal,
        model: {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "gpt-5.5",
        } as never,
        resolvedApiKey: "oauth-bearer-token",
      });

      const result = await expectStreamResultRecord(
        streamFn({ provider: "openai", id: "gpt-5.5" } as never, {} as never, {
          signal: callerController.signal,
        }),
        "codex explicit signal result",
      );
      expect(result.signal).toMatchObject({ aborted: false });
      (signalOwner === "run" ? runController : callerController).abort();
      expect(result.signal).toMatchObject({ aborted: true });
    },
  );

  it("forwards the run signal on the sync OpenClaw native fallback path without auth credentials", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    useNativeStreamFn(nativeStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.5",
      } as never,
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.5" } as never, {} as never, {}),
      "codex unauthenticated signal result",
    );
    expect(result.signal).toBe(runSignal);
  });

  it("strips cache boundary markers on the OpenClaw native fallback path", async () => {
    const nativeStreamFn = vi.fn(async (_model, context, _options) => context);
    useNativeStreamFn(nativeStreamFn as never);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    const systemPrompt = `intro${SYSTEM_PROMPT_CACHE_BOUNDARY}tail`;
    const result = await expectStreamResultRecord(
      streamFn({ provider: "openai", id: "gpt-5.5" } as never, { systemPrompt } as never, {}),
      "codex stripped context result",
    );
    expect(result.systemPrompt).toBe("intro\ntail");
  });
});
