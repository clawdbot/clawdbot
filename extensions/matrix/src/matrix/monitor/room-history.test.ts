/**
 * Unit tests for createRoomHistoryTracker.
 *
 * Covers correctness properties that are hard to observe through the handler harness:
 * - Monotone watermark advancement (out-of-order consumeHistory must not regress)
 * - roomQueues FIFO eviction when the room count exceeds the cap
 */

import { describe, expect, it } from "vitest";
import { createRoomHistoryTracker } from "./room-history.js";

const ROOM = "!room:test";
const AGENT = "agent_a";

function entry(body: string) {
  return { sender: "user", body };
}

describe("createRoomHistoryTracker — watermark monotonicity", () => {
  it("consumeHistory is monotone: out-of-order completion does not regress the watermark", () => {
    const tracker = createRoomHistoryTracker();

    // Queue: [msg1, msg2, trigger1, msg3, trigger2]
    tracker.recordPending(ROOM, entry("msg1"));
    tracker.recordPending(ROOM, entry("msg2"));
    const snap1 = tracker.prepareTrigger(AGENT, ROOM, 100, entry("trigger1"));
    tracker.recordPending(ROOM, entry("msg3"));
    const snap2 = tracker.prepareTrigger(AGENT, ROOM, 100, entry("trigger2"));

    // trigger2 completes first (higher index)
    tracker.consumeHistory(AGENT, ROOM, snap2);

    // trigger1 completes later (lower index) — must NOT regress to 3
    tracker.consumeHistory(AGENT, ROOM, snap1);

    // A later production trigger sees only content added after the higher watermark.
    tracker.recordPending(ROOM, entry("msg4"));
    const snap3 = tracker.prepareTrigger(AGENT, ROOM, 100, entry("trigger3"));
    expect(snap3.history.map((entryValue) => entryValue.body)).toEqual(["msg4"]);
  });

  it("prepareTrigger reuses the original history window for a retried event", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, { sender: "user", body: "msg1", messageId: "$m1" });
    const first = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "trigger",
      messageId: "$trigger",
    });

    tracker.recordPending(ROOM, { sender: "user", body: "msg2", messageId: "$m2" });
    const retried = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "trigger",
      messageId: "$trigger",
    });

    expect(first.history.map((entryValue) => entryValue.body)).toEqual(["msg1"]);
    expect(retried.history.map((entryLocal) => entryLocal.body)).toEqual(["msg1"]);
    expect(retried.snapshotIdx).toBe(first.snapshotIdx);
  });

  it("reserved triggers keep their arrival-order history window", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, { sender: "user", body: "before", messageId: "$before" });
    const reserved = tracker.reservePending(AGENT, ROOM, {
      sender: "user",
      body: "audio placeholder",
      messageId: "$audio",
    });
    tracker.recordPending(ROOM, { sender: "user", body: "after", messageId: "$after" });

    const prepared = tracker.prepareReservedTrigger(AGENT, ROOM, 100, reserved, {
      sender: "user",
      body: "audio trigger",
      messageId: "$audio",
    });

    expect(prepared.history.map((entryValue) => entryValue.body)).toEqual(["before"]);
    tracker.consumeHistory(AGENT, ROOM, prepared, "$audio");
    const followUp = tracker.prepareTrigger(AGENT, ROOM, 100, entry("follow up"));
    expect(followUp.history.map((entryValue) => entryValue.body)).toEqual(["after"]);
  });

  it("reserved pending slots are finalized in arrival order", () => {
    const tracker = createRoomHistoryTracker();

    const reserved = tracker.reservePending(AGENT, ROOM, {
      sender: "user",
      body: "audio placeholder",
      messageId: "$audio",
    });
    tracker.recordPending(ROOM, { sender: "user", body: "after", messageId: "$after" });
    tracker.finalizePending(ROOM, reserved, {
      sender: "user",
      body: "audio final",
      messageId: "$audio",
    });

    const prepared = tracker.prepareTrigger(AGENT, ROOM, 100, entry("trigger"));
    expect(prepared.history.map((entryValue) => entryValue.body)).toEqual(["audio final", "after"]);
  });

  it("discarded reserved slots do not leak into later history", () => {
    const tracker = createRoomHistoryTracker();

    const reserved = tracker.reservePending(AGENT, ROOM, {
      sender: "blocked",
      body: "blocked audio",
      messageId: "$blocked",
    });
    tracker.discardPending(ROOM, reserved);
    tracker.recordPending(ROOM, { sender: "user", body: "after", messageId: "$after" });

    const prepared = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "trigger",
      messageId: "$trigger",
    });

    expect(prepared.history.map((entryValue) => entryValue.body)).toEqual(["after"]);
  });

  it("reserved triggers use the arrival-time watermark even if a later trigger consumes history", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, { sender: "user", body: "before", messageId: "$before" });
    const reserved = tracker.reservePending(AGENT, ROOM, {
      sender: "user",
      body: "audio placeholder",
      messageId: "$audio",
    });
    const later = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "later trigger",
      messageId: "$later",
    });
    tracker.consumeHistory(AGENT, ROOM, later, "$later");

    const prepared = tracker.prepareReservedTrigger(AGENT, ROOM, 100, reserved, {
      sender: "user",
      body: "audio trigger",
      messageId: "$audio",
    });

    expect(prepared.history.map((entryValue) => entryValue.body)).toEqual(["before"]);
  });

  it("does not let later triggers consume unfinalized reserved slots", () => {
    const tracker = createRoomHistoryTracker();

    const reserved = tracker.reservePending(AGENT, ROOM, {
      sender: "user",
      body: "audio placeholder",
      messageId: "$audio",
    });
    const later = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "later trigger",
      messageId: "$later",
    });
    tracker.consumeHistory(AGENT, ROOM, later, "$later");
    tracker.finalizePending(ROOM, reserved, {
      sender: "user",
      body: "audio transcript",
      messageId: "$audio",
    });

    const followUp = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "follow up",
      messageId: "$follow-up",
    });

    expect(followUp.history.map((entryValue) => entryValue.body)).toEqual(["audio transcript"]);
  });

  it("reserved trigger retries discard the extra placeholder slot", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, { sender: "user", body: "before", messageId: "$before" });
    const firstReserved = tracker.reservePending(AGENT, ROOM, {
      sender: "user",
      body: "audio placeholder",
      messageId: "$audio",
    });
    const firstPrepared = tracker.prepareReservedTrigger(AGENT, ROOM, 100, firstReserved, {
      sender: "user",
      body: "audio trigger",
      messageId: "$audio",
    });

    const retryReserved = tracker.reservePending(AGENT, ROOM, {
      sender: "user",
      body: "audio placeholder retry",
      messageId: "$audio",
    });
    const retried = tracker.prepareReservedTrigger(AGENT, ROOM, 100, retryReserved, {
      sender: "user",
      body: "audio trigger",
      messageId: "$audio",
    });
    tracker.consumeHistory(AGENT, ROOM, retried, "$audio");

    expect(retried.snapshotIdx).toBe(firstPrepared.snapshotIdx);
    const followUp = tracker.prepareTrigger(AGENT, ROOM, 100, entry("follow up"));
    expect(followUp.history).toHaveLength(0);
  });

  it("keeps main-room and thread histories isolated", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, entry("main-1"));
    tracker.recordPending(ROOM, entry("thread-1"), "$thread");
    tracker.recordPending(ROOM, entry("main-2"));

    const mainPrepared = tracker.prepareTrigger(AGENT, ROOM, 100, entry("main-trigger"));
    const threadPrepared = tracker.prepareTrigger(
      AGENT,
      ROOM,
      100,
      entry("thread-trigger"),
      "$thread",
    );

    expect(mainPrepared.history.map((entryValue) => entryValue.body)).toEqual(["main-1", "main-2"]);
    expect(threadPrepared.history.map((entryValue) => entryValue.body)).toEqual(["thread-1"]);
  });

  it("advances watermarks independently per thread", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, entry("thread-a-1"), "$thread-a");
    tracker.recordPending(ROOM, entry("thread-b-1"), "$thread-b");
    const snapA = tracker.prepareTrigger(AGENT, ROOM, 100, entry("trigger-a"), "$thread-a");
    tracker.consumeHistory(AGENT, ROOM, snapA, undefined, "$thread-a");

    const followUpA = tracker.prepareTrigger(AGENT, ROOM, 100, entry("follow-up-a"), "$thread-a");
    const followUpB = tracker.prepareTrigger(AGENT, ROOM, 100, entry("follow-up-b"), "$thread-b");
    expect(followUpA.history).toHaveLength(0);
    expect(followUpB.history.map((entryValue) => entryValue.body)).toEqual(["thread-b-1"]);
  });

  it("reserved thread triggers keep the thread arrival-order history window", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, entry("main-before"));
    tracker.recordPending(ROOM, entry("thread-before"), "$thread");
    const reserved = tracker.reservePending(
      AGENT,
      ROOM,
      {
        sender: "user",
        body: "audio placeholder",
        messageId: "$audio",
      },
      "$thread",
    );
    tracker.recordPending(ROOM, entry("thread-after"), "$thread");
    tracker.recordPending(ROOM, entry("main-after"));

    const prepared = tracker.prepareReservedTrigger(
      AGENT,
      ROOM,
      100,
      reserved,
      {
        sender: "user",
        body: "audio trigger",
        messageId: "$audio",
      },
      "$thread",
    );

    expect(prepared.history.map((entryValue) => entryValue.body)).toEqual(["thread-before"]);
  });

  it("refreshes watermark recency before capped-map eviction", () => {
    const tracker = createRoomHistoryTracker(200, 10, 2);
    const room1 = "!room1:test";
    const room2 = "!room2:test";
    const room3 = "!room3:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const snap1 = tracker.prepareTrigger(AGENT, room1, 100, entry("trigger in room1"));
    tracker.consumeHistory(AGENT, room1, snap1);

    tracker.recordPending(room2, entry("old msg in room2"));
    const snap2 = tracker.prepareTrigger(AGENT, room2, 100, entry("trigger in room2"));
    tracker.consumeHistory(AGENT, room2, snap2);

    // Refresh room1 so room2 becomes the stalest watermark entry.
    tracker.consumeHistory(AGENT, room1, snap1);

    tracker.recordPending(room3, entry("old msg in room3"));
    const snap3 = tracker.prepareTrigger(AGENT, room3, 100, entry("trigger in room3"));
    tracker.consumeHistory(AGENT, room3, snap3);

    tracker.recordPending(room1, entry("new msg in room1"));
    const room1History = tracker.prepareTrigger(AGENT, room1, 100, entry("next trigger")).history;
    expect(room1History).toHaveLength(1);
    expect(room1History[0]?.body).toBe("new msg in room1");
  });

  it("refreshes prepared-trigger recency before capped eviction on retry hits", () => {
    const tracker = createRoomHistoryTracker(200, 10, 5000, 2);
    const room1 = "!room1:test";

    tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger1",
      messageId: "$trigger1",
    });
    tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger2",
      messageId: "$trigger2",
    });

    // Retry hit should refresh trigger1 so trigger2 becomes the stale entry.
    const retried = tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger1",
      messageId: "$trigger1",
    });
    tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger3",
      messageId: "$trigger3",
    });

    const reused = tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger1",
      messageId: "$trigger1",
    });
    expect(reused.snapshotIdx).toBe(retried.snapshotIdx);
  });
});

