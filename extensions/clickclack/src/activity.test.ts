// Tests for the durable ClickClack agent-activity publisher (coalescing rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickClackActivityPublisher } from "./activity.js";
import type { ClickClackMessage } from "./types.js";

type ActivityClient = Parameters<typeof createClickClackActivityPublisher>[0]["client"];

function createClientMock(): {
  client: ActivityClient;
  createActivityMessage: ReturnType<typeof vi.fn>;
  updateMessageBody: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  const createActivityMessage = vi.fn(async () => {
    counter += 1;
    return { id: `msg_${counter}` } as ClickClackMessage;
  });
  const updateMessageBody = vi.fn(async () => ({}) as ClickClackMessage);
  return {
    client: { createActivityMessage, updateMessageBody } as ActivityClient,
    createActivityMessage,
    updateMessageBody,
  };
}

describe("createClickClackActivityPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces cumulative commentary snapshots into one POST per segment", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "Looking at" });
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "Looking at the repo" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage).toHaveBeenCalledWith({
      channelId: "chn_1",
      conversationId: undefined,
      body: "Looking at the repo",
      kind: "agent_commentary",
      turnId: "msg_turn",
    });
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("PATCHes the commentary row when the snapshot grows after a debounce flush", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      flushMs: 10,
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First" });
    await vi.advanceTimersByTimeAsync(20);
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First and second" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith("msg_1", "First and second");
  });

  it("skips redundant PATCHes for identical or stale-shorter commentary snapshots", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      flushMs: 10,
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First and second" });
    await vi.advanceTimersByTimeAsync(20);
    // Identical snapshot and a stale shorter frame must not queue new flushes.
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First and second" });
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("opens a new durable row for each commentary segment (item id)", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { conversationId: "dcn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "before tool" });
    publisher.onItemEvent({ itemId: "c2", kind: "preamble", progressText: "after tool" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(2);
    const bodies = createActivityMessage.mock.calls.map(
      (call) => (call[0] as { body: string }).body,
    );
    expect(bodies).toEqual(["before tool", "after tool"]);
  });

  it("dedupes lane-prefixed tool frames into one row and upgrades on longer bodies", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    // The runtime emits one opaque toolCallId across all frames of a call;
    // the lane prefix (tool:/command:) lives on itemId only.
    publisher.onItemEvent({
      itemId: "tool:toolu_1",
      toolCallId: "toolu_1",
      kind: "tool",
      name: "exec",
    });
    await publisher.finalize();
    publisher.onItemEvent({
      itemId: "command:toolu_1",
      toolCallId: "toolu_1",
      kind: "command",
      name: "exec",
      progressText: "ls -la",
    });
    // A shorter late echo must never clobber the richer body.
    publisher.onItemEvent({ toolCallId: "toolu_1", kind: "tool", name: "exec" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "agent_tool",
      body: "🛠️ Exec",
    });
    expect(updateMessageBody).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith("msg_1", "🛠️ ls -la");
  });

  it("posts the upgraded body directly when frames land before the first POST runs", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ toolCallId: "toolu_1", kind: "tool", name: "exec" });
    publisher.onItemEvent({
      toolCallId: "toolu_1",
      kind: "tool",
      name: "exec",
      progressText: "ls -la",
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "agent_tool",
      body: "🛠️ ls -la",
    });
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("renders non-tool item kinds as commentary rows and skips lifecycle lanes", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ itemId: "p1", kind: "plan", title: "Plan", summary: "step one" });
    publisher.onItemEvent({ itemId: "life1", kind: "lifecycle", progressText: "internal state" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "agent_commentary",
      body: "step one",
    });
  });

  it("normalizes reasoning-style progress lanes into durable commentary rows", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      flushMs: 10,
    });

    publisher.onItemEvent({ itemId: "empty1", kind: "thinking", progressText: " " });
    publisher.onItemEvent({
      itemId: "think1",
      kind: "thinking",
      progressText: "Checking the runtime",
    });
    await vi.advanceTimersByTimeAsync(20);
    publisher.onItemEvent({
      itemId: "think1",
      kind: "thinking",
      progressText: "Checking the runtime and recent rows",
    });
    publisher.onItemEvent({
      itemId: "reason1",
      kind: "reasoning",
      progressText: "Comparing provider lanes",
    });
    publisher.onItemEvent({
      itemId: "analysis1",
      kind: "analysis",
      summary: "Mapping this to ClickClack",
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(3);
    expect(createActivityMessage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        body: "**Thinking**\n\nChecking the runtime",
        kind: "agent_commentary",
      }),
      expect.objectContaining({
        body: "**Thinking**\n\nComparing provider lanes",
        kind: "agent_commentary",
      }),
      expect.objectContaining({
        body: "**Thinking**\n\nMapping this to ClickClack",
        kind: "agent_commentary",
      }),
    ]);
    expect(updateMessageBody).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith(
      "msg_1",
      "**Thinking**\n\nChecking the runtime and recent rows",
    );
  });

  it("reports transport failures through onError without rejecting finalize", async () => {
    const onError = vi.fn();
    const createActivityMessage = vi.fn(async () => {
      throw new Error("boom");
    });
    const updateMessageBody = vi.fn(async () => ({}) as ClickClackMessage);
    const publisher = createClickClackActivityPublisher({
      client: { createActivityMessage, updateMessageBody } as ActivityClient,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      onError,
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "streaming" });
    await expect(publisher.finalize()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stamps resolved provenance onto rows posted after setProvenance", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.setProvenance({ model: "anthropic/claude-opus-4-8", thinking: "low" });
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "working on it" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "working on it",
        kind: "agent_commentary",
        provenance: { model: "anthropic/claude-opus-4-8", thinking: "low" },
      }),
    );
  });
});
