import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "../infra/retry.js";

// Mock the external generateSummary function
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof piCodingAgent>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    generateSummary: vi.fn(),
  };
});

const mockGenerateSummary = vi.mocked(piCodingAgent.generateSummary);
type MockGenerateSummaryCompat = (
  currentMessages: AgentMessage[],
  model: NonNullable<ExtensionContext["model"]>,
  reserveTokens: number,
  apiKey: string,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
) => Promise<string>;
const mockGenerateSummaryCompat = mockGenerateSummary as unknown as MockGenerateSummaryCompat;

describe("compaction retry integration", () => {
  beforeEach(() => {
    mockGenerateSummary.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const testMessages: AgentMessage[] = [
    {
      role: "user",
      content: "Test message",
      timestamp: 1,
    } satisfies UserMessage,
    {
      role: "assistant",
      content: [{ type: "text", text: "Test response" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    } satisfies AssistantMessage,
  ];

  const testModel = {
    provider: "anthropic",
    model: "claude-3-opus",
  } as unknown as NonNullable<ExtensionContext["model"]>;

  const invokeGenerateSummary = (signal = new AbortController().signal) =>
    mockGenerateSummaryCompat(testMessages, testModel, 1000, "test-api-key", undefined, signal);

  const runSummaryRetry = (options: Parameters<typeof retryAsync>[1]) =>
    retryAsync(() => invokeGenerateSummary(), options);

  it("should successfully call generateSummary with retry wrapper", async () => {
    mockGenerateSummary.mockResolvedValueOnce("Test summary");

    const result = await runSummaryRetry({
      attempts: 3,
      minDelayMs: 500,
      maxDelayMs: 5000,
      jitter: 0.2,
      label: "compaction/generateSummary",
    });

    expect(result).toBe("Test summary");
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
  });

  it("should retry on transient error and succeed", async () => {
    mockGenerateSummary
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValueOnce("Success after retry");

    const result = await runSummaryRetry({
      attempts: 3,
      minDelayMs: 0,
      maxDelayMs: 0,
      label: "compaction/generateSummary",
    });

    expect(result).toBe("Success after retry");
    expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
  });

  it("should NOT retry on user abort", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    (abortErr as { cause?: unknown }).cause = { source: "user" };

    mockGenerateSummary.mockRejectedValueOnce(abortErr);

    await expect(
      retryAsync(() => invokeGenerateSummary(), {
        attempts: 3,
        minDelayMs: 0,
        label: "compaction/generateSummary",
        shouldRetry: (err: unknown) => !(err instanceof Error && err.name === "AbortError"),
      }),
    ).rejects.toThrow("aborted");

    // Should NOT retry on user cancellation (AbortError filtered by shouldRetry)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
  });

  it("should retry up to 3 times and then fail", async () => {
    mockGenerateSummary.mockRejectedValue(new Error("Persistent API error"));

    await expect(
      runSummaryRetry({
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 0,
        label: "compaction/generateSummary",
      }),
    ).rejects.toThrow("Persistent API error");

    expect(mockGenerateSummary).toHaveBeenCalledTimes(3);
  });

  it("should apply exponential backoff", async () => {
    vi.useFakeTimers();

    mockGenerateSummary
      .mockRejectedValueOnce(new Error("Error 1"))
      .mockRejectedValueOnce(new Error("Error 2"))
      .mockResolvedValueOnce("Success on 3rd attempt");

    const delays: number[] = [];
    const promise = runSummaryRetry({
      attempts: 3,
      minDelayMs: 500,
      maxDelayMs: 5000,
      jitter: 0,
      label: "compaction/generateSummary",
      onRetry: (info) => delays.push(info.delayMs),
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("Success on 3rd attempt");
    expect(mockGenerateSummary).toHaveBeenCalledTimes(3);
    // First retry: 500ms, second retry: 1000ms
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(1000);

    vi.useRealTimers();
  });
});
