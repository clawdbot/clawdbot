import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentSessionMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((message: { content?: unknown }) => {
    return typeof message.content === "string" && message.content.startsWith("[Chunk") ? 100 : 1000;
  }),
  generateSummary: vi.fn(),
}));

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    estimateTokens: agentSessionMocks.estimateTokens,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

const { summarizeInStages } = await import("./compaction.js");

const testModel = {
  id: "test",
  name: "test",
  contextWindow: 200_000,
  contextTokens: 200_000,
  maxTokens: 8192,
} as unknown as NonNullable<ExtensionContext["model"]>;

function transcript(): AgentMessage[] {
  return Array.from({ length: 6 }, (_unused, index) => ({
    role: "user",
    content: `message-${index + 1}`,
    timestamp: index + 1,
  }));
}

async function summarize() {
  return await summarizeInStages({
    messages: transcript(),
    model: testModel,
    apiKey: "unused",
    signal: new AbortController().signal,
    reserveTokens: 1000,
    maxChunkTokens: 2500,
    contextWindow: 200_000,
    parts: 3,
    minMessagesForSplit: 2,
  });
}

describe("compaction staged summarization failures", () => {
  beforeEach(() => {
    agentSessionMocks.estimateTokens.mockClear();
    agentSessionMocks.generateSummary.mockReset();
  });

  it("throws CompactionError when any chunk summarization fails", async () => {
    agentSessionMocks.generateSummary.mockRejectedValue(new Error("fetch failed"));

    // The first chunk failure propagates as a CompactionError — no
    // circuit-breaker / generic-fallback recovery.
    await expect(summarize()).rejects.toThrow();
  });

  it("completes the merge successfully when all chunks succeed", async () => {
    agentSessionMocks.generateSummary
      .mockResolvedValueOnce("summary of chunk 1")
      .mockResolvedValueOnce("summary of chunk 2")
      .mockResolvedValueOnce("summary of chunk 3")
      .mockResolvedValue("merged: chunk 1 + chunk 2 + chunk 3");

    await expect(summarize()).resolves.toEqual({
      kind: "summary",
      text: expect.stringContaining("merged"),
    });
  });

  it("throws CompactionError when a later chunk fails after earlier successes", async () => {
    agentSessionMocks.generateSummary
      .mockResolvedValueOnce("summary of chunk 1")
      .mockRejectedValue(new Error("fetch failed on chunk 2"));

    // Chunk 2 failure stops the pipeline — no merge attempted.
    await expect(summarize()).rejects.toThrow();
  });
});
