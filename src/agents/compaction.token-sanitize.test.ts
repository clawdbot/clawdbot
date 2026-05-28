import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";

const agentSessionMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((_message: unknown) => 1),
  generateSummary: vi.fn(async () => "summary"),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-sessions")>(
    "openclaw/plugin-sdk/agent-sessions",
  );
  return {
    ...actual,
    estimateTokens: agentSessionMocks.estimateTokens,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

import { chunkMessagesByMaxTokens, splitMessagesByTokenShare } from "./compaction.js";

describe("compaction token accounting sanitization", () => {
  it("does not pass toolResult.details into per-message token estimates", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: { raw: "x".repeat(50_000) },
        timestamp: 1,
      } as any,
      {
        role: "user",
        content: "next",
        timestamp: 2,
      },
    ];

    splitMessagesByTokenShare(messages, 2);
    chunkMessagesByMaxTokens(messages, 16);

    const calledWithDetails = agentSessionMocks.estimateTokens.mock.calls.some((call) => {
      const message = call[0] as { details?: unknown } | undefined;
      return Boolean(message?.details);
    });

    expect(calledWithDetails).toBe(false);
  });
});
