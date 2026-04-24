import { describe, expect, it, vi } from "vitest";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";

describe("codex conversation turn collector", () => {
  it("collects streamed assistant deltas for the active turn", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello " },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "world" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "hello world" });
  });

  it("uses completed agent message items when deltas are absent", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text: "final answer" },
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "final answer" });
  });

  it("ignores notifications for other threads or turns", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", turnId: "turn-1", itemId: "wrong", delta: "wrong" },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-2", itemId: "wrong", delta: "wrong" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "item-1", text: "right" }],
        },
      },
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("rejects failed turns with the app-server error message", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "model exploded" }, items: [] },
      },
    });

    await expect(completion).rejects.toThrow("model exploded");
  });

  it("times out when the app-server never completes the turn", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      const completion = collector.wait({ timeoutMs: 100 });
      const assertion = expect(completion).rejects.toThrow("codex app-server bound turn timed out");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
