import { describe, expect, it, vi } from "vitest";
import { createClickClackAgentProgressPublisher } from "./progress.js";

describe("ClickClack native agent progress", () => {
  it("serializes turn, item, completion, and clear frames", async () => {
    const publishEphemeral = vi.fn().mockResolvedValue(undefined);
    const publisher = createClickClackAgentProgressPublisher({
      client: { publishEphemeral },
      target: { workspaceId: "ws_1", channelId: "chn_1" },
      turnId: "msg_1",
      agentLabel: "Blackbird",
    });

    publisher.start();
    publisher.onItemEvent({
      itemId: "tool_1",
      kind: "tool",
      name: "search",
      progressText: "Searching",
      status: "running",
    });
    publisher.onItemEvent({
      itemId: "tool_1",
      toolCallId: "call_1",
      kind: "tool",
      name: "search",
      progressText: "Done",
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(3);
    expect(publishEphemeral.mock.calls.map(([call]) => call.payload?.seq)).toEqual([1, 2, 3]);
    expect(publishEphemeral.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: "chn_1",
      type: "agent.progress",
      payload: {
        turn_id: "msg_1",
        op: "append",
        line: { id: "turn", text: "Blackbird is responding", status: "running" },
      },
    });
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      op: "finalize",
      line: {
        id: "item:tool_1",
        kind: "tool",
        tool_name: "search",
        text: "🧩 Search: Done",
        status: "completed",
      },
    });
    expect(publishEphemeral.mock.calls[2]?.[0].payload).toMatchObject({
      turn_id: "msg_1",
      op: "clear",
    });
  });

  it("correlates lane-prefixed item ids with their bare tool-call ids", async () => {
    const publishEphemeral = vi.fn().mockResolvedValue(undefined);
    const publisher = createClickClackAgentProgressPublisher({
      client: { publishEphemeral },
      target: { workspaceId: "ws_1", channelId: "chn_1" },
      turnId: "msg_1",
    });

    publisher.start();
    publisher.onItemEvent({
      itemId: "tool:read-1",
      kind: "tool",
      name: "read",
      progressText: "Reading",
    });
    publisher.onItemEvent({
      toolCallId: "read-1",
      kind: "tool",
      name: "read",
      progressText: "Done",
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(3);
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      op: "finalize",
      line: { id: "item:read-1", text: "📖 Read: Done", status: "completed" },
    });
  });

  it("hides command metadata from item-only native progress", async () => {
    const publishEphemeral = vi.fn().mockResolvedValue(undefined);
    const publisher = createClickClackAgentProgressPublisher({
      client: { publishEphemeral },
      target: { workspaceId: "ws_1", channelId: "chn_1" },
      turnId: "msg_1",
    });

    publisher.start();
    publisher.onItemEvent({
      itemId: "tool_1",
      kind: "tool",
      name: "server.exec",
      meta: "echo private-sentinel",
      commandBearing: true,
      phase: "end",
      status: "completed",
    });
    await publisher.finalize();

    expect(JSON.stringify(publishEphemeral.mock.calls)).not.toContain("private-sentinel");
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      line: { text: "🧩 Server.exec" },
    });
  });

  it("does not let a progress transport failure interrupt finalization", async () => {
    const onError = vi.fn();
    const publishEphemeral = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const publisher = createClickClackAgentProgressPublisher({
      client: { publishEphemeral },
      target: { workspaceId: "ws_1", conversationId: "dm_1" },
      turnId: "msg_1",
      onError,
    });

    publisher.start();
    await expect(publisher.finalize()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(publishEphemeral).toHaveBeenCalledTimes(2);
  });

  it("coalesces queued line updates while the transport is in flight", async () => {
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const publishEphemeral = vi
      .fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue(undefined);
    const publisher = createClickClackAgentProgressPublisher({
      client: { publishEphemeral },
      target: { workspaceId: "ws_1", channelId: "chn_1" },
      turnId: "msg_1",
    });

    publisher.start();
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "first" });
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "second" });
    publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "latest" });
    const finalized = publisher.finalize();

    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    releaseFirstRequest();
    await finalized;

    expect(publishEphemeral).toHaveBeenCalledTimes(3);
    expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
      op: "append",
      line: { id: "item:tool_1", text: expect.stringContaining("latest") },
    });
    expect(publishEphemeral.mock.calls[2]?.[0].payload).toMatchObject({ op: "clear" });
  });

  it("publishes streamed line updates at a bounded cadence", async () => {
    vi.useFakeTimers();
    try {
      const publishEphemeral = vi.fn().mockResolvedValue(undefined);
      const publisher = createClickClackAgentProgressPublisher({
        client: { publishEphemeral },
        target: { workspaceId: "ws_1", channelId: "chn_1" },
        turnId: "msg_1",
      });

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "first" });
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "second" });
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "latest" });

      expect(publishEphemeral).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);

      expect(publishEphemeral).toHaveBeenCalledTimes(2);
      expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
        op: "append",
        line: { id: "item:tool_1", text: expect.stringContaining("latest") },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retracts an existing commentary line without replacing it with a placeholder", async () => {
    vi.useFakeTimers();
    try {
      const publishEphemeral = vi.fn().mockResolvedValue(undefined);
      const publisher = createClickClackAgentProgressPublisher({
        client: { publishEphemeral },
        target: { workspaceId: "ws_1", channelId: "chn_1" },
        turnId: "msg_1",
      });

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      publisher.onItemEvent({
        itemId: "preamble_1",
        kind: "preamble",
        progressText: "Temporary note",
      });
      await vi.advanceTimersByTimeAsync(100);
      publisher.onItemEvent({
        itemId: "preamble_1",
        kind: "preamble",
        progressText: "",
      });
      await vi.advanceTimersByTimeAsync(100);
      await publisher.finalize();

      expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({
        op: "append",
        line: { id: "item:preamble_1", text: "Temporary note" },
      });
      expect(publishEphemeral.mock.calls[2]?.[0].payload).toMatchObject({
        op: "update",
        line: { id: "item:preamble_1", text: "" },
      });
      expect(publishEphemeral.mock.calls[3]?.[0].payload).toMatchObject({ op: "clear" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops commentary retracted before its first progress frame is published", async () => {
    vi.useFakeTimers();
    try {
      const publishEphemeral = vi.fn().mockResolvedValue(undefined);
      const publisher = createClickClackAgentProgressPublisher({
        client: { publishEphemeral },
        target: { workspaceId: "ws_1", channelId: "chn_1" },
        turnId: "msg_1",
      });

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      publisher.onItemEvent({
        itemId: "preamble_1",
        kind: "preamble",
        progressText: "Temporary note",
      });
      publisher.onItemEvent({
        itemId: "preamble_1",
        kind: "preamble",
        progressText: "",
      });
      await publisher.finalize();

      expect(publishEphemeral).toHaveBeenCalledTimes(2);
      expect(publishEphemeral.mock.calls[0]?.[0].payload).toMatchObject({
        op: "append",
        line: { id: "turn" },
      });
      expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({ op: "clear" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stalled transport hold turn finalization", async () => {
    vi.useFakeTimers();
    let releaseFirstRequest!: () => void;
    try {
      const firstRequest = new Promise<void>((resolve) => {
        releaseFirstRequest = resolve;
      });
      const publishEphemeral = vi
        .fn()
        .mockImplementationOnce(() => firstRequest)
        .mockResolvedValue(undefined);
      const publisher = createClickClackAgentProgressPublisher({
        client: { publishEphemeral },
        target: { workspaceId: "ws_1", channelId: "chn_1" },
        turnId: "msg_1",
      });

      publisher.start();
      publisher.onItemEvent({ itemId: "tool_1", kind: "tool", progressText: "pending" });
      const finalized = publisher.finalize();
      const onFinalized = vi.fn();
      void finalized.then(onFinalized);

      await vi.advanceTimersByTimeAsync(999);
      expect(onFinalized).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await finalized;

      expect(onFinalized).toHaveBeenCalledOnce();
      expect(publishEphemeral).toHaveBeenCalledTimes(1);

      releaseFirstRequest();
      await vi.advanceTimersByTimeAsync(0);
      expect(publishEphemeral).toHaveBeenCalledTimes(2);
      expect(publishEphemeral.mock.calls[1]?.[0].payload).toMatchObject({ op: "clear" });
    } finally {
      releaseFirstRequest();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
});
