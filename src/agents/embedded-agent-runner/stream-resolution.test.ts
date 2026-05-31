import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiProvider } from "../../llm/api-registry.js";
import { streamSimple } from "../../llm/stream.js";
import * as providerTransportStream from "../provider-transport-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../system-prompt-cache-boundary.js";
import {
  testing,
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";

// Wrap createBoundaryAwareStreamFnForModel with a spy that delegates to the
// real implementation by default so existing routing tests still observe a
// real transport stream; per-test overrideBoundaryAwareStreamFnOnce() injects
// a probe stream when a regression test needs to inspect the wrapped
// transport's options.
vi.mock("../provider-transport-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof providerTransportStream>();
  return {
    ...actual,
    createBoundaryAwareStreamFnForModel: vi.fn(actual.createBoundaryAwareStreamFnForModel),
  };
});

const overrideBoundaryAwareStreamFnOnce = (streamFn: StreamFn): void => {
  vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel).mockReturnValueOnce(
    streamFn,
  );
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

async function expectStreamResultRecord(
  result: ReturnType<StreamFn>,
  label: string,
): Promise<Record<string, unknown>> {
  return requireRecord(await result, label);
}

afterEach(() => {
  testing.resetOpenClawNativeCodexResponsesStreamFnForTest();
});

describe("describeEmbeddedAgentStreamStrategy", () => {
  it("describes provider-owned stream paths explicitly", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        providerStreamFn: vi.fn() as never,
        model: {
          api: "openai-completions",
          provider: "ollama",
          id: "qwen",
        } as never,
      }),
    ).toBe("provider");
  });

  it("describes default OpenAI fallback shaping", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }),
    ).toBe("boundary-aware:openai-responses");
  });

  it("describes default Codex fallback as OpenClaw native", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        model: {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "codex-mini-latest",
        } as never,
      }),
    ).toBe("openclaw-native-codex-responses");
  });

  it("keeps custom session streams labeled as custom", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }),
    ).toBe("session-custom");
  });

  it("describes runtime-auth custom session streams as boundary-aware", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        model: {
          api: "anthropic-messages",
          provider: "cloudflare-ai-gateway",
          id: "claude-sonnet-4-6",
        } as never,
        resolvedApiKey: "runtime-key",
      }),
    ).toBe("boundary-aware:anthropic-messages");
  });
});

describe("resolveEmbeddedAgentStreamFn", () => {
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

  it("still routes supported streamSimple fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("routes Codex responses fallbacks through OpenClaw native transport", async () => {
    const nativeStreamFn = vi.fn(async (_model, context, options) => ({ context, options }));
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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

  it("routes GitHub Copilot fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
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

  it("routes OpenClaw native OpenAI-compatible provider streams through boundary-aware transports", async () => {
    const nativeStreamFn = getApiProvider("openai-completions")?.streamSimple;
    if (!nativeStreamFn) {
      throw new Error("expected native OpenAI-compatible stream function");
    }
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);

    const streamFn = resolveEmbeddedAgentStreamFn({
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

    const streamFn = resolveEmbeddedAgentStreamFn({
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
    const streamFn = resolveEmbeddedAgentStreamFn({
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
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const streamFn = resolveEmbeddedAgentStreamFn({
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
    const streamFn = resolveEmbeddedAgentStreamFn({
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
    const streamFn = resolveEmbeddedAgentStreamFn({
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

  it("forwards the run abort signal into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const signal = new AbortController().signal;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      signal,
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
      resolvedApiKey: "resolved-key",
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {}),
      "provider-owned signal result",
    );
    expect(result.signal).toBe(signal);
  });

  it("does not overwrite an explicit provider-owned stream signal", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
    });

    const result = await expectStreamResultRecord(
      streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {
        signal: explicitSignal,
      }),
      "provider-owned explicit signal result",
    );
    expect(result.signal).toBe(explicitSignal);
  });

  it("injects the resolved run api key into the OpenClaw native Codex Responses fallback", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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

  it("does not overwrite an explicit signal on the OpenClaw native fallback path", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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
      streamFn({ provider: "openai", id: "gpt-5.5" } as never, {} as never, {
        signal: explicitSignal,
      }),
      "codex explicit signal result",
    );
    expect(result.signal).toBe(explicitSignal);
  });

  it("forwards the run signal on the sync OpenClaw native fallback path without auth credentials", async () => {
    const nativeStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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
    testing.setOpenClawNativeCodexResponsesStreamFnForTest(nativeStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
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
