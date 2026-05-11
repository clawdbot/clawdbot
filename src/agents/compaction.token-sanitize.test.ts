import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

const piCodingAgentMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((_message: unknown) => 1),
  generateSummary: vi.fn(async () => "summary"),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    estimateTokens: piCodingAgentMocks.estimateTokens,
    generateSummary: piCodingAgentMocks.generateSummary,
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

    const calledWithDetails = piCodingAgentMocks.estimateTokens.mock.calls.some((call) => {
      const message = call[0] as { details?: unknown } | undefined;
      return Boolean(message?.details);
    });

    expect(calledWithDetails).toBe(false);
  });
});
