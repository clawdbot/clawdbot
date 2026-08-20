import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunGroups, type StreamRunRenderItem } from "./chat-agent-run-grouping.ts";

describe("coalesceAgentRunGroups", () => {
  it("keeps stream text visible when the matching persisted group is tool-only", () => {
    const stream: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:run-1",
      runId: "run-1",
      parts: [
        {
          kind: "stream",
          key: "stream:run-1",
          text: "Working on it.",
          startedAt: 1,
          isStreaming: true,
          runId: "run-1",
        },
      ],
    };
    const tool: MessageGroup = {
      kind: "group",
      key: "group:tool:run-1",
      role: "tool",
      messages: [{ key: "tool:run-1", message: { role: "toolResult", content: "Done" } }],
      timestamp: 2,
      isStreaming: false,
      runId: "run-1",
    };

    expect(coalesceAgentRunGroups([stream, tool])).toEqual([
      expect.objectContaining({
        kind: "group",
        role: "assistant",
        runId: "run-1",
        isStreaming: true,
        messages: [
          expect.objectContaining({
            key: "stream:run-1",
            message: expect.objectContaining({ role: "assistant" }),
          }),
          tool.messages[0],
        ],
      }),
    ]);
  });
});