describe("createRoomHistoryTracker — roomQueues eviction", () => {
  it("evicts the oldest room (FIFO) when the room count exceeds the cap", () => {
    const tracker = createRoomHistoryTracker(200, 3);

    const room1 = "!room1:test";
    const room2 = "!room2:test";
    const room3 = "!room3:test";
    const room4 = "!room4:test";

    tracker.recordPending(room1, entry("msg in room1"));
    tracker.recordPending(room2, entry("msg in room2"));
    tracker.recordPending(room3, entry("msg in room3"));

    // room4 pushes count to 4 > cap=3 → room1 (oldest) evicted
    tracker.recordPending(room4, entry("msg in room4"));
    expect(tracker.prepareTrigger(AGENT, room2, 100, entry("trigger room2")).history).toHaveLength(
      1,
    );
    expect(tracker.prepareTrigger(AGENT, room3, 100, entry("trigger room3")).history).toHaveLength(
      1,
    );
    expect(tracker.prepareTrigger(AGENT, room4, 100, entry("trigger room4")).history).toHaveLength(
      1,
    );
    expect(tracker.prepareTrigger(AGENT, room1, 100, entry("trigger room1")).history).toHaveLength(
      0,
    );
  });

  it("re-accessing an evicted room starts a fresh empty queue", () => {
    const tracker = createRoomHistoryTracker(200, 2);

    const room1 = "!room1:test";
    const room2 = "!room2:test";
    const room3 = "!room3:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    tracker.recordPending(room2, entry("msg in room2"));
    tracker.recordPending(room3, entry("msg in room3")); // evicts room1

    tracker.recordPending(room1, entry("new msg in room1"));
    const history = tracker.prepareTrigger(AGENT, room1, 100, entry("trigger")).history;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });

  it("clears stale room watermarks when an evicted room is recreated", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const room1 = "!room1:test";
    const room2 = "!room2:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const firstSnapshot = tracker.prepareTrigger(AGENT, room1, 100, entry("trigger in room1"));
    tracker.consumeHistory(AGENT, room1, firstSnapshot);

    // room2 creation evicts room1 (maxRoomQueues=1)
    tracker.recordPending(room2, entry("msg in room2"));

    // Recreate room1 and add fresh content.
    tracker.recordPending(room1, entry("new msg in room1"));
    const history = tracker.prepareTrigger(AGENT, room1, 100, entry("new trigger")).history;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });

  it("ignores late consumeHistory calls after the room queue was evicted", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const room1 = "!room1:test";
    const room2 = "!room2:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const prepared = tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger in room1",
      messageId: "$trigger",
    });

    // room2 creation evicts room1 (maxRoomQueues=1) while the trigger is still in flight.
    tracker.recordPending(room2, entry("msg in room2"));

    // Late completion for the evicted room must not recreate a stale watermark.
    tracker.consumeHistory(AGENT, room1, prepared, "$trigger");

    // Recreate room1 and add fresh content.
    tracker.recordPending(room1, entry("new msg in room1"));
    const history = tracker.prepareTrigger(AGENT, room1, 100, entry("new trigger")).history;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });

  it("rejects stale snapshots after the room queue is recreated", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const room1 = "!room1:test";
    const room2 = "!room2:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const staleSnapshot = tracker.prepareTrigger(AGENT, room1, 100, entry("trigger in room1"));

    tracker.recordPending(room2, entry("msg in room2")); // evicts room1
    tracker.recordPending(room1, entry("new msg in room1")); // recreates room1 with new generation

    tracker.consumeHistory(AGENT, room1, staleSnapshot);

    const history = tracker.prepareTrigger(AGENT, room1, 100, entry("new trigger")).history;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });

  it("preserves newer watermarks when an older snapshot finishes after room recreation", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const room1 = "!room1:test";
    const room2 = "!room2:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const staleSnapshot = tracker.prepareTrigger(AGENT, room1, 100, entry("old trigger in room1"));

    tracker.recordPending(room2, entry("msg in room2")); // evicts room1

    tracker.recordPending(room1, entry("new msg in room1"));
    const freshSnapshot = tracker.prepareTrigger(AGENT, room1, 100, entry("new trigger in room1"));
    tracker.consumeHistory(AGENT, room1, freshSnapshot);

    // Late completion from the old generation must be ignored and must not clear the
    // watermark already written by the newer trigger.
    tracker.consumeHistory(AGENT, room1, staleSnapshot);

    tracker.recordPending(room1, entry("fresh msg after consume"));

    const history = tracker.prepareTrigger(AGENT, room1, 100, entry("latest trigger")).history;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("fresh msg after consume");
  });
});
