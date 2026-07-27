// Focused coverage for the persisted `status_changed` durable notification.
//
// `status_changed` is read from transition-time records that `updateCard`
// writes atomically with the status field. These tests pin the transition
// matrix, the no-op guard, subscription scoping, durable cursor behavior,
// retained-history durability, transition-time run/session scope, and
// backward-compatibility with the existing completed/failed/stale notifications.
import { describe, expect, it } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

const BOARD = "default";

describe("workboard status_changed notification", () => {
  it("emits status_changed for todo → ready", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "todo" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.update(card.id, { status: "ready" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status_changed",
      cardId: card.id,
      fromStatus: "todo",
      toStatus: "ready",
      revision: 1,
    });
    expect(events[0]?.message).toContain("todo → ready");
  });

  it("emits status_changed for ready → running", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "ready" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.update(card.id, { status: "running" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "ready", toStatus: "running", revision: 1 });
  });

  it("emits status_changed for running → review", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "running" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.update(card.id, { status: "review" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "running", toStatus: "review", revision: 1 });
  });

  it("emits status_changed for review → done", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "review" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.complete(card.id, { summary: "done" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "review", toStatus: "done", revision: 1 });
  });

  it("emits status_changed for a transition into blocked", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "running" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.block(card.id, { reason: "waiting" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "running", toStatus: "blocked", revision: 1 });
  });

  it("emits status_changed for unblock and increments revision monotonically", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "todo" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.block(card.id, { reason: "waiting" });
    await store.unblock(card.id);
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ fromStatus: "todo", toStatus: "blocked", revision: 1 });
    expect(events[1]).toMatchObject({ fromStatus: "blocked", toStatus: "todo", revision: 2 });
  });

  it("does not emit for a no-op status write or a position-only move", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "ready" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.update(card.id, { status: "ready" });
    await store.update(card.id, { position: 5 });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(0);
  });

  it("card-scoped subscription only sees its own card", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await store.create({ title: "A", status: "todo" });
    const b = await store.create({ title: "B", status: "todo" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: a.id,
      eventKinds: ["status_changed"],
    });
    await store.update(a.id, { status: "ready" });
    await store.update(b.id, { status: "ready" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cardId: a.id, toStatus: "ready" });
  });

  it("board-scoped subscription sees every card on the board and no others", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await store.create({ title: "A", status: "todo", boardId: "planning" });
    const b = await store.create({ title: "B", status: "todo", boardId: "planning" });
    const other = await store.create({ title: "C", status: "todo", boardId: "other" });
    const sub = await store.subscribeNotifications({
      boardId: "planning",
      target: "agent:board-watcher",
      eventKinds: ["status_changed"],
    });
    await store.update(a.id, { status: "ready" });
    await store.update(b.id, { status: "ready" });
    await store.update(other.id, { status: "ready" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    const cardIds = events
      .flatMap((event) => (event.cardId ? [event.cardId] : []))
      .toSorted((left, right) => left.localeCompare(right));
    expect(cardIds).toEqual([a.id, b.id].toSorted((left, right) => left.localeCompare(right)));
    expect(cardIds).not.toContain(other.id);
  });

  it("advances a durable cursor and never redelivers the same transition", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "todo" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.update(card.id, { status: "ready" });
    const first = await store.advanceNotificationEvents({ subscriptionId: sub.id });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ toStatus: "ready" });

    const replay = await store.notificationEvents({ subscriptionId: sub.id });
    expect(replay.events).toHaveLength(0);

    await store.update(card.id, { status: "running" });
    const second = await store.advanceNotificationEvents({ subscriptionId: sub.id });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ fromStatus: "ready", toStatus: "running" });
  });

  it("keeps replay after ordinary card events are trimmed", async () => {
    const memory = createMemoryStore();
    const store = new WorkboardStore(memory);
    const card = await store.create({ title: "T", status: "todo" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["status_changed"],
    });
    await store.update(card.id, { status: "ready" });
    const entry = await memory.lookup(card.id);
    expect(entry?.card.metadata?.statusTransitions).toHaveLength(1);
    if (entry) {
      entry.card.events = [];
      await memory.register(card.id, entry);
    }
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "todo", toStatus: "ready", revision: 1 });
  });

  it("keeps transition-time run and session scope after the card is relinked", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "T",
      status: "todo",
      sessionKey: "agent:old",
      runId: "run-old",
    });
    await store.update(card.id, { status: "ready" });
    await store.update(card.id, { sessionKey: "agent:new", runId: "run-new" });

    const oldSub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      sessionKey: "agent:old",
      runId: "run-old",
      eventKinds: ["status_changed"],
    });
    const newSub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      sessionKey: "agent:new",
      runId: "run-new",
      eventKinds: ["status_changed"],
    });

    const oldEvents = (await store.notificationEvents({ subscriptionId: oldSub.id })).events;
    const newEvents = (await store.notificationEvents({ subscriptionId: newSub.id })).events;
    expect(oldEvents).toHaveLength(1);
    expect(oldEvents[0]).toMatchObject({ sessionKey: "agent:old", runId: "run-old" });
    expect(newEvents).toHaveLength(0);
  });

  it("keeps completed/failed/stale for a no-eventKinds subscription and withholds status_changed", async () => {
    const memory = createMemoryStore();
    const store = new WorkboardStore(memory);

    const done = await store.create({ title: "done", status: "running" });
    const doneSub = await store.subscribeNotifications({ boardId: BOARD, cardId: done.id });
    await store.complete(done.id, { summary: "shipped" });
    const doneEvents = (await store.notificationEvents({ subscriptionId: doneSub.id })).events;
    expect(doneEvents.some((event) => event.kind === "completed")).toBe(true);
    expect(doneEvents.some((event) => event.kind === "status_changed")).toBe(false);

    const blocked = await store.create({ title: "blocked", status: "running" });
    const blockedSub = await store.subscribeNotifications({ boardId: BOARD, cardId: blocked.id });
    await store.block(blocked.id, { reason: "stuck" });
    const blockedEvents = (await store.notificationEvents({ subscriptionId: blockedSub.id }))
      .events;
    expect(blockedEvents.some((event) => event.kind === "failed")).toBe(true);
    expect(blockedEvents.some((event) => event.kind === "status_changed")).toBe(false);

    const staleCard = await store.create({ title: "stale", status: "running" });
    const staleEntry = await memory.lookup(staleCard.id);
    if (staleEntry) {
      staleEntry.card.metadata = {
        ...staleEntry.card.metadata,
        stale: { detectedAt: 1000, reason: "no heartbeat" },
      };
      await memory.register(staleCard.id, staleEntry);
    }
    const staleSub = await store.subscribeNotifications({ boardId: BOARD, cardId: staleCard.id });
    const staleEvents = (await store.notificationEvents({ subscriptionId: staleSub.id })).events;
    expect(staleEvents.some((event) => event.kind === "stale")).toBe(true);
    expect(staleEvents.some((event) => event.kind === "status_changed")).toBe(false);
  });

  it("delivers status_changed alongside completed when the subscriber opts in", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "running" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["completed", "status_changed"],
    });
    await store.complete(card.id, { summary: "shipped" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events.some((event) => event.kind === "completed")).toBe(true);
    expect(
      events.some((event) => event.kind === "status_changed" && event.toStatus === "done"),
    ).toBe(true);
  });

  it("emits exactly one status_changed on a terminal complete transition", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "running" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["completed", "status_changed"],
    });
    await store.complete(card.id, { summary: "shipped" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    const statusChanged = events.filter((event) => event.kind === "status_changed");
    expect(statusChanged).toHaveLength(1);
    expect(statusChanged[0]).toMatchObject({ fromStatus: "running", toStatus: "done" });
    expect(events.filter((event) => event.kind === "completed")).toHaveLength(1);
  });

  it("does not deliver status_changed to a subscriber that only asked for completed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "T", status: "todo" });
    const sub = await store.subscribeNotifications({
      boardId: BOARD,
      cardId: card.id,
      eventKinds: ["completed"],
    });
    await store.update(card.id, { status: "ready" });
    await store.update(card.id, { status: "running" });
    const { events } = await store.notificationEvents({ subscriptionId: sub.id });
    expect(events).toHaveLength(0);
  });
});
