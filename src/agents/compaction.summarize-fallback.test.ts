// Covers final fallback behavior when model-backed summarization fails.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { UserMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionError } from "../../packages/agent-core/src/harness/types.js";
import { summarizeWithFallback } from "./compaction.test-support.js";

const agentSessionMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-sessions")>(
    "openclaw/plugin-sdk/agent-sessions",
  );
  return {
    ...actual,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

const testModel = {
  id: "test",
  name: "test",
  contextWindow: 200_000,
  contextTokens: 200_000,
  maxTokens: 8192,
} as unknown as NonNullable<ExtensionContext["model"]>;

describe("summarizeWithFallback", () => {
  beforeEach(() => {
    agentSessionMocks.generateSummary.mockReset();
    agentSessionMocks.generateSummary.mockRejectedValue(
      new Error("Summarization failed: fetch failed"),
    );
  });

  it("throws CompactionError when all summarization attempts fail", async () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      } satisfies UserMessage,
    ];

    await expect(
      summarizeWithFallback({
        messages,
        model: testModel,
        apiKey: "test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens: 1000,
        maxChunkTokens: 50_000,
        contextWindow: 200_000,
      }),
    ).rejects.toThrow("All summarization attempts failed for 1 messages");
    // "fetch failed" is timeout-classed now, so summarizeChunks does not retry it.
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("retries provider-side AbortError and returns a real summary when caller signal is not aborted", async () => {
    // Reproduce the undici AbortError("This operation was aborted") shape thrown
    // when the LLM API closes the connection mid-stream without the caller signal
    // being fired. Before the fix, isAbortError() + isTimeoutError() both matched
    // this error shape, so shouldRetry returned false and no retry was attempted —
    // the compaction fell back to the "Summary unavailable" placeholder instead.
    const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    agentSessionMocks.generateSummary
      .mockRejectedValueOnce(providerAbortErr)
      .mockResolvedValueOnce("recovered summary after provider disconnect");

    const result = await summarizeWithFallback({
      messages: [
        {
          role: "user",
          content: "hello",
          timestamp: 1,
        } satisfies UserMessage,
      ],
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal, // not aborted
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toBe("recovered summary after provider disconnect");
    // Two calls: first fails with provider-side AbortError, second succeeds.
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("retries a summarization_failed result and persists the recovered summary", async () => {
    agentSessionMocks.generateSummary
      .mockRejectedValueOnce(
        new CompactionError(
          "summarization_failed",
          "Summarization failed: model returned no summary text",
        ),
      )
      .mockResolvedValueOnce("recovered non-empty summary");

    await expect(
      summarizeWithFallback({
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: 1,
          } satisfies UserMessage,
        ],
        model: testModel,
        apiKey: "test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens: 1000,
        maxChunkTokens: 50_000,
        contextWindow: 200_000,
      }),
    ).resolves.toBe("recovered non-empty summary");
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("does not contact the provider when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      summarizeWithFallback({
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: 1,
          } satisfies UserMessage,
        ],
        model: testModel,
        apiKey: "test-key", // pragma: allowlist secret
        signal: controller.signal, // already aborted
        reserveTokens: 1000,
        maxChunkTokens: 50_000,
        contextWindow: 200_000,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(agentSessionMocks.generateSummary).not.toHaveBeenCalled();
  });

  it("stops retry backoff promptly when the caller aborts mid-sleep", async () => {
    // The first attempt fails with a retryable error, then the caller aborts
    // while retryAsync sits in its backoff sleep (>= 500ms minDelay). The
    // sleep must reject on abort instead of riding out the full delay.
    const controller = new AbortController();
    agentSessionMocks.generateSummary.mockRejectedValueOnce(new Error("transient rate limit"));

    const startedAt = Date.now();
    const promise = summarizeWithFallback({
      messages: [
        {
          role: "user",
          content: "hello",
          timestamp: 1,
        } satisfies UserMessage,
      ],
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: controller.signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });
    const rejection = expect(promise).rejects.toThrow("aborted");
    setTimeout(() => controller.abort(), 50);
    await rejection;
    const elapsedMs = Date.now() - startedAt;

    // Well under the 500ms minimum backoff — the abort interrupted the sleep.
    expect(elapsedMs).toBeLessThan(400);
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("throws CompactionError when both full and partial summarization fail", async () => {
    // Oversized-message fallback tries the safe subset so a huge attachment or
    // tool output does not prevent summarizing the rest of the transcript.
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "small",
        timestamp: 1,
      } satisfies UserMessage,
      {
        role: "user",
        content: "x".repeat(500_000),
        timestamp: 2,
      } satisfies UserMessage,
    ];

    let callCount = 0;
    agentSessionMocks.generateSummary.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("full summarization error"));
      }
      return Promise.reject(new Error("partial retry error"));
    });

    await expect(
      summarizeWithFallback({
        messages,
        model: testModel,
        apiKey: "test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens: 1000,
        maxChunkTokens: 50_000,
        contextWindow: 200_000,
      }),
    ).rejects.toThrow(
      "All summarization attempts failed for 2 messages. Last error: partial retry error",
    );
  });
});
