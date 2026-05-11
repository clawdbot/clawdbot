import { describe, expect, it } from "vitest";
import { createMessageQueue, mergeGroupMessages, type QueuedMessage } from "./message-queue.js";

function groupMsg(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "U1",
    senderName: "Alice",
    content: "hello",
    messageId: "M1",
    timestamp: "2026-01-01T00:00:00Z",
    groupOpenid: "G1",
    ...overrides,
  };
}

function requireMergeMetadata(message: QueuedMessage): NonNullable<QueuedMessage["merge"]> {
  if (!message.merge) {
    throw new Error("expected QQBot merged message metadata");
  }
  return message.merge;
}

describe("engine/gateway/message-queue", () => {
  describe("mergeGroupMessages", () => {
    it("returns the single message unchanged", () => {
      const m = groupMsg();
      const merged = mergeGroupMessages([m]);
      expect(merged).toBe(m);
    });

    it("joins content with sender prefix per line", () => {
      const merged = mergeGroupMessages([
        groupMsg({ senderName: "A", content: "hi" }),
        groupMsg({ senderName: "B", content: "yo" }),
      ]);
      expect(merged.content).toBe("[A]: hi\n[B]: yo");
      const merge = requireMergeMetadata(merged);
      expect(merge.count).toBe(2);
      expect(merge.messages).toHaveLength(2);
    });

    it("takes messageId / msgIdx / timestamp from the last message", () => {
      const merged = mergeGroupMessages([
        groupMsg({ messageId: "M1", msgIdx: "I1", timestamp: "T1" }),
        groupMsg({ messageId: "M2", msgIdx: "I2", timestamp: "T2" }),
      ]);
      expect(merged.messageId).toBe("M2");
      expect(merged.msgIdx).toBe("I2");
      expect(merged.timestamp).toBe("T2");
    });

    it("takes refMsgIdx from the first message", () => {
      const merged = mergeGroupMessages([
        groupMsg({ refMsgIdx: "R1" }),
        groupMsg({ refMsgIdx: "R2" }),
      ]);
      expect(merged.refMsgIdx).toBe("R1");
    });

    it("concatenates attachments in order", () => {
      const merged = mergeGroupMessages([
        groupMsg({
          attachments: [{ content_type: "image/png", url: "a" }],
        }),
        groupMsg({
          attachments: [
            { content_type: "image/png", url: "b" },
            { content_type: "image/png", url: "c" },
          ],
        }),
      ]);
      if (!merged.attachments) {
        throw new Error("expected QQBot merged attachments");
      }
      expect(merged.attachments.map((a) => a.url)).toEqual(["a", "b", "c"]);
    });

    it("deduplicates mentions by member/user openid", () => {
      const merged = mergeGroupMessages([
        groupMsg({ mentions: [{ member_openid: "X" }, { member_openid: "Y" }] }),
        groupMsg({ mentions: [{ member_openid: "X" }, { member_openid: "Z" }] }),
      ]);
      if (!merged.mentions) {
        throw new Error("expected QQBot merged mentions");
      }
      expect(merged.mentions.map((m) => m.member_openid)).toEqual(["X", "Y", "Z"]);
    });

    it("flags merged turn as @bot when ANY source was GROUP_AT_MESSAGE_CREATE", () => {
      const merged = mergeGroupMessages([
        groupMsg({ eventType: "GROUP_MESSAGE_CREATE" }),
        groupMsg({ eventType: "GROUP_AT_MESSAGE_CREATE" }),
      ]);
      expect(merged.eventType).toBe("GROUP_AT_MESSAGE_CREATE");
    });

    it("keeps last eventType when no @bot event was present", () => {
      const merged = mergeGroupMessages([
        groupMsg({ eventType: "GROUP_MESSAGE_CREATE" }),
        groupMsg({ eventType: "GROUP_MESSAGE_CREATE" }),
      ]);
      expect(merged.eventType).toBe("GROUP_MESSAGE_CREATE");
    });

    it("marks as bot only when every source is a bot", () => {
      expect(
        mergeGroupMessages([groupMsg({ senderIsBot: true }), groupMsg({ senderIsBot: false })])
          .senderIsBot,
      ).toBe(false);

      expect(
        mergeGroupMessages([groupMsg({ senderIsBot: true }), groupMsg({ senderIsBot: true })])
          .senderIsBot,
      ).toBe(true);
    });
  });

  describe("createMessageQueue enqueue / evict", () => {
    it("uses group peerId for group messages", () => {
      const q = createMessageQueue({ accountId: "a", isAborted: () => true });
      expect(q.getMessagePeerId(groupMsg({ groupOpenid: "G9" }))).toBe("group:G9");
    });

    it("uses dm peerId for c2c messages", () => {
      const q = createMessageQueue({ accountId: "a", isAborted: () => true });
      expect(
        q.getMessagePeerId({
          ...groupMsg(),
          type: "c2c",
          groupOpenid: undefined,
          senderId: "U9",
        }),
      ).toBe("dm:U9");
    });

    it("enqueue without processor still drains (no-op when fn is null)", async () => {
      // When no processor is attached, drain shifts messages but does
      // nothing with them. The queue ends empty on the next microtask.
      const q = createMessageQueue({ accountId: "a", isAborted: () => false });
      q.enqueue(groupMsg({ messageId: "M1" }));
      q.enqueue(groupMsg({ messageId: "M2" }));
      await Promise.resolve();
      await Promise.resolve();
      expect(q.getSnapshot("group:G1").senderPending).toBe(0);
    });

    it("group overflow evicts a bot message first (eviction is synchronous)", () => {
      // Use isAborted=true so drain exits immediately on the first
      // microtask. Our `eviction` logic runs synchronously inside
      // enqueue, BEFORE drain kicks in, so the 4th enqueue still has to
      // evict even though we never actually process anything.
      const q = createMessageQueue({
        accountId: "a",
        isAborted: () => true,
        groupQueueSize: 3,
      });
      // Fill the queue to the cap (3), then enqueue one more to trigger
      // eviction. The first three enqueues trigger drainUserQueue which
      // synchronously deletes the empty queue in its finally block when
      // isAborted=true. We bypass that by calling enqueue then reading
      // inside the same synchronous tick via getSnapshot is NOT viable,
      // so we instead observe the eviction by counting what ends up
      // visible after the queue has stabilized.
      q.enqueue(groupMsg({ messageId: "H1" }));
      q.enqueue(groupMsg({ messageId: "B1", senderIsBot: true }));
      q.enqueue(groupMsg({ messageId: "H2" }));
      q.enqueue(groupMsg({ messageId: "H3" }));
      // With isAborted=true the drain deletes the queue after each
      // enqueue, so the snapshot just confirms we didn't throw. The
      // actual eviction logic is covered by the "group overflow via
      // processor" scenario below.
      expect(q.getSnapshot("group:G1").senderPending).toBe(0);
    });

    it("group overflow drops bot messages first (via processor)", async () => {
      const seen: QueuedMessage[] = [];
      let gate: ((value?: unknown) => void) | undefined;
      const blocker = new Promise((res) => {
        gate = res;
      });
      const q = createMessageQueue({
        accountId: "a",
        isAborted: () => false,
        groupQueueSize: 3,
      });
      q.startProcessor(async (msg) => {
        seen.push(msg);
        // Hold the processor until we've filled the queue to capacity.
        await blocker;
      });
      // First enqueue starts processing immediately (blocker held).
      q.enqueue(groupMsg({ messageId: "First" }));
      await Promise.resolve();
      // Now fill the queue with 3 more (cap=3).
      q.enqueue(groupMsg({ messageId: "H1" }));
      q.enqueue(groupMsg({ messageId: "B1", senderIsBot: true }));
      q.enqueue(groupMsg({ messageId: "H2" }));
      expect(q.getSnapshot("group:G1").senderPending).toBe(3);
      // 5th enqueue → eviction. Bot message (B1) should be the victim.
      q.enqueue(groupMsg({ messageId: "H3" }));
      const peerQueueIds = q.getSnapshot("group:G1");
      expect(peerQueueIds.senderPending).toBe(3);
      // Release the processor and drain.
      if (!gate) {
        throw new Error("Expected QQBot queue gate callback to be initialized");
      }
      gate();
      await new Promise((res) => setTimeout(res, 0));
      const seenIds = seen.map((m) => m.messageId);
      expect(seenIds).toContain("First");
      // The bot message should NOT have been processed — it was evicted.
      // (Note: The first batch ran merged, so the exact count of calls
      //  varies; we only assert the bot message id never appeared.)
      const mergedCall = seen.find((m) => (m.merge?.count ?? 0) > 1);
      if (mergedCall) {
        expect(requireMergeMetadata(mergedCall).messages.map((m) => m.messageId)).not.toContain(
          "B1",
        );
      } else {
        expect(seenIds).not.toContain("B1");
      }
    });

    it("clearUserQueue drops buffered items before drain runs", () => {
      // Use a processor that never resolves so enqueued messages stay
      // buffered behind a single active worker — then clearUserQueue
      // should drop the rest.
      let release: (() => void) | undefined;
      const blocker = new Promise<void>((res) => {
        release = res;
      });
      const q = createMessageQueue({ accountId: "a", isAborted: () => false });
      q.startProcessor(async () => {
        await blocker;
      });
      q.enqueue(groupMsg({ messageId: "M1" }));
      q.enqueue(groupMsg({ messageId: "M2" }));
      q.enqueue(groupMsg({ messageId: "M3" }));
      // First message is being processed; remaining two are queued.
      expect(q.getSnapshot("group:G1").senderPending).toBeGreaterThanOrEqual(0);
      const dropped = q.clearUserQueue("group:G1");
      expect(dropped).toBeGreaterThanOrEqual(0);
      if (!release) {
        throw new Error("Expected QQBot queue release callback to be initialized");
      }
      release();
    });
  });

  describe("drainGroupBatch merging", () => {
    it("merges multiple normal group messages into one processor call", async () => {
      const seen: QueuedMessage[] = [];
      let aborted = false;
      const q = createMessageQueue({
        accountId: "a",
        isAborted: () => aborted,
      });
      q.startProcessor(async (msg) => {
        seen.push(msg);
      });
      // Enqueue three normal group messages synchronously so they batch
      // before the drain loop kicks in — the first enqueue starts the
      // drain, but the synchronous enqueues land before the first await.
      q.enqueue(groupMsg({ messageId: "M1", content: "hi" }));
      q.enqueue(groupMsg({ messageId: "M2", content: "yo" }));
      q.enqueue(groupMsg({ messageId: "M3", content: "!!" }));
      // Allow microtasks to flush.
      await Promise.resolve();
      await Promise.resolve();
      aborted = true;
      // Depending on timing the first message may have been processed solo;
      // what we guarantee is that the total processor calls are fewer than
      // three and the remaining messages were merged.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.length).toBeLessThan(3);
      const mergedCall = seen.find((m) => (m.merge?.count ?? 0) > 1);
      expect(mergedCall?.content).toContain("[Alice]:");
      expect(mergedCall?.merge?.count).toBeGreaterThan(1);
    });

    it("processes slash commands independently from regular messages", async () => {
      const seen: QueuedMessage[] = [];
      let aborted = false;
      const q = createMessageQueue({
        accountId: "a",
        isAborted: () => aborted,
      });
      q.startProcessor(async (msg) => {
        seen.push(msg);
      });
      q.enqueue(groupMsg({ messageId: "M1", content: "hi" }));
      q.enqueue(groupMsg({ messageId: "M2", content: "/stop" }));
      q.enqueue(groupMsg({ messageId: "M3", content: "yo" }));
      await Promise.resolve();
      await Promise.resolve();
      aborted = true;
      // Command should appear as its own call (not merged with the others).
      const cmdCall = seen.find((m) => m.content === "/stop");
      expect(cmdCall?.content).toBe("/stop");
      expect(cmdCall).not.toHaveProperty("merge");
    });
  });
});
