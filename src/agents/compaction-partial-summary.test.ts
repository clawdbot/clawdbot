// Covers partial-summary recovery when compaction chunk summarization fails.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";

const compactionMocks = vi.hoisted(() => {
  function readText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(readText).join("");
    }
    if (value && typeof value === "object") {
      const record = value as { text?: unknown; content?: unknown; arguments?: unknown };
      return `${readText(record.text)}${readText(record.content)}${readText(record.arguments)}`;
    }
    return "";
  }
  return {
    estimateTokens: vi.fn((message: unknown) =>
      Math.max(1, Math.ceil(readText(message).length / 4)),
    ),
    generateSummary: vi.fn(),
    logWarn: vi.fn(),
  };
});

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    estimateTokens: compactionMocks.estimateTokens,
    generateSummary: compactionMocks.generateSummary,
  };
});

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: compactionMocks.logWarn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    raw: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

// Mock retryAsync to bypass retry delays while preserving the single-call semantic.
// summarizeChunks wraps generateSummary in retryAsync with 500-5000 ms delays;
// eliminating them keeps tests fast without altering the catch-block behavior under test.
vi.mock("../infra/retry.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/retry.js")>("../infra/retry.js");
  return {
    ...actual,
    retryAsync: async <T>(fn: () => Promise<T>) => fn(),
  };
});

let summarizeWithFallback: typeof import("./compaction.js").summarizeWithFallback;

beforeAll(async () => {
  vi.resetModules();
  ({ summarizeWithFallback } = await import("./compaction.js"));
});

