import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { UserMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeWithFallback } from "./compaction.js";

const agentSessionMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
  estimateTokens: vi.fn((_message: unknown) => 100),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-sessions")>(
    "openclaw/plugin-sdk/agent-sessions",
  );
  return {
    ...actual,
    generateSummary: agentSessionMocks.generateSummary,
    estimateTokens: agentSessionMocks.estimateTokens,
  };
});

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    generateSummary: agentSessionMocks.generateSummary,
    estimateTokens: agentSessionMocks.estimateTokens,
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
    agentSessionMocks.estimateTokens.mockReset();
    agentSessionMocks.estimateTokens.mockImplementation(() => 100);
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
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("still attempts partial summarization when oversized messages were excluded", async () => {
    agentSessionMocks.estimateTokens.mockImplementation((message: unknown) => {
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
    expect(agentSessionMocks.generateSummary.mock.calls.length).toBe(2);
  });
});
