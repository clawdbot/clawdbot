// Workboard reconciliation tests cover the external scanner facade.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import {
  WorkboardReconciler,
  projectReconciliationObservation,
  projectReconciliationSourceObservation,
} from "./reconciliation.js";
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
  it("persists bounded reconciliation triage through unrelated updates and a SQLite reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-triage-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const triage = {
      candidateCardIds: ["candidate-alpha", "candidate-beta"],
      evidence: [
        {
          reference: { type: "url", url: "https://example.test/evidence/alpha" },
          sha256: "a".repeat(64),
        },
        {
          reference: { type: "url", url: "https://example.test/evidence/beta" },
          sha256: "b".repeat(64),
        },
      ],
    };
    const stores = createWorkboardSqliteStores({ dbPath });
    try {
      const store = new WorkboardStore(stores.cards, stores);
      const reconciler = new WorkboardReconciler(store);
      const created = await reconciler.apply({
        sourceUrl: "https://example.test/runs/triage",
        tenant: "acme",
        idempotencyKey: "triage-create",
        sourceUpdatedAt: 100,
        card: { title: "Resolve matching cards" },
        triage,
      } as never);

      expect(created.card.metadata?.reconciliationTriage).toEqual(triage);
      await store.update(created.card.id, { priority: "urgent" });
      expect(
        (await reconciler.list({ tenant: "acme" })).cards[0]?.metadata?.reconciliationTriage,
      ).toEqual(triage);
    } finally {
      stores.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath });
    try {
      const restored = await reopened.cards.lookup(
        (await reopened.cards.entries())[0]?.key ?? "missing",
      );
      expect(restored?.card.metadata?.reconciliationTriage).toEqual(triage);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe reconciliation triage before mutation and ignores generic metadata injection", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const reconciler = new WorkboardReconciler(store);
    const before = await store.create({
      title: "Generic metadata cannot write reconciliation triage",
      metadata: {
        reconciliationTriage: {
          candidateCardIds: ["forged"],
          evidence: [
            {
              reference: { type: "url", url: "https://example.test/forged" },
              sha256: "c".repeat(64),
            },
          ],
        },
      },
    });
    expect(before.metadata?.reconciliationTriage).toBeUndefined();

    const reconciled = await reconciler.apply({
      sourceUrl: "https://example.test/runs/generic-update",
      tenant: "acme",
      idempotencyKey: "generic-update",
      sourceUpdatedAt: 100,
      card: { title: "Reconciliation owns this metadata" },
      triage: {
        candidateCardIds: ["candidate-owned"],
        evidence: [
          {
            reference: { type: "url", url: "https://example.test/evidence/owned" },
            sha256: "e".repeat(64),
          },
        ],
      },
    } as never);
    await store.update(reconciled.card.id, {
      metadata: { reconciliationTriage: { candidateCardIds: [], evidence: [] } },
    });
    expect((await store.get(reconciled.card.id))?.metadata?.reconciliationTriage).toEqual(
      reconciled.card.metadata?.reconciliationTriage,
    );

    await expect(
      reconciler.apply({
        sourceUrl: "https://example.test/runs/invalid-triage",
        tenant: "acme",
        idempotencyKey: "invalid-triage",
        sourceUpdatedAt: 100,
        card: { title: "Must not mutate" },
        triage: {
          candidateCardIds: Array.from({ length: 21 }, (_, index) => `candidate-${index}`),
          evidence: [],
        },
      } as never),
    ).rejects.toThrow("candidateCardIds supports at most 20 entries.");
    await expect(
      reconciler.apply({
        sourceUrl: "https://example.test/runs/invalid-reference",
        tenant: "acme",
        idempotencyKey: "invalid-reference",
        sourceUpdatedAt: 100,
        card: { title: "Must not mutate" },
        triage: {
          candidateCardIds: [],
          evidence: [
            {
              reference: { type: "file", url: "file:///private" },
              sha256: "d".repeat(64),
            },
          ],
        },
      } as never),
    ).rejects.toThrow("triage evidence reference.type is unsupported.");
    expect(await store.list()).toHaveLength(2);

    expect(() =>
      projectReconciliationObservation({
        sourceUrl: "https://example.test/runs/unknown-triage",
        tenant: "acme",
        idempotencyKey: "unknown-triage",
        sourceUpdatedAt: 100,
        card: { title: "Unknown triage field" },
        triage: { candidateCardIds: [], evidence: [], notes: "not allowed" },
      }),
    ).toThrow("triage.notes is not allowed.");
  });

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

  it("lists a stable machine association key for every external link", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const first = await reconciler.apply({
      sourceUrl: "https://example.test/runs/a",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "a",
      sourceUpdatedAt: 100,
      card: { title: "Deploy API" },
    });
    await reconciler.apply({
      cardId: first.card.id,
      sourceUrl: "https://example.test/runs/b",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "b",
      sourceUpdatedAt: 101,
      card: { title: "Deploy API" },
    });

    const listed = await reconciler.list({ tenant: "acme" });
    const externalLinks = listed.cards[0]?.metadata?.links?.filter((link) =>
      link.id.startsWith("external:"),
    );

    expect(externalLinks).toHaveLength(2);
    expect(externalLinks?.map((link) => link.reconciliationAssociationKey)).toEqual([
      expect.stringMatching(/^[A-Za-z0-9_-]{16,160}$/),
      expect.stringMatching(/^[A-Za-z0-9_-]{16,160}$/),
    ]);
    expect(externalLinks?.[0]?.reconciliationAssociationKey).not.toBe(
      externalLinks?.[1]?.reconciliationAssociationKey,
    );

    const a = externalLinks?.find((link) => link.url?.endsWith("/a"));
    const b = externalLinks?.find((link) => link.url?.endsWith("/b"));
    const firstObservation = await reconciler.observeSource({
      cardId: first.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      reconciliationAssociationKey: a?.reconciliationAssociationKey,
      observationId: "a-present",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 102,
      expectedRevision: listed.cards[0]?.updatedAt,
    });
    const secondObservation = await reconciler.observeSource({
      cardId: first.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/b",
      reconciliationAssociationKey: b?.reconciliationAssociationKey,
      observationId: "b-present",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 103,
      expectedRevision: firstObservation.revision,
    });
    expect(secondObservation.evidence.lastSourceObservationId).toBe("b-present");
  });

  it("observes a listed opaque association in a later batch without its original apply key", async () => {
    const firstBatch = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const applied = await firstBatch.apply({
      sourceUrl: "https://example.test/runs/later-batch",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "private-apply-key",
      sourceUpdatedAt: 100,
      card: { title: "Later batch association" },
    });
    const listed = await firstBatch.list({ tenant: "acme" });
    const associationKey = listed.cards[0]?.metadata?.links?.find((link) =>
      link.id.startsWith("external:"),
    )?.reconciliationAssociationKey;
    const secondBatch = new WorkboardReconciler(
      (firstBatch as unknown as { store: WorkboardStore }).store,
    );

    const result = await secondBatch.observeSource({
      cardId: applied.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/later-batch",
      reconciliationAssociationKey: associationKey!,
      observationId: "later-batch-present",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 101,
      expectedRevision: listed.cards[0]!.updatedAt,
    });

    expect(result.association).toEqual({
      cardId: applied.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/later-batch",
      reconciliationAssociationKey: associationKey,
    });
    expect(JSON.stringify(result)).not.toContain("private-apply-key");
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
    const blocked = await store.update(created.card.id, { status: "blocked" });

    const missingOnce = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "scan-200",
      sourceState: "missing-after-successful-full-scan",
      staleAfterMisses: 2,
      observedAt: 200,
      expectedRevision: blocked.updatedAt,
    });
    const link = (result: typeof missingOnce) =>
      result.card.metadata?.links?.find((entry) => entry.id.includes("external:"));
    expect(link(missingOnce)?.consecutiveSuccessfulFullScanMisses).toBe(1);
    const stale = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "scan-300",
      sourceState: "missing-after-successful-full-scan",
      staleAfterMisses: 2,
      observedAt: 300,
      expectedRevision: missingOnce.revision,
    });
    expect(link(stale)?.staleAt).toBe(300);
    const failed = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "scan-400",
      sourceState: "dependency-failed",
      staleAfterMisses: 2,
      observedAt: 400,
      expectedRevision: stale.revision,
    });
    expect(link(failed)?.consecutiveSuccessfulFullScanMisses).toBe(2);
    const present = await reconciler.observeSource({
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/a",
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "scan-500",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 500,
      expectedRevision: failed.revision,
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
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "scan-42:replay:missing",
      sourceState: "missing-after-successful-full-scan" as const,
      staleAfterMisses: 2,
      observedAt: 200,
      expectedRevision: created.card.updatedAt,
    };

    const first = await reconciler.observeSource(observation);
    const replay = await reconciler.observeSource({
      ...observation,
      observedAt: 999_999,
      expectedRevision: 999_999,
    });

    expect(first).toMatchObject({
      observationId: "scan-42:replay:missing",
      association: {
        cardId: created.card.id,
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/runs/replay",
      },
      evidence: { consecutiveSuccessfulFullScanMisses: 1 },
    });
    expect(replay).toEqual(first);
    await expect(
      reconciler.observeSource({ ...observation, sourceState: "present" }),
    ).rejects.toThrow("observationId conflicts");
  });

  it("acknowledges each new evidence state instead of carrying a prior acknowledgement snapshot", async () => {
    const reconciler = new WorkboardReconciler(new WorkboardStore(createMemoryStore()));
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/runs/evidence",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "evidence",
      sourceUpdatedAt: 1,
      card: { title: "Fresh evidence" },
    });
    const base = {
      cardId: created.card.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/runs/evidence",
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      staleAfterMisses: 2,
      expectedRevision: created.card.updatedAt,
    };
    const missingOne = await reconciler.observeSource({
      ...base,
      observationId: "evidence-1",
      sourceState: "missing-after-successful-full-scan",
      observedAt: 2,
    });
    const missingTwo = await reconciler.observeSource({
      ...base,
      observationId: "evidence-2",
      sourceState: "missing-after-successful-full-scan",
      observedAt: 3,
      expectedRevision: missingOne.revision,
    });
    const present = await reconciler.observeSource({
      ...base,
      observationId: "evidence-3",
      sourceState: "present",
      observedAt: 4,
      expectedRevision: missingTwo.revision,
    });
    expect(missingOne.evidence).toEqual({
      consecutiveSuccessfulFullScanMisses: 1,
      lastSourceObservationId: "evidence-1",
    });
    expect(missingTwo.evidence).toEqual({
      consecutiveSuccessfulFullScanMisses: 2,
      staleAt: 3,
      staleState: "stale",
      lastSourceObservationId: "evidence-2",
    });
    expect(present.evidence).toEqual({
      consecutiveSuccessfulFullScanMisses: 0,
      lastSourceObservationId: "evidence-3",
    });
    const persisted = present.card.metadata?.links?.find((link) => link.id.startsWith("external:"));
    expect(persisted).toMatchObject({
      consecutiveSuccessfulFullScanMisses: 0,
    });
    expect(persisted).not.toHaveProperty("lastSourceObservationId");
    expect(persisted).not.toHaveProperty("lastSourceObservationEvidenceJson");
    expect(
      await reconciler.observeSource({
        ...base,
        observationId: "evidence-3",
        sourceState: "present",
        observedAt: 4,
        expectedRevision: missingTwo.revision,
      }),
    ).toMatchObject({ evidence: present.evidence });
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
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "ack-1",
      sourceState: "missing-after-successful-full-scan" as const,
      staleAfterMisses: 1,
      observedAt: 2,
      expectedRevision: created.card.updatedAt,
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
        reconciliationAssociationKey: created.link.reconciliationAssociationKey,
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
          reconciliationAssociationKey: created.link.reconciliationAssociationKey,
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
      reconciliationAssociationKey: firstLink.link.reconciliationAssociationKey,
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
      reconciliationAssociationKey: secondLink.link.reconciliationAssociationKey,
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
        reconciliationAssociationKey: created.link.reconciliationAssociationKey,
        observationId: "sqlite-scan-1",
        sourceState: "missing-after-successful-full-scan" as const,
        staleAfterMisses: 2,
        observedAt: 2,
        expectedRevision: created.card.updatedAt,
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
        expect(replay.association.reconciliationAssociationKey).toBe(
          created.link.reconciliationAssociationKey,
        );
      } finally {
        reopened.close();
      }
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a physical pre-v8 replay acknowledgement without exposing legacy link ids", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-pre-v8-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    try {
      const reconciler = new WorkboardReconciler(new WorkboardStore(stores.cards));
      const created = await reconciler.apply({
        sourceUrl: "https://example.test/legacy",
        tenant: "acme",
        objectiveKey: "deploy-api",
        idempotencyKey: "legacy-original-apply-key",
        sourceUpdatedAt: 1,
        card: { title: "Legacy replay" },
      });
      const withMaxLegacyLink = await reconciler.apply({
        cardId: created.card.id,
        sourceUrl: "https://example.test/legacy/max",
        tenant: "acme",
        objectiveKey: "deploy-api",
        idempotencyKey: "legacy-max",
        sourceUpdatedAt: 2,
        expectedRevision: created.card.updatedAt,
      });
      const observation = {
        cardId: created.card.id,
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/legacy",
        reconciliationAssociationKey: created.link.reconciliationAssociationKey,
        observationId: "legacy-ack",
        sourceState: "present" as const,
        staleAfterMisses: 2,
        observedAt: 2,
        expectedRevision: withMaxLegacyLink.card.updatedAt,
      };
      const first = await reconciler.observeSource(observation);
      stores.close();

      const legacy = openNodeSqliteDatabase(dbPath);
      try {
        legacy.exec("ALTER TABLE workboard_card_links DROP COLUMN reconciliation_association_key");
        legacy
          .prepare(
            "UPDATE workboard_card_links SET last_source_observation_request_json = ? WHERE card_id = ?",
          )
          .run(
            JSON.stringify({ ...observation, idempotencyKey: "legacy-original-apply-key" }),
            created.card.id,
          );
        legacy
          .prepare("UPDATE workboard_card_links SET id = ? WHERE url = ? AND card_id = ?")
          .run(`external:${"x".repeat(43)}`, "https://example.test/legacy/max", created.card.id);
        legacy.prepare("DELETE FROM workboard_schema_migrations WHERE id = ?").run("schema-8");
      } finally {
        legacy.close();
      }

      const migrated = createWorkboardSqliteStores({ dbPath });
      try {
        const listed = await new WorkboardReconciler(new WorkboardStore(migrated.cards)).list({
          tenant: "acme",
        });
        const links = listed.cards[0]?.metadata?.links ?? [];
        expect(JSON.stringify(listed)).not.toContain("legacy-original-apply-key");
        expect(JSON.stringify(listed)).not.toContain("x".repeat(43));
        expect(links.every((link) => !link.id.includes("legacy-original-apply-key"))).toBe(true);
        const key = links.find(
          (link) => link.url === observation.sourceUrl,
        )?.reconciliationAssociationKey;
        expect(key).toMatch(/^legacy_[A-Za-z0-9_-]{16,160}$/);
        expect(key?.length).toBeLessThanOrEqual(160);
        expect(links.find((link) => link.url?.endsWith("/max"))?.id).toMatch(
          /^external:[A-Za-z0-9_-]{43}$/,
        );
        const replay = await new WorkboardReconciler(
          new WorkboardStore(migrated.cards),
        ).observeSource({
          ...observation,
          reconciliationAssociationKey: key!,
          observedAt: 2_000,
          expectedRevision: first.revision + 1,
        });
        expect(replay.revision).toBe(first.revision);
        expect(JSON.stringify(replay)).not.toContain("legacy-original-apply-key");
        const applied = await new WorkboardReconciler(new WorkboardStore(migrated.cards)).apply({
          cardId: created.card.id,
          sourceUrl: "https://example.test/legacy/new",
          tenant: "acme",
          objectiveKey: "deploy-api",
          idempotencyKey: "legacy-original-apply-key",
          sourceUpdatedAt: 3,
          expectedRevision: replay.card.updatedAt,
        });
        expect(JSON.stringify(applied)).not.toContain("legacy-original-apply-key");
        const verified = openNodeSqliteDatabase(dbPath);
        try {
          const persisted = verified
            .prepare(
              "SELECT id, last_source_observation_request_json FROM workboard_card_links WHERE card_id = ?",
            )
            .all(created.card.id);
          expect(JSON.stringify(persisted)).not.toContain("legacy-original-apply-key");
        } finally {
          verified.close();
        }
        await expect(
          new WorkboardReconciler(new WorkboardStore(migrated.cards)).observeSource({
            ...observation,
            reconciliationAssociationKey: key!,
            sourceState: "missing-after-successful-full-scan",
          }),
        ).rejects.toThrow("observationId conflicts");
      } finally {
        migrated.close();
      }
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts legacy link IDs and replay state from every in-memory reconciliation response", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const reconciler = new WorkboardReconciler(store);
    const created = await reconciler.apply({
      sourceUrl: "https://example.test/in-memory-secret",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "in-memory-apply-secret",
      sourceUpdatedAt: 1,
      card: { title: "In-memory legacy" },
    });
    const rawLegacyId = `external:${"r".repeat(43)}`;
    const updated = await store.update(created.card.id, {
      metadata: {
        ...created.card.metadata,
        links: created.card.metadata?.links?.map((link) => ({
          ...link,
          id: rawLegacyId,
          lastSourceObservationId: "internal-observation-id",
          lastSourceObservationRequestJson: JSON.stringify({ idempotencyKey: "replay-secret" }),
          lastSourceObservationRevision: 1,
          lastSourceObservationEvidenceJson: JSON.stringify({ internal: true }),
        })),
      },
    });
    const associationKey = updated.metadata?.links?.[0]?.reconciliationAssociationKey!;
    const observed = await reconciler.observeSource({
      cardId: updated.id,
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/in-memory-secret",
      reconciliationAssociationKey: associationKey,
      observationId: "visible-observation",
      sourceState: "present",
      staleAfterMisses: 1,
      observedAt: 2,
      expectedRevision: updated.updatedAt,
    });
    const applied = await reconciler.apply({
      cardId: updated.id,
      sourceUrl: "https://example.test/in-memory-secret/next",
      tenant: "acme",
      objectiveKey: "deploy-api",
      idempotencyKey: "in-memory-apply-secret",
      sourceUpdatedAt: 3,
      expectedRevision: observed.card.updatedAt,
    });
    const listed = await reconciler.list({ tenant: "acme" });

    for (const response of [listed, applied, observed]) {
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(rawLegacyId);
      expect(serialized).not.toContain("in-memory-apply-secret");
      expect(serialized).not.toContain("replay-secret");
      expect(serialized).not.toContain("lastSourceObservationRequestJson");
      expect(serialized).not.toContain("lastSourceObservationEvidenceJson");
      expect(serialized).not.toContain("lastSourceObservationRevision");
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
      reconciliationAssociationKey: created.link.reconciliationAssociationKey,
      observationId: "wrong-source",
      staleAfterMisses: 1,
      observedAt: 2,
      expectedRevision: created.card.updatedAt,
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
      expectedRevision: stale.revision,
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
        reconciliationAssociationKey: "safe-key",
        sourceState: "present",
        staleAfterMisses: 2,
        observedAt: 1,
        expectedRevision: 1,
      }),
    ).toThrow("observationId is required.");
    expect(() =>
      projectReconciliationSourceObservation({
        cardId: "card",
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/a",
        reconciliationAssociationKey: "safe-key",
        observationId: "x".repeat(201),
        sourceState: "present",
        staleAfterMisses: 2,
        observedAt: 1,
        expectedRevision: 1,
      }),
    ).toThrow("observationId must be 200 characters or fewer.");
  });

  it("requires an association address and CAS revision for strict source observations", () => {
    const base = {
      cardId: "card",
      tenant: "acme",
      objectiveKey: "deploy-api",
      sourceUrl: "https://example.test/a",
      observationId: "strict-address",
      sourceState: "present",
      staleAfterMisses: 2,
      observedAt: 1,
    };
    expect(() => projectReconciliationSourceObservation(base)).toThrow(
      "reconciliationAssociationKey is required.",
    );
    expect(() =>
      projectReconciliationSourceObservation({ ...base, reconciliationAssociationKey: "safe-key" }),
    ).toThrow("expectedRevision must be a non-negative timestamp.");
  });

  it("rejects a caller-supplied apply idempotency key from source observations", () => {
    expect(() =>
      projectReconciliationSourceObservation({
        cardId: "card",
        tenant: "acme",
        objectiveKey: "deploy-api",
        sourceUrl: "https://example.test/a",
        reconciliationAssociationKey: "safe-key",
        idempotencyKey: "private-apply-key",
        observationId: "strict-key",
        sourceState: "present",
        staleAfterMisses: 2,
        observedAt: 1,
        expectedRevision: 1,
      }),
    ).toThrow("source observation.idempotencyKey is not allowed.");
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
      sourceUpdatedAt: 100,
      reconciliationAssociationKey: first.link.reconciliationAssociationKey,
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
    const persisted = await reconciler.apply({
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
      sourceUpdatedAt: 200,
      reconciliationAssociationKey: persisted.link.reconciliationAssociationKey,
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
