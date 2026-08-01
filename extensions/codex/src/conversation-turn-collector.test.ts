// Codex tests cover conversation turn collector plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexConversationTurnTimeoutError,
  createCodexConversationTurnCollector,
} from "./conversation-turn-collector.js";

describe("codex conversation turn collector", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it("buffers pre-start notifications and replays only the selected turn", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-stale",
          status: "completed",
          items: [{ type: "agentMessage", id: "wrong", text: "stale answer" }],
        },
      },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "right", delta: "fresh " },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "right", text: "fresh answer" }],
        },
      },
    });

    collector.setTurnId("turn-1");

    await expect(collector.wait({ timeoutMs: 1_000 })).resolves.toEqual({
      replyText: "fresh answer",
    });
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

  it("ignores unscoped deltas once the active turn is known", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", itemId: "wrong", delta: "wrong" },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "right", delta: "right" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("does not complete from unscoped turn completion once the active turn is known", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "completed",
          items: [{ type: "agentMessage", id: "wrong", text: "wrong" }],
        },
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "right", text: "right" }],
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

  it("does not classify a provider failure with the local timeout message as a local timeout", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "codex app-server bound turn timed out" },
          items: [],
        },
      },
    });

    await expect(completion).rejects.toThrow("codex app-server bound turn timed out");
    await expect(completion).rejects.not.toBeInstanceOf(CodexConversationTurnTimeoutError);
  });

  it("rejects interrupted turns instead of returning streamed partial text", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "unfinished answer",
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
      },
    });

    await expect(completion).rejects.toThrow("codex app-server turn interrupted");
  });

  it("confirms a terminal notification that arrives after the bound turn times out", async () => {
    vi.useFakeTimers();
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 100 });
    const timedOut = expect(completion).rejects.toBeInstanceOf(CodexConversationTurnTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await timedOut;

    const terminal = collector.waitForTerminal({ timeoutMs: 5_000 });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
      },
    });

    await expect(terminal).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when an acknowledged interrupted turn never reaches terminal state", async () => {
    vi.useFakeTimers();
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const terminal = collector.waitForTerminal({ timeoutMs: 5_000 });
    const assertion = expect(terminal).rejects.toThrow(
      "codex app-server interrupted turn did not complete",
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an interrupted turn buffered before its turn id is known", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
      },
    });
    collector.setTurnId("turn-1");

    await expect(collector.wait({ timeoutMs: 1_000 })).rejects.toThrow(
      "codex app-server turn interrupted",
    );
  });

  it("times out when the app-server never completes the turn", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      const completion = collector.wait({ timeoutMs: 100 });
      const assertion = expect(completion).rejects.toThrow("codex app-server bound turn timed out");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      await expect(completion).rejects.toBeInstanceOf(CodexConversationTurnTimeoutError);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("clamps oversized turn wait timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      collector.setTurnId("turn-1");
      const completion = collector.wait({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1 });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      collector.handleNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });

      await expect(completion).resolves.toEqual({ replyText: "" });
    } finally {
      vi.restoreAllMocks();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