describe("summarizeChunks partial summary preservation (#82952)", () => {
  const testModel = {
    id: "test",
    name: "test",
    contextWindow: 200_000,
    contextTokens: 200_000,
    maxTokens: 8192,
  } as unknown as NonNullable<ExtensionContext["model"]>;

  // Two messages sized to split into two chunks with maxChunkTokens=150.
  // Each message is ~100 tokens (400 chars / 4), and effectiveMax = floor(150/1.2) = 125.
  const twoChunkMessages: AgentMessage[] = [
    { role: "user", content: "x".repeat(400), timestamp: 1 },
    { role: "user", content: "y".repeat(400), timestamp: 2 },
  ];

  function callSummarize(messages = twoChunkMessages) {
    return summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 150,
      contextWindow: 200_000,
    });
  }

  beforeEach(() => {
    compactionMocks.generateSummary.mockReset();
    compactionMocks.logWarn.mockClear();
  });

  it("returns partial summary when a later chunk fails with a non-abort error", async () => {
    // A completed earlier chunk is useful context; keep it with an explicit
    // partial marker instead of discarding all summarization progress.
    compactionMocks.generateSummary
      .mockResolvedValueOnce("Summary of chunk 1")
      .mockRejectedValue(new Error("API quota exceeded"));

    const result = await callSummarize();

    expect(result).toContain("Summary of chunk 1");
    expect(result).toContain("[Partial summary:");
    expect(result).toMatch(/chunks 1-1 of 2 were summarized/);
    expect(compactionMocks.logWarn).toHaveBeenCalledWith(
      "chunk summarization failed after retries; partial summary available",
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it("re-throws abort errors instead of returning partial summary", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";

    compactionMocks.generateSummary
      .mockResolvedValueOnce("Summary of chunk 1")
      .mockRejectedValue(abortErr);

    const result = await callSummarize();

    // Abort errors represent caller intent, so partial recovery must not mask
    // cancellation as successful summarization.
    expect(result).not.toBe("Summary of chunk 1");
    expect(result).toContain("Context contained");
    expect(compactionMocks.logWarn).not.toHaveBeenCalledWith(
      "chunk summarization failed after retries; partial summary available",
      expect.anything(),
    );
  });

  it("re-throws timeout errors instead of returning partial summary", async () => {
    const timeoutErr = new Error("request timed out");
    timeoutErr.name = "TimeoutError";

    compactionMocks.generateSummary
      .mockResolvedValueOnce("Summary of chunk 1")
      .mockRejectedValue(timeoutErr);

    const result = await callSummarize();

    expect(result).not.toBe("Summary of chunk 1");
    expect(result).toContain("Context contained");
    expect(compactionMocks.logWarn).not.toHaveBeenCalledWith(
      "chunk summarization failed after retries; partial summary available",
      expect.anything(),
    );
  });

  it("returns the full final summary when all chunks succeed", async () => {
    compactionMocks.generateSummary
      .mockResolvedValueOnce("Summary of chunk 1")
      .mockResolvedValueOnce("Combined summary of chunks 1+2");

    const result = await callSummarize();

    expect(result).toBe("Combined summary of chunks 1+2");
    expect(compactionMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("falls back to default when the first chunk fails (no partial to recover)", async () => {
    compactionMocks.generateSummary.mockRejectedValue(new Error("network error"));

    const result = await callSummarize();

    // With no successful chunk, summarizeChunks rethrows into
    // summarizeWithFallback's outer catch -> final fallback path.
    expect(result).toContain("Context contained");
    expect(result).not.toBe("Summary of chunk 1");
  });

  it("tries oversized-message retry before falling back to partial summary", async () => {
    // Scenario: chunk 1 (small) succeeds, chunk 2 (has oversized message) fails.
    // summarizeWithFallback should try the non-oversized retry, which may
    // recover more content than the partial summary alone.
    const mixedMessages: AgentMessage[] = [
      // Small message (chunk 1)
      { role: "user", content: "Short question about code", timestamp: 1 },
      // Oversized message (will be in chunk 2, triggers the oversized retry)
      { role: "assistant", content: "x".repeat(500_000), timestamp: 2 } as unknown as AgentMessage,
      // Small message after oversized (should be recovered by oversized retry)
      { role: "user", content: "Follow-up question", timestamp: 3 },
    ];

    compactionMocks.generateSummary
      // Call 1: chunk 1 of full attempt (success)
      .mockResolvedValueOnce("Summary of chunk 1")
      // Call 2: chunk 2 of full attempt (fails - oversized message)
      .mockRejectedValueOnce(new Error("context too long"))
      // Call 3: oversized retry with small messages only (succeeds!)
      .mockResolvedValueOnce("Summary of small messages (oversized retry)");

    const result = await callSummarize(mixedMessages);

    // The oversized retry should have recovered more content than the partial
    // summary from chunk 1 alone.
    expect(result).toContain("Summary of small messages (oversized retry)");
    // The partial summary should NOT be the final result because the
    // oversized retry succeeded.
    expect(result).not.toContain("[Partial summary:");
  });

  it("prefers oversized retry partial summary over full attempt partial", async () => {
    // Scenario: full attempt's chunk 1 succeeds, chunk 2 (oversized) fails.
    // Oversized retry (small messages only) chunk 1 succeeds, chunk 2 fails.
    // The oversized retry's partial summary should be preferred because it
    // covers the non-oversized transcript.
    const mixedMessages: AgentMessage[] = [
      { role: "user", content: "Short question", timestamp: 1 },
      // Oversized message that will be filtered in the retry
      { role: "assistant", content: "x".repeat(500_000), timestamp: 2 } as unknown as AgentMessage,
      { role: "user", content: "a".repeat(400), timestamp: 3 },
      { role: "user", content: "b".repeat(400), timestamp: 4 },
    ];

    // The retry excludes oversized messages and can produce a better partial
    // summary than the original attempt, so fallback ordering matters.
    compactionMocks.generateSummary
      // Full attempt: chunk 1 succeeds, chunk 2 fails (oversized message)
      .mockResolvedValueOnce("Full attempt chunk 1")
      .mockRejectedValueOnce(new Error("context too long"))
      // Oversized retry: chunk 1 succeeds, chunk 2 also fails
      .mockResolvedValueOnce("Oversized retry chunk 1 (better coverage)")
      .mockRejectedValue(new Error("rate limited on retry"));

    const result = await callSummarize(mixedMessages);

    // The oversized retry's partial summary should win, with oversized notes
    expect(result).toContain("Oversized retry chunk 1 (better coverage)");
    expect(result).toContain("[Partial summary:");
    expect(result).toContain("[Large assistant");
    expect(result).toContain("omitted from summary]");
  });

  it("preserves the latest successful summary in a 3+ chunk chain", async () => {
    const threeChunkMessages: AgentMessage[] = [
      { role: "user", content: "a".repeat(400), timestamp: 1 },
      { role: "user", content: "b".repeat(400), timestamp: 2 },
      { role: "user", content: "c".repeat(400), timestamp: 3 },
    ];

    compactionMocks.generateSummary
      .mockResolvedValueOnce("Summary after chunk 1")
      .mockResolvedValueOnce("Summary after chunks 1+2")
      .mockRejectedValue(new Error("rate limited"));

    const result = await callSummarize(threeChunkMessages);

    // Chunk 3 failed -> partial summary from chunk 2 is returned with marker.
    expect(result).toContain("Summary after chunks 1+2");
    expect(result).toMatch(/\[Partial summary: chunks 1-2 of 3 were summarized/);
    expect(compactionMocks.generateSummary).toHaveBeenCalledTimes(3);
    expect(compactionMocks.logWarn).toHaveBeenCalledWith(
      "chunk summarization failed after retries; partial summary available",
      expect.objectContaining({ completedChunks: 2, totalChunks: 3 }),
    );
  });
});
