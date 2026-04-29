import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import * as providerTransportStream from "../provider-transport-stream.js";
import {
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

describe("describeEmbeddedAgentStreamStrategy", () => {
  it("describes provider-owned stream paths explicitly", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        providerStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
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
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }),
    ).toBe("boundary-aware:openai-responses");
  });

  it("describes default Codex fallback shaping", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "codex-mini-latest",
        } as never,
      }),
    ).toBe("boundary-aware:openai-codex-responses");
  });

  it("keeps custom session streams labeled as custom", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }),
    ).toBe("session-custom");
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
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("routes Codex responses fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "codex-mini-latest",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("routes GitHub Copilot fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("injects the resolved run api key into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
      resolvedApiKey: "resolved-key",
      authStorage,
    });

    await expect(
      streamFn({ provider: "openai", id: "gpt-5.4" } as never, {} as never, {}),
    ).resolves.toMatchObject({
      apiKey: "resolved-key",
    });
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("forwards the run abort signal into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const signal = new AbortController().signal;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal,
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
      resolvedApiKey: "resolved-key",
    });

    await expect(
      streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {}),
    ).resolves.toMatchObject({
      signal,
    });
  });

  it("does not overwrite an explicit provider-owned stream signal", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
    });

    await expect(
      streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {
        signal: explicitSignal,
      }),
    ).resolves.toMatchObject({
      signal: explicitSignal,
    });
  });

  it("injects the resolved run api key into the boundary-aware Codex Responses fallback", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ apiKey: "oauth-bearer-token" });
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to authStorage when no resolved api key is available for boundary-aware fallback", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "stored-bearer-token"),
    };
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      authStorage,
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ apiKey: "stored-bearer-token" });
    expect(authStorage.getApiKey).toHaveBeenCalledWith("openai-codex");
  });

  it("forwards the run abort signal into the boundary-aware fallback when callers omit one", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ signal: runSignal, apiKey: "oauth-bearer-token" });
  });

  it("does not overwrite an explicit signal on the boundary-aware fallback path", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {
        signal: explicitSignal,
      }),
    ).resolves.toMatchObject({ signal: explicitSignal });
  });

  it("forwards the run signal on the sync boundary-aware fallback path without auth credentials", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ signal: runSignal });
  });

  it("does not strip cache boundary markers on the boundary-aware fallback path", async () => {
    const innerStreamFn = vi.fn(async (_model, context, _options) => context);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    const systemPrompt = "intro<<openclaw-cache-boundary>>tail";
    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, { systemPrompt } as never, {}),
    ).resolves.toMatchObject({ systemPrompt });
  });
});
