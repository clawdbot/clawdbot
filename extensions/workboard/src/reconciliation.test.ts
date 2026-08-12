// Workboard reconciliation tests cover the external scanner facade.
import { describe, expect, it } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardReconciler } from "./reconciliation.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("WorkboardReconciler", () => {
  it("returns stable ID-ordered pages and rejects limits outside 1 through 100", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({ title: "Zulu", boardId: "reconcile" });
    await store.create({ title: "Alpha", boardId: "reconcile" });
    const reconciler = new WorkboardReconciler(store);

    const first = await reconciler.list({ boardId: "reconcile", limit: 1 });
    const second = await reconciler.list({ boardId: "reconcile", limit: 1, cursor: first.cursor });

    expect(first.cards).toHaveLength(1);
    expect(second.cards).toHaveLength(1);
    expect(first.cards[0]!.id < second.cards[0]!.id).toBe(true);
    await expect(reconciler.list({ limit: 0 })).rejects.toThrow("limit must be between 1 and 100.");
    await expect(reconciler.list({ limit: 101 })).rejects.toThrow(
      "limit must be between 1 and 100.",
    );
  });

  it("returns the original result for a duplicate idempotency key", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const observation = {
      sourceUrl: "https://example.test/runs/17",
      tenant: "acme",
      idempotencyKey: "run-17-v1",
      sourceUpdatedAt: 100,
      card: { title: "External run", boardId: "reconcile" },
    };

    const created = await reconciler.apply(observation);
    const repeated = await reconciler.apply({ ...observation, card: { title: "Changed title" } });

    expect(repeated).toEqual(created);
    expect(repeated.card.title).toBe("External run");
  });

  it("does not apply an older observation", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/18",
      tenant: "acme",
      idempotencyKey: "run-18-v2",
      sourceUpdatedAt: 200,
      card: { title: "Fresh title", boardId: "reconcile" },
    });

    const stale = await reconciler.apply({
      sourceUrl: "https://example.test/runs/18",
      tenant: "acme",
      idempotencyKey: "run-18-v1",
      sourceUpdatedAt: 100,
      cardId: created.card.id,
      card: { title: "Stale title" },
    });

    expect(stale).toMatchObject({
      applied: false,
      card: { id: created.card.id, title: "Fresh title" },
    });
  });

  it.each(["blocked", "review", "done"] as const)(
    "does not change a %s card through reconciliation",
    async (status) => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Terminal workflow", status, boardId: "reconcile" });
      const reconciler = new WorkboardReconciler(store);

      const result = await reconciler.apply({
        sourceUrl: "https://example.test/runs/19",
        tenant: "acme",
        idempotencyKey: `run-19-${status}`,
        sourceUpdatedAt: 100,
        cardId: card.id,
        expectedRevision: card.updatedAt,
        card: { title: "External change", status: "todo" },
      });

      expect(result).toMatchObject({
        applied: false,
        card: { id: card.id, title: "Terminal workflow", status },
      });
    },
  );
});
