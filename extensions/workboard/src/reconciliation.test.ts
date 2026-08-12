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

  it("replays an older persisted association after a newer link without creating another card", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const first = await reconciler.apply({
      sourceUrl: "https://example.test/runs/17/a",
      tenant: "acme",
      idempotencyKey: "run-17-a",
      sourceUpdatedAt: 100,
      link: { title: "First association" },
      card: { title: "External run", boardId: "reconcile" },
    });

    const second = await reconciler.apply({
      sourceUrl: "https://example.test/runs/17/b",
      tenant: "acme",
      idempotencyKey: "run-17-b",
      sourceUpdatedAt: 200,
      cardId: first.card.id,
      card: { title: "Newer title" },
    });
    const replayed = await reconciler.apply({
      sourceUrl: "https://attacker.test/runs/17/a",
      tenant: "acme",
      idempotencyKey: "run-17-a",
      sourceUpdatedAt: 999,
      link: { title: "Incoming title" },
      card: { title: "Changed title" },
    });

    expect(second.card.id).toBe(first.card.id);
    expect(replayed.card.id).toBe(first.card.id);
    expect(replayed.link).toEqual({
      sourceUrl: "https://example.test/runs/17/a",
      tenant: "acme",
      idempotencyKey: "run-17-a",
      sourceUpdatedAt: 100,
      title: "First association",
    });
    expect(
      replayed.card.metadata?.links?.filter((link) => link.id.startsWith("external:")),
    ).toHaveLength(2);
  });

  it("associates an older new link without regressing lifecycle-controlled card fields", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/18",
      tenant: "acme",
      idempotencyKey: "run-18-v2",
      sourceUpdatedAt: 200,
      card: { title: "Fresh title", status: "running", boardId: "reconcile" },
    });

    const stale = await reconciler.apply({
      sourceUrl: "https://example.test/runs/18/older",
      tenant: "acme",
      idempotencyKey: "run-18-v1",
      sourceUpdatedAt: 100,
      cardId: created.card.id,
      card: { title: "Stale title", status: "todo" },
    });

    expect(stale).toMatchObject({
      applied: true,
      card: { id: created.card.id, title: "Fresh title", status: "running" },
    });
    expect(stale.card.metadata?.lifecycleStatusSourceUpdatedAt).toBe(200);
    expect(
      stale.card.metadata?.links?.some((link) => link.url === "https://example.test/runs/18/older"),
    ).toBe(true);
  });

  it("fails closed when an explicit card belongs to another tenant", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const owner = await reconciler.apply({
      sourceUrl: "https://example.test/runs/tenant-owner",
      tenant: "acme",
      idempotencyKey: "tenant-owner-v1",
      sourceUpdatedAt: 100,
      card: { title: "Tenant-owned", boardId: "reconcile" },
    });

    const rejected = await reconciler.apply({
      sourceUrl: "https://example.test/runs/tenant-attacker",
      tenant: "other",
      idempotencyKey: "tenant-attacker-v1",
      sourceUpdatedAt: 200,
      cardId: owner.card.id,
      card: { title: "Foreign overwrite", status: "running" },
    });

    expect(rejected).toMatchObject({
      applied: false,
      card: { id: owner.card.id, title: "Tenant-owned" },
    });
    expect(rejected.card.metadata?.automation?.tenant).toBe("acme");
    expect(
      rejected.card.metadata?.links?.some(
        (link) => link.url === "https://example.test/runs/tenant-attacker",
      ),
    ).toBe(false);
  });

  it("fails closed for an explicit card id that does not exist", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    await expect(
      reconciler.apply({
        sourceUrl: "https://example.test/runs/missing",
        tenant: "acme",
        idempotencyKey: "missing-v1",
        sourceUpdatedAt: 100,
        cardId: "missing-card",
        card: { title: "Must not create" },
      }),
    ).rejects.toThrow("card not found: missing-card");
  });

  it("does not apply older link card fields after a manual lifecycle marker clear", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const reconciler = new WorkboardReconciler(store);
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/newer",
      tenant: "acme",
      idempotencyKey: "newer-v1",
      sourceUpdatedAt: 200,
      card: { title: "Newer", status: "running" },
    });
    await store.update(created.card.id, { status: "todo" });
    const older = await reconciler.apply({
      sourceUrl: "https://example.test/runs/older",
      tenant: "acme",
      idempotencyKey: "older-v1",
      sourceUpdatedAt: 100,
      cardId: created.card.id,
      card: { title: "Older overwrite", status: "running" },
    });
    expect(older).toMatchObject({ applied: true, card: { title: "Newer", status: "todo" } });
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

  it("does not overwrite a manual terminal transition that happens before its queued mutation", async () => {
    let releaseEntries: (() => void) | undefined;
    let entriesStarted: (() => void) | undefined;
    let releaseRegister: (() => void) | undefined;
    let registerStarted: (() => void) | undefined;
    let blockEntries = false;
    let blockRegister = false;
    const entries = new Map<string, PersistedWorkboardCard>();
    const keyedStore: WorkboardKeyedStore<PersistedWorkboardCard> = {
      async register(key, value) {
        if (blockRegister) {
          blockRegister = false;
          registerStarted?.();
          await new Promise<void>((resolve) => {
            releaseRegister = resolve;
          });
        }
        entries.set(key, value);
      },
      async lookup(key) {
        return entries.get(key);
      },
      async delete(key) {
        return entries.delete(key);
      },
      async entries() {
        const snapshot = [...entries].map(([key, value]) => ({ key, value }));
        if (blockEntries) {
          blockEntries = false;
          entriesStarted?.();
          await new Promise<void>((resolve) => {
            releaseEntries = resolve;
          });
        }
        return snapshot;
      },
    };
    const store = new WorkboardStore(keyedStore);
    const card = await store.create({ title: "Manual transition", boardId: "reconcile" });
    const reconciler = new WorkboardReconciler(store);
    blockRegister = true;
    blockEntries = true;
    const manualMutationStarted = new Promise<void>((resolve) => {
      registerStarted = resolve;
    });
    const reconciliationPreparationStarted = new Promise<void>((resolve) => {
      entriesStarted = resolve;
    });
    const manual = store.update(card.id, { status: "blocked" });
    await manualMutationStarted;
    const applying = reconciler.apply({
      sourceUrl: "https://example.test/runs/race",
      tenant: "acme",
      idempotencyKey: "race-v1",
      sourceUpdatedAt: 100,
      cardId: card.id,
      expectedRevision: card.updatedAt,
      card: { title: "External overwrite" },
    });
    releaseRegister?.();
    await manual;
    await reconciliationPreparationStarted;
    releaseEntries?.();

    await expect(applying).resolves.toMatchObject({ applied: false, card: { status: "blocked" } });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      title: "Manual transition",
    });
  });
});
