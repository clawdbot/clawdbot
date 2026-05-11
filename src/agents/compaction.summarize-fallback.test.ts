import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeWithFallback } from "./compaction.js";

const piCodingAgentMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
  estimateTokens: vi.fn((_message: unknown) => 100),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    generateSummary: piCodingAgentMocks.generateSummary,
    estimateTokens: piCodingAgentMocks.estimateTokens,
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
    piCodingAgentMocks.generateSummary.mockReset();
    piCodingAgentMocks.generateSummary.mockRejectedValue(
      new Error("Summarization failed: fetch failed"),
    );
    piCodingAgentMocks.estimateTokens.mockReset();
    piCodingAgentMocks.estimateTokens.mockImplementation(() => 100);
  });

  it("does not duplicate summarization when no messages were oversized", async () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      } satisfies UserMessage,
    ];

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toContain("Context contained 1 messages");
    expect(result).toContain("0 oversized");
    // "fetch failed" is timeout-classed now, so summarizeChunks does not retry it.
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("still attempts partial summarization when oversized messages were excluded", async () => {
    piCodingAgentMocks.estimateTokens.mockImplementation((message: unknown) => {
      const content =
        typeof (message as { content?: unknown }).content === "string"
          ? (message as { content: string }).content
          : "";
      return content.length > 10_000 ? 500_000 : 100;
    });

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

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toContain("2 messages (1 oversized)");
    // Full attempt plus distinct partial transcript; timeout-classed failures do not retry.
    expect(piCodingAgentMocks.generateSummary.mock.calls.length).toBe(2);
  });
});
