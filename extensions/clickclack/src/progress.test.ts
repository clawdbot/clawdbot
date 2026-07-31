import { describe, expect, it, vi } from "vitest";
import { createClickClackAgentProgressPublisher } from "./progress.js";

describe("ClickClack native agent progress", () => {
  it("serializes turn, item, completion, and clear frames", async () => {
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
        line: { id: "turn", text: "Agent is responding", status: "running" },
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
});
