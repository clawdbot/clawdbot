import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPromptCacheObservation,
  collectPromptCacheToolNames,
  completePromptCacheObservation,
  resetPromptCacheObservabilityForTest,
} from "./prompt-cache-observability.js";

describe("prompt cache observability", () => {
  beforeEach(() => {
    resetPromptCacheObservabilityForTest();
  });

  it("collects trimmed tool names only", () => {
    expect(
      collectPromptCacheToolNames([{ name: " read " }, { name: "" }, {}, { name: "write" }]),
    ).toEqual(["read", "write"]);
  });

  it("tracks cache-relevant changes and reports a real cache-read drop", () => {
    const first = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });

    expect(first.changes).toBeNull();
    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 8_000 },
      }),
    ).toBeNull();

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read", "write"],
    });

    expect(second.changes?.map((change) => change.code)).toEqual([
      "cacheRetention",
      "transport",
      "systemPrompt",
    ]);

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        { code: "cacheRetention", detail: "long -> short" },
        { code: "transport", detail: "sse -> websocket" },
        { code: "systemPrompt", detail: "system prompt digest changed" },
      ],
    });
  });

  it("suppresses cache-break events for small drops", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 5_000 },
    });

    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        usage: { cacheRead: 4_600 },
      }),
    ).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 8_000 },
    });

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["write", "read"],
    });

    expect(second.changes).toBeNull();
  });

  it("tracks recurring prompt-cache affinity across rotating session ids", () => {
    beginPromptCacheObservation({
      sessionId: "isolated-run-1",
      promptCacheKey: "openclaw-cron-stable-cache-key",
      sessionKey: "agent:cron:run:isolated-run-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "isolated-run-1",
      promptCacheKey: "openclaw-cron-stable-cache-key",
      sessionKey: "agent:cron:run:isolated-run-1",
      usage: { cacheRead: 8_000 },
    });

    const nextRun = beginPromptCacheObservation({
      sessionId: "isolated-run-2",
      promptCacheKey: "openclaw-cron-stable-cache-key",
      sessionKey: "agent:cron:run:isolated-run-2",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(nextRun.previousCacheRead).toBe(8_000);
    expect(nextRun.changes).toBeNull();
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    beginPromptCacheObservation({
      sessionId: "session-0",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-0",
      usage: { cacheRead: 8_000 },
    });

    for (let index = 1; index <= 513; index += 1) {
      beginPromptCacheObservation({
        sessionId: `session-${index}`,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        streamStrategy: "boundary-aware:openai-responses",
        systemPrompt: `stable system ${index}`,
        toolNames: ["read"],
      });
    }

    const restarted = beginPromptCacheObservation({
      sessionId: "session-0",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(restarted.previousCacheRead).toBeNull();
    expect(restarted.changes).toBeNull();
  });

  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      usage: { cacheRead: 8_000 },
    });

    beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
      }),
    ).toBeNull();

    const resumed = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
    });

    expect(resumed.previousCacheRead).toBe(8_000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: null,
    });
  });
});
