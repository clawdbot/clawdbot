// Workboard reconciliation tests cover the external scanner facade.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardReconciler, projectReconciliationSourceObservation } from "./reconciliation.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
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
  it("canonicalizes one objective per tenant while retaining each external association", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const first = await reconciler.apply({
      sourceUrl: "https://example.test/runs/a",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "a",
      sourceUpdatedAt: 100,
      card: { title: "Deploy API" },
    });
    const second = await reconciler.apply({
      sourceUrl: "https://example.test/runs/b",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "b",
      sourceUpdatedAt: 200,
      card: { title: "New title must not create a second card" },
    });

    expect(second.card.id).toBe(first.card.id);
    expect(second.card.metadata?.automation?.objectiveKey).toBe("deploy-api");
    expect(
      second.card.metadata?.links?.filter((link) => link.id.startsWith("external:")),
    ).toHaveLength(2);
  });

  it("keeps matching objective keys isolated by tenant and fails closed for an explicit mismatch", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const acme = await reconciler.apply({
      sourceUrl: "https://example.test/acme",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "acme-a",
      sourceUpdatedAt: 100,
      card: { title: "Acme deploy" },
    });
    const other = await reconciler.apply({
      sourceUrl: "https://example.test/other",
      tenant: "other",
      objectiveKey: "deploy-api",
      idempotencyKey: "other-a",
      sourceUpdatedAt: 100,
      card: { title: "Other deploy" },
    });
    expect(other.card.id).not.toBe(acme.card.id);
    await expect(
      reconciler.apply({
        sourceUrl: "https://example.test/mismatch",
        tenant: "acme",
        objectiveKey: "different-objective",
        idempotencyKey: "mismatch",
        sourceUpdatedAt: 101,
        cardId: acme.card.id,
        card: { title: "Must not change" },
      }),
    ).rejects.toThrow("objectiveKey does not match card");
  });

  it("serializes concurrent creates for one tenant objective to one canonical card", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const cards = await Promise.all(
      ["a", "b", "c"].map((id) =>
        reconciler.apply({
          sourceUrl: `https://example.test/runs/${id}`,
          tenant: "acme",
          objectiveKey: "deploy-api",
          idempotencyKey: id,
          sourceUpdatedAt: 100,
          card: { title: "Deploy API" },
        }),
      ),
    );
    expect(new Set(cards.map((result) => result.card.id))).toEqual(new Set([cards[0]!.card.id]));
    expect(
      cards.at(-1)?.card.metadata?.links?.filter((link) => link.id.startsWith("external:")),
    ).toHaveLength(3);
  });

  it("writes the canonical objective on the initial create without an observable intermediate card", async () => {
    const writes: PersistedWorkboardCard[] = [];
    const entries = new Map<string, PersistedWorkboardCard>();
    const store = new WorkboardStore({
      async register(key, value) {
        writes.push(value);
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
    });
    await new WorkboardReconciler(store).apply({
      sourceUrl: "https://example.test/a",
      tenant: "acme",
      objectiveKey: "deploy",
      idempotencyKey: "a",
      sourceUpdatedAt: 1,
      card: { title: "A" },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.card.metadata?.automation?.objectiveKey).toBe("deploy");
  });

  it("rejects an explicit card when its idempotency association belongs to another card", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const owned = await reconciler.apply({
      sourceUrl: "https://example.test/a",
      tenant: "acme",
      objectiveKey: "a",
      idempotencyKey: "shared",
      sourceUpdatedAt: 1,
      card: { title: "A" },
    });
    const named = await reconciler.apply({
      sourceUrl: "https://example.test/b",
      tenant: "acme",
      objectiveKey: "b",
      idempotencyKey: "other",
      sourceUpdatedAt: 1,
      card: { title: "B" },
    });
    await expect(
      reconciler.apply({
        sourceUrl: "https://example.test/a",
        tenant: "acme",
        objectiveKey: "b",
        idempotencyKey: "shared",
        sourceUpdatedAt: 2,
        cardId: named.card.id,
        card: { title: "forged" },
      }),
    ).rejects.toThrow("idempotency association does not match card.");
    expect(owned.card.id).not.toBe(named.card.id);
  });

  it("updates stale source evidence on the link without changing protected manual state", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const reconciler = new WorkboardReconciler(store);
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/a",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "a",
      sourceUpdatedAt: 100,
      card: { title: "Deploy API", status: "running" },
    });
    await store.update(created.card.id, { status: "blocked" });

    const missingOnce = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      idempotencyKey: "a",
      observationId: "scan-200",
      sourceState: "missing-after-successful-full-scan",
      staleAfterMisses: 2,
      observedAt: 200,
    });
    const link = (result: typeof missingOnce) =>
      result.card.metadata?.links?.find((entry) => entry.id.includes("external:"));
    expect(link(missingOnce)?.consecutiveSuccessfulFullScanMisses).toBe(1);
    const stale = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      idempotencyKey: "a",
      observationId: "scan-300",
      sourceState: "missing-after-successful-full-scan",
      staleAfterMisses: 2,
      observedAt: 300,
    });
    expect(link(stale)?.staleAt).toBe(300);
    const failed = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      idempotencyKey: "a",
      observationId: "scan-400",
      sourceState: "dependency-failed",
      staleAfterMisses: 2,
      observedAt: 400,
    });
    expect(link(failed)?.consecutiveSuccessfulFullScanMisses).toBe(2);
    const present = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      idempotencyKey: "a",
      observationId: "scan-500",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 500,
    });
    expect(link(present)?.consecutiveSuccessfulFullScanMisses).toBe(0);
    expect(link(present)?.staleAt).toBeUndefined();
    expect(present.card.status).toBe("blocked");
  });

  it("acknowledges an exact replay without incrementing missing-source evidence again", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/replay",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "replay",
      sourceUpdatedAt: 100,
      card: { title: "Replay-safe" },
    });
    const observation = {
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/replay",
      idempotencyKey: "replay",
      observationId: "scan-42:replay:missing",
      sourceState: "missing-after-successful-full-scan" as const,
      staleAfterMisses: 2,
      observedAt: 200,
      expectedRevision: created.card.updatedAt,
    };

    const first = await reconciler.observeSource(observation);
    const replay = await reconciler.observeSource(observation);

    expect(first).toMatchObject({
      observationId: "scan-42:replay:missing",
      association: {
        cardId: created.card.id,
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/runs/replay",
        idempotencyKey: "replay",
      },
      evidence: { consecutiveSuccessfulFullScanMisses: 1 },
    });
    expect(replay).toEqual(first);
    await expect(
      reconciler.observeSource({ ...observation, sourceState: "present" }),
    ).rejects.toThrow("observationId conflicts");
  });

  it("replays the original acknowledgement after an intervening card mutation", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/ack",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "ack",
      sourceUpdatedAt: 1,
      card: { title: "Original acknowledgement" },
    });
    const observation = {
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/ack",
      idempotencyKey: "ack",
      observationId: "ack-1",
      sourceState: "missing-after-successful-full-scan" as const,
      staleAfterMisses: 1,
      observedAt: 2,
    };
    const first = await reconciler.observeSource(observation);
    await (reconciler as unknown as { store: WorkboardStore }).store.update(created.card.id, {
      notes: "Changed after acknowledgement",
    });
    const replay = await reconciler.observeSource(observation);

    expect(replay).toMatchObject({
      association: first.association,
      observationId: first.observationId,
      revision: first.revision,
      evidence: first.evidence,
      card: { notes: "Changed after acknowledgement" },
    });
    expect(replay.card.updatedAt).toBeGreaterThan(first.revision);
  });

  it("advances revisions under frozen time so stale source observations cannot double-count", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
      const created = await reconciler.apply({
        sourceUrl: "https://example.test/runs/frozen",
        tenant: "acme",
        objectiveKey: "deploy-api",
        idempotencyKey: "frozen",
        sourceUpdatedAt: 1,
        card: { title: "Frozen revision" },
      });
      const first = await reconciler.observeSource({
        cardId: created.card.id,
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/runs/frozen",
        idempotencyKey: "frozen",
        observationId: "frozen-1",
        sourceState: "missing-after-successful-full-scan",
        staleAfterMisses: 3,
        observedAt: 2,
        expectedRevision: created.card.updatedAt,
      });
      expect(first.revision).toBeGreaterThan(created.card.updatedAt);
      await expect(
        reconciler.observeSource({
          cardId: created.card.id,
          tenant: "acme",
          objectiveKey: "deploy-api",
          sourceUrl: "https://example.test/runs/frozen",
          idempotencyKey: "frozen",
          observationId: "frozen-2",
          sourceState: "missing-after-successful-full-scan",
          staleAfterMisses: 3,
          observedAt: 3,
          expectedRevision: created.card.updatedAt,
        }),
      ).rejects.toThrow("source observation does not match card.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("chains acknowledgement revisions across two external associations", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const firstLink = await reconciler.apply({
      sourceUrl: "https://example.test/runs/one",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "one",
      sourceUpdatedAt: 100,
      card: { title: "Chained observations" },
    });
    const secondLink = await reconciler.apply({
      cardId: firstLink.card.id,
      sourceUrl: "https://example.test/runs/two",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "two",
      sourceUpdatedAt: 101,
      expectedRevision: firstLink.card.updatedAt,
    });
    const first = await reconciler.observeSource({
      cardId: secondLink.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/one",
      idempotencyKey: "one",
      observationId: "chain-one",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 200,
      expectedRevision: secondLink.card.updatedAt,
    });
    const second = await reconciler.observeSource({
      cardId: secondLink.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/two",
      idempotencyKey: "two",
      observationId: "chain-two",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 201,
      expectedRevision: first.revision,
    });
    expect(second.revision).toBe(second.card.updatedAt);
    expect(second.evidence.lastSourceObservationId).toBe("chain-two");
  });

  it("round-trips replay state through SQLite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-observation-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    try {
      const first = new WorkboardReconciler(new WorkboardStore(stores.cards));
      const created = await first.apply({
        sourceUrl: "https://example.test/runs/sqlite",
        tenant: "acme",
        objectiveKey: "deploy-api",
        idempotencyKey: "sqlite",
        sourceUpdatedAt: 1,
        card: { title: "Durable replay" },
      });
      const observation = {
        cardId: created.card.id,
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/runs/sqlite",
        idempotencyKey: "sqlite",
        observationId: "sqlite-scan-1",
        sourceState: "missing-after-successful-full-scan" as const,
        staleAfterMisses: 2,
        observedAt: 2,
      };
      await first.observeSource(observation);
      stores.close();
      const reopened = createWorkboardSqliteStores({ dbPath });
      try {
        const replay = await new WorkboardReconciler(
          new WorkboardStore(reopened.cards),
        ).observeSource(observation);
        expect(replay.evidence).toMatchObject({
          consecutiveSuccessfulFullScanMisses: 1,
          lastSourceObservationId: "sqlite-scan-1",
        });
      } finally {
        reopened.close();
      }
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched source for every source-evidence mode and retains the threshold timestamp", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/a",
      tenant: "acme",
      objectiveKey: "deploy",
      idempotencyKey: "a",
      sourceUpdatedAt: 1,
      card: { title: "A" },
    });
    const base = {
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy",
      sourceUrl: "https://attacker.test/a",
      idempotencyKey: "a",
      observationId: "wrong-source",
      staleAfterMisses: 1,
      observedAt: 2,
    } as const;
    for (const sourceState of [
      "present",
      "missing-after-successful-full-scan",
      "dependency-failed",
    ] as const) {
      await expect(reconciler.observeSource({ ...base, sourceState })).rejects.toThrow(
        "external association",
      );
    }
    const stale = await reconciler.observeSource({
      ...base,
      sourceUrl: "https://example.test/a",
      sourceState: "missing-after-successful-full-scan",
    });
    const later = await reconciler.observeSource({
      ...base,
      sourceUrl: "https://example.test/a",
      sourceState: "missing-after-successful-full-scan",
      observedAt: 3,
      observationId: "later-source",
    });
    const link = (result: typeof stale) =>
      result.card.metadata?.links?.find((entry) => entry.id.startsWith("external:"));
    expect(link(stale)?.staleAt).toBe(2);
    expect(link(later)?.staleAt).toBe(2);
  });

  it("rejects untrusted fields in the strict source-evidence observation", () => {
    expect(() =>
      projectReconciliationSourceObservation({
        cardId: "card",
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/a",
        idempotencyKey: "a",
        observationId: "strict",
        sourceState: "present",
        staleAfterMisses: 2,
        observedAt: 1,
        metadata: { claim: { token: "forged" } },
      }),
    ).toThrow("source observation.metadata is not allowed.");
  });
  it("requires a bounded source observation ID", () => {
    expect(() =>
      projectReconciliationSourceObservation({
        cardId: "card",
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/a",
        idempotencyKey: "a",
        sourceState: "present",
        staleAfterMisses: 2,
        observedAt: 1,
      }),
    ).toThrow("observationId is required.");
    expect(() =>
      projectReconciliationSourceObservation({
        cardId: "card",
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/a",
        idempotencyKey: "a",
        observationId: "x".repeat(201),
        sourceState: "present",
        staleAfterMisses: 2,
        observedAt: 1,
      }),
    ).toThrow("observationId must be 200 characters or fewer.");
  });
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

  it("replays the exact persisted newer association", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/a",
      tenant: "acme",
      idempotencyKey: "a",
      sourceUpdatedAt: 100,
      card: { title: "A" },
    });
    await reconciler.apply({
      sourceUrl: "https://example.test/b",
      tenant: "acme",
      idempotencyKey: "b",
      sourceUpdatedAt: 200,
      link: { title: "Persisted B" },
      cardId: created.card.id,
      card: { title: "B" },
    });
    const replayed = await reconciler.apply({
      sourceUrl: "https://attacker.test/b",
      tenant: "acme",
      idempotencyKey: "b",
      sourceUpdatedAt: 999,
      card: { title: "wrong" },
    });
    expect(replayed.link).toEqual({
      sourceUrl: "https://example.test/b",
      tenant: "acme",
      idempotencyKey: "b",
      sourceUpdatedAt: 200,
      title: "Persisted B",
    });
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
