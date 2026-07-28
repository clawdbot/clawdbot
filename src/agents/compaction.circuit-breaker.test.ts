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

describe("compaction staged fallback circuit breaker", () => {
  beforeEach(() => {
    agentSessionMocks.estimateTokens.mockClear();
    agentSessionMocks.generateSummary.mockReset();
  });

  it("stops the fallback storm and rejects the incomplete compaction", async () => {
    agentSessionMocks.generateSummary.mockRejectedValue(new Error("fetch failed"));

    await expect(summarize()).rejects.toThrow(
      "Compaction staged summarization stopped after repeated generic fallbacks",
    );

    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("resets after a successful split, completes the merge, and remains degraded", async () => {
    agentSessionMocks.generateSummary
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("middle summary")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("merged summary");

    await expect(summarize()).resolves.toEqual({
      kind: "generic-fallback",
      text: "merged summary",
    });
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(4);
  });

  it("reports a summary when only a later split degraded and the oldest one survived", async () => {
    agentSessionMocks.generateSummary
      .mockResolvedValueOnce("oldest summary")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("newest summary")
      .mockResolvedValueOnce("merged: oldest summary + newest summary");

    // The oldest split carries whatever context the caller needs redistilled, and it
    // made it into the merge. Reporting a fallback here makes callers re-add it.
    await expect(summarize()).resolves.toEqual({
      kind: "summary",
      text: "merged: oldest summary + newest summary",
    });
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(4);
    expect(agentSessionMocks.generateSummary.mock.calls[3]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("oldest summary") }),
      ]),
    );
  });
});
