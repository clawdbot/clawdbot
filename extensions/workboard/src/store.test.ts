// Workboard tests cover store plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type WorkboardCard, WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardCardStore,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { normalizeExecution } from "./store-normalizers.js";
import { WorkboardCardConflictError, WorkboardStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(options?: {
  beforeRegister?: (key: string, value: T) => Promise<void> | void;
}): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      await options?.beforeRegister?.(key, value);
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

function createSignal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function expectSameCardState(actual: WorkboardCard | undefined, expected: WorkboardCard): void {
  expect(actual).toBeDefined();
  const { updatedAt: _actualUpdatedAt, ...actualState } = actual!;
  const { updatedAt: _expectedUpdatedAt, ...expectedState } = expected;
  expect(actualState).toEqual(expectedState);
}

function createPausedCardStore(delegate: WorkboardCardStore) {
  let pause:
    | {
        reached: () => void;
        waitForResume: Promise<void>;
      }
    | undefined;
  let pauseAfter:
    | {
        matches: (key: string, value: PersistedWorkboardCard | undefined) => boolean;
        reached: () => void;
        waitForResume: Promise<void>;
      }
    | undefined;
  const beforeWrite = async () => {
    const current = pause;
    if (!current) {
      return;
    }
    pause = undefined;
    current.reached();
    await current.waitForResume;
  };
  const afterWrite = async (key: string, value?: PersistedWorkboardCard) => {
    const current = pauseAfter;
    if (!current || !current.matches(key, value)) {
      return;
    }
    pauseAfter = undefined;
    current.reached();
    await current.waitForResume;
  };
  return {
    store: {
      async register(key, value) {
        await beforeWrite();
        await delegate.register(key, value);
        await afterWrite(key, value);
      },
      async registerIfAbsent(key, value) {
        await beforeWrite();
        const inserted = await delegate.registerIfAbsent(key, value);
        if (inserted) {
          await afterWrite(key, value);
        }
        return inserted;
      },
      async registerIfUpdatedAt(key, value, expectedUpdatedAt) {
        await beforeWrite();
        const updated = await delegate.registerIfUpdatedAt(key, value, expectedUpdatedAt);
        if (updated) {
          await afterWrite(key, value);
        }
        return updated;
      },
      async claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now) {
        await beforeWrite();
        const result = await delegate.claimIfOwnerAvailable(
          key,
          value,
          expectedUpdatedAt,
          ownerId,
          now,
        );
        if (result === "updated") {
          await afterWrite(key, value);
        }
        return result;
      },
      async deleteIfUpdatedAt(key, expectedUpdatedAt) {
        await beforeWrite();
        const deleted = await delegate.deleteIfUpdatedAt(key, expectedUpdatedAt);
        if (deleted) {
          await afterWrite(key);
        }
        return deleted;
      },
      async lookup(key) {
        return await delegate.lookup(key);
      },
      async delete(key) {
        const deleted = await delegate.delete(key);
        if (deleted) {
          await afterWrite(key);
        }
        return deleted;
      },
      async entries() {
        return await delegate.entries();
      },
      async listBoardAggregates() {
        return await delegate.listBoardAggregates();
      },
    } satisfies WorkboardCardStore,
    pauseNextWrite() {
      const reached = createSignal();
      const resume = createSignal();
      pause = { reached: () => reached.resolve(), waitForResume: resume.promise };
      return { reached: reached.promise, resume: () => resume.resolve() };
    },
    pauseAfterMatchingWrite(
      matches: (key: string, value: PersistedWorkboardCard | undefined) => boolean,
    ) {
      const reached = createSignal();
      const resume = createSignal();
      pauseAfter = {
        matches,
        reached: () => reached.resolve(),
        waitForResume: resume.promise,
      };
      return { reached: reached.promise, resume: () => resume.resolve() };
    },
  };
}

function createConcurrentSqliteHarness(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, "workboard.sqlite");
  const operationStores = createWorkboardSqliteStores({ dbPath });
  const hostStores = createWorkboardSqliteStores({ dbPath });
  const paused = createPausedCardStore(operationStores.cards);
  return {
    operation: new WorkboardStore(paused.store),
    host: new WorkboardStore(hostStores.cards),
    paused,
    close() {
      hostStores.close();
      operationStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  };
}

const WORKBOARD_CARD_CHILD_INDEXES = [
  ["workboard_card_events", "workboard_card_events_card_idx"],
  ["workboard_card_attempts", "workboard_card_attempts_card_idx"],
  ["workboard_card_comments", "workboard_card_comments_card_idx"],
  ["workboard_card_links", "workboard_card_links_card_idx"],
  ["workboard_card_proof", "workboard_card_proof_card_idx"],
  ["workboard_card_artifacts", "workboard_card_artifacts_card_idx"],
  ["workboard_card_notifications", "workboard_card_notifications_card_idx"],
  ["workboard_worker_logs", "workboard_worker_logs_card_idx"],
] as const;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function explainWorkboardQueryPlan(
  db: DatabaseSync,
  sql: string,
  params: readonly (number | string | null)[] = [],
): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail?: unknown;
  }>;
  return rows
    .map((row) => (typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? "")))
    .join("\n");
}

function withWorkboardSqliteDatabase(prefix: string, run: (db: DatabaseSync) => void): void {
  const dir = tempDirs.make(prefix);
  const dbPath = path.join(dir, "workboard.sqlite");
  const stores = createWorkboardSqliteStores({ dbPath });
  stores.close();
  const db = new DatabaseSync(dbPath);
  try {
    run(db);
  } finally {
    db.close();
  }
}

describe("WorkboardStore", () => {
  it("emits one monotonic change after each visible mutation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const changes = vi.fn();
    store.subscribeChanges(changes);

    const card = await store.create({ title: "Track changes" });
    await store.update(card.id, { notes: "updated" });
    await store.list();
    await expect(store.update("missing", { notes: "failed" })).rejects.toThrow("card not found");

    expect(changes.mock.calls.map(([change]) => change.revision)).toEqual([1, 2]);
    expect(changes.mock.calls[1]?.[0].epoch).toBe(changes.mock.calls[0]?.[0].epoch);
  });

  it("does not emit for no-op commands and isolates listener failures", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const changes = vi.fn(() => {
      throw new Error("listener failed");
    });
    store.subscribeChanges(changes);

    const card = await store.create({ title: "Idempotent", idempotencyKey: "same" });
    await store.create({ title: "Duplicate", idempotencyKey: "same" });
    await store.delete("missing");

    expect(card.title).toBe("Idempotent");
    expect(changes).toHaveBeenCalledOnce();
  });

  it("announces an epoch and reports failed commands that partially committed", async () => {
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>();
    subscriptions.entries = async () => {
      throw new Error("subscription cleanup failed");
    };
    const store = new WorkboardStore(createMemoryStore(), { subscriptions });
    const changes = vi.fn();
    store.subscribeChanges(changes);
    store.announceChangeEpoch();
    const card = await store.create({ title: "Partial delete" });

    await expect(store.delete(card.id)).rejects.toThrow("subscription cleanup failed");

    expect(changes.mock.calls.map(([change]) => change.revision)).toEqual([1, 2, 3]);
    await expect(store.get(card.id)).resolves.toBeUndefined();
  });

  it("emits when another sqlite connection commits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-change-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const readerStores = createWorkboardSqliteStores({ dbPath });
    const writerStores = createWorkboardSqliteStores({ dbPath });
    try {
      const reader = new WorkboardStore(readerStores.cards, {
        boards: readerStores.boards,
        subscriptions: readerStores.subscriptions,
        attachments: readerStores.attachments,
        dataVersion: readerStores.dataVersion,
      });
      const writer = new WorkboardStore(writerStores.cards, {
        boards: writerStores.boards,
        subscriptions: writerStores.subscriptions,
        attachments: writerStores.attachments,
        dataVersion: writerStores.dataVersion,
      });
      const changes = vi.fn();
      reader.subscribeChanges(changes);

      expect(reader.reconcileExternalChanges()).toBe(false);
      await writer.create({ title: "External" });
      expect(reader.reconcileExternalChanges()).toBe(true);
      expect(reader.reconcileExternalChanges()).toBe(false);
      expect(changes).toHaveBeenCalledOnce();
      await expect(reader.list()).resolves.toEqual([
        expect.objectContaining({ title: "External" }),
      ]);
    } finally {
      writerStores.close();
      readerStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale card edits across sqlite connections", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cas-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const firstStores = createWorkboardSqliteStores({ dbPath });
    const secondStores = createWorkboardSqliteStores({ dbPath });
    const first = new WorkboardStore(firstStores.cards);
    const second = new WorkboardStore(secondStores.cards);
    try {
      const base = await first.create({ title: "Original", status: "todo" });
      const moved = await second.move(base.id, "blocked", 2000);

      await expect(
        first.update(
          base.id,
          { title: "Stale title", status: "todo" },
          {
            expectedUpdatedAt: base.updatedAt,
          },
        ),
      ).rejects.toMatchObject({
        name: "WorkboardCardConflictError",
        current: expect.objectContaining({
          id: base.id,
          status: "blocked",
          position: 2000,
        }),
      } satisfies Partial<WorkboardCardConflictError>);
      await expect(first.get(base.id)).resolves.toMatchObject({
        title: "Original",
        status: "blocked",
        position: 2000,
        updatedAt: moved.updatedAt,
      });
    } finally {
      secondStores.close();
      firstStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a sqlite card only at its exact updatedAt version", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-delete-cas-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const firstStores = createWorkboardSqliteStores({ dbPath });
    const secondStores = createWorkboardSqliteStores({ dbPath });
    const first = new WorkboardStore(firstStores.cards);
    const second = new WorkboardStore(secondStores.cards);
    try {
      const created = await first.create({ title: "Delete fence" });
      const edited = await second.update(created.id, { notes: "Concurrent edit" });

      await expect(
        firstStores.cards.deleteIfUpdatedAt(created.id, created.updatedAt),
      ).resolves.toBe(false);
      await expect(first.get(created.id)).resolves.toMatchObject({
        notes: "Concurrent edit",
      });
      await expect(firstStores.cards.deleteIfUpdatedAt(created.id, edited.updatedAt)).resolves.toBe(
        true,
      );
      await expect(first.get(created.id)).resolves.toBeUndefined();
    } finally {
      secondStores.close();
      firstStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["move", "lifecycle"] as const)(
    "recomputes a %s write after a concurrent editor commit",
    async (owner) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-workboard-${owner}-race-`));
      const dbPath = path.join(dir, "workboard.sqlite");
      const firstStores = createWorkboardSqliteStores({ dbPath });
      const secondStores = createWorkboardSqliteStores({ dbPath });
      const paused = createPausedCardStore(firstStores.cards);
      const first = new WorkboardStore(paused.store, {
        boards: firstStores.boards,
        subscriptions: firstStores.subscriptions,
        attachments: firstStores.attachments,
      });
      const second = new WorkboardStore(secondStores.cards, {
        boards: secondStores.boards,
        subscriptions: secondStores.subscriptions,
        attachments: secondStores.attachments,
      });
      try {
        const sessionKey = "agent:main:dashboard:cas-race";
        const base = await first.create({
          title: "Original title",
          status: owner === "move" ? "todo" : "running",
          ...(owner === "lifecycle"
            ? {
                sessionKey,
                runId: "run-cas",
                execution: {
                  id: "exec-cas",
                  kind: "agent-session",
                  mode: "autonomous",
                  status: "running",
                  sessionKey,
                  runId: "run-cas",
                  startedAt: 1,
                  updatedAt: 1,
                },
              }
            : {}),
        });
        const pause = paused.pauseNextWrite();
        const ownerWrite =
          owner === "move"
            ? first.move(base.id, "blocked", 2000)
            : first.syncLifecycle(base.id, {
                targetStatus: "review",
                executionStatus: "review",
                sourceUpdatedAt: base.updatedAt + 1_000,
                stale: undefined,
                now: base.updatedAt + 1_000,
              });

        await pause.reached;
        await second.update(
          base.id,
          { title: "Concurrent editor title" },
          { expectedUpdatedAt: base.updatedAt },
        );
        pause.resume();
        await ownerWrite;

        const current = await first.get(base.id);
        expect(current?.title).toBe("Concurrent editor title");
        if (owner === "move") {
          expect(current).toMatchObject({ status: "blocked", position: 2000 });
        } else {
          expect(current).toMatchObject({
            status: "review",
            execution: { status: "review" },
            metadata: { lifecycleStatusSourceUpdatedAt: base.updatedAt + 1_000 },
          });
        }
      } finally {
        secondStores.close();
        firstStores.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("converges concurrent session captures from independent sqlite hosts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-capture-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const firstStores = createWorkboardSqliteStores({ dbPath });
    const secondStores = createWorkboardSqliteStores({ dbPath });
    const first = new WorkboardStore(firstStores.cards);
    const second = new WorkboardStore(secondStores.cards);
    try {
      const sessionKey = `agent:main:dashboard:${"x".repeat(480)}`;
      const [left, right] = await Promise.all([
        first.captureSession({ title: "Captured by host A", sessionKey, boardId: "ops" }),
        second.captureSession({ title: "Captured by host B", sessionKey, boardId: "other" }),
      ]);

      expect(left.id).toBe(right.id);
      expect(left.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(left).toEqual(right);
      expect(["ops", "other"]).toContain(left.metadata?.automation?.boardId);
      await expect(first.list()).resolves.toEqual([left]);
    } finally {
      secondStores.close();
      firstStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converges concurrent archived session restores across sqlite hosts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-capture-restore-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const firstStores = createWorkboardSqliteStores({ dbPath });
    const secondStores = createWorkboardSqliteStores({ dbPath });
    const paused = createPausedCardStore(firstStores.cards);
    const first = new WorkboardStore(paused.store);
    const second = new WorkboardStore(secondStores.cards);
    try {
      const sessionKey = "agent:main:dashboard:archived-race";
      const captured = await second.captureSession({ title: "Captured", sessionKey });
      await second.archive(captured.id, true);

      const pause = paused.pauseNextWrite();
      const firstRestore = first.captureSession({ title: "Host A", sessionKey });
      await pause.reached;
      const secondRestore = await second.captureSession({ title: "Host B", sessionKey });
      pause.resume();
      const firstResult = await firstRestore;

      expect(firstResult).toEqual(secondRestore);
      expect(firstResult.metadata?.archivedAt).toBeUndefined();
      await expect(first.list()).resolves.toEqual([firstResult]);
    } finally {
      secondStores.close();
      firstStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows only one cross-host claim per owner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-claim-race-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const firstStores = createWorkboardSqliteStores({ dbPath });
    const secondStores = createWorkboardSqliteStores({ dbPath });
    const first = new WorkboardStore(firstStores.cards);
    const second = new WorkboardStore(secondStores.cards);
    try {
      const firstCard = await first.create({ title: "First", status: "ready", agentId: "worker" });
      const secondCard = await first.create({
        title: "Second",
        status: "ready",
        agentId: "worker",
      });

      const claims = await Promise.allSettled([
        first.claim(firstCard.id, { ownerId: "worker" }),
        second.claim(secondCard.id, { ownerId: "worker" }),
      ]);

      expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
      expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
      expect((await first.list()).filter((card) => card.status === "running")).toHaveLength(1);
    } finally {
      secondStores.close();
      firstStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the active captured session across boards and archived duplicates", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:dashboard:captured";
    const active = await store.create({ title: "Active", sessionKey, boardId: "default" });
    const historical = await store.create({ title: "Historical", sessionKey, boardId: "ops" });
    await store.archive(historical.id, true);

    const captured = await store.captureSession({
      title: "Duplicate",
      sessionKey,
      boardId: "other",
    });

    expect(captured.id).toBe(active.id);
    expect(captured.metadata?.automation?.boardId).toBe("default");
    expect((await store.list()).filter((card) => !card.metadata?.archivedAt)).toEqual([active]);

    await store.archive(active.id, true);
    const restored = await store.captureSession({ title: "Restore", sessionKey, boardId: "other" });
    expect([active.id, historical.id]).toContain(restored.id);
    expect(restored.metadata?.archivedAt).toBeUndefined();
  });

  it("uses card child indexes for per-card ordered reads", () => {
    withWorkboardSqliteDatabase("openclaw-workboard-index-read-", (db) => {
      for (const [table, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        const plan = explainWorkboardQueryPlan(
          db,
          `SELECT * FROM ${table} WHERE card_id = ? ORDER BY ordinal ASC`,
          ["card-1"],
        );
        expect(plan).toContain(index);
        expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      }
    });
  });

  it("uses card child indexes for whole-board ordered scans", () => {
    withWorkboardSqliteDatabase("openclaw-workboard-index-scan-", (db) => {
      for (const [table, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        const plan = explainWorkboardQueryPlan(
          db,
          `SELECT * FROM ${table} ORDER BY card_id ASC, ordinal ASC`,
        );
        expect(plan).toContain(index);
        expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      }
    });
  });

  it("uses card child indexes for parent-card cascades", () => {
    withWorkboardSqliteDatabase("openclaw-workboard-index-cascade-", (db) => {
      db.exec("PRAGMA foreign_keys = ON");
      const plan = explainWorkboardQueryPlan(db, "DELETE FROM workboard_cards WHERE id = ?", [
        "card-1",
      ]);
      for (const [, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        expect(plan).toContain(index);
      }
    });
  });

  it("restores dropped card child indexes without changing the schema version", () => {
    const dir = tempDirs.make("openclaw-workboard-index-reopen-");
    const dbPath = path.join(dir, "workboard.sqlite");
    const initialized = createWorkboardSqliteStores({ dbPath });
    initialized.close();
    const db = new DatabaseSync(dbPath);
    let initialMigrationIds: Array<{ id: string }>;
    try {
      initialMigrationIds = db
        .prepare("SELECT id FROM workboard_schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;
      for (const [, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        db.exec(`DROP INDEX ${index}`);
      }
    } finally {
      db.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath });
    reopened.close();
    const verified = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const indexes = new Set(
        (
          verified.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      for (const [, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        expect(indexes).toContain(index);
      }
      expect(
        verified.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all(),
      ).toEqual(initialMigrationIds);
    } finally {
      verified.close();
    }
  });

  it("persists boards, cards, subscriptions, and attachment blobs in sqlite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-sqlite-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    if (process.platform !== "win32") {
      fs.chmodSync(dir, 0o755);
    }
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const board = await store.upsertBoard({
        id: "planning",
        name: "Planning",
        automationJobId: "job-categorize-planning",
      });
      const card = await store.create({
        title: "Persist it",
        boardId: board.id,
        labels: ["sqlite", "doctor"],
        execution: {
          id: "exec-1",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "gpt-5.5",
          sessionKey: "agent:main:test",
          runId: "run-1",
          startedAt: 1,
          updatedAt: 2,
        },
      });
      const unresolvedRuntimeCard = await store.create({
        title: "Persist unresolved runtime",
        boardId: board.id,
        execution: {
          id: "exec-unresolved",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 3,
          updatedAt: 4,
        },
      });
      await store.addComment(card.id, { body: "round trip" });
      const attached = await store.addAttachment(card.id, {
        fileName: "proof.txt",
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      expect(attached.events?.at(-1)).toMatchObject({ kind: "attachment_added" });
      await store.addAttachment(card.id, {
        fileName: "large-proof.bin",
        contentBase64: Buffer.alloc(70 * 1024).toString("base64"),
      });
      await store.update(card.id, {
        metadata: { lifecycleStatusSourceUpdatedAt: 1234 },
      });
      const attachmentId = attached.metadata?.attachments?.[0]?.id;
      const subscription = await store.subscribeNotifications({
        boardId: board.id,
        target: "agent:main:test",
        eventKinds: ["completed"],
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
        for (const sidecarPath of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
          if (fs.existsSync(sidecarPath)) {
            expect(fs.statSync(sidecarPath).mode & 0o777).toBe(0o600);
          }
        }
      }
      stores.close();

      const rawDb = new DatabaseSync(dbPath);
      expect(rawDb.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
      expect(
        rawDb
          .prepare(
            `SELECT name FROM pragma_table_list
             WHERE schema = 'main'
               AND type = 'table'
               AND name NOT LIKE 'sqlite_%'
               AND strict <> 1`,
          )
          .all(),
      ).toEqual([]);
      expect(() =>
        rawDb
          .prepare("INSERT INTO workboard_attachment_blobs (attachment_id, content) VALUES (?, ?)")
          .run("wrong-type", "text-not-blob"),
      ).toThrow();
      rawDb.close();

      const reopenedStores = createWorkboardSqliteStores({ dbPath });
      const reopened = new WorkboardStore(reopenedStores.cards, {
        boards: reopenedStores.boards,
        subscriptions: reopenedStores.subscriptions,
        attachments: reopenedStores.attachments,
      });

      expect(await reopened.listBoards()).toMatchObject({
        boards: [
          expect.objectContaining({ id: "default" }),
          expect.objectContaining({
            id: board.id,
            name: "Planning",
            automationJobId: "job-categorize-planning",
          }),
        ],
      });
      expect(await reopened.get(card.id)).toMatchObject({
        id: card.id,
        labels: ["sqlite", "doctor"],
        metadata: {
          automation: { boardId: "planning" },
          lifecycleStatusSourceUpdatedAt: 1234,
          comments: [expect.objectContaining({ body: "round trip" })],
          attachments: expect.arrayContaining([
            expect.objectContaining({ fileName: "proof.txt" }),
            expect.objectContaining({ fileName: "large-proof.bin" }),
          ]),
        },
      });
      const reopenedUnresolvedRuntimeCard = await reopened.get(unresolvedRuntimeCard.id);
      expect(reopenedUnresolvedRuntimeCard?.execution).toMatchObject({
        id: "exec-unresolved",
        mode: "autonomous",
        status: "running",
      });
      expect(reopenedUnresolvedRuntimeCard?.execution).not.toHaveProperty("engine");
      expect(reopenedUnresolvedRuntimeCard?.execution).not.toHaveProperty("model");
      expect(await reopened.getAttachment(attachmentId ?? "")).toMatchObject({
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      await reopened.delete(card.id);
      expect(await reopened.getAttachment(attachmentId ?? "")).toBeUndefined();
      expect(await reopened.listNotificationSubscriptions({ boardId: board.id })).toMatchObject({
        subscriptions: [expect.objectContaining({ id: subscription.id })],
      });
      reopenedStores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists sqlite board summaries without hydrating card child rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-summary-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      let cardId = "";
      const initialStores = createWorkboardSqliteStores({ dbPath });
      try {
        const initial = new WorkboardStore(initialStores.cards, {
          boards: initialStores.boards,
          subscriptions: initialStores.subscriptions,
          attachments: initialStores.attachments,
        });
        await initial.upsertBoard({ id: "ops", name: "Ops" });
        const card = await initial.create({ title: "Summarize me", boardId: "ops" });
        cardId = card.id;
        await initial.addComment(card.id, { body: "valid before corruption" });
        const archived = await initial.create({
          title: "Summarize archived card",
          boardId: "ops",
          status: "ready",
        });
        await initial.archive(archived.id, true);
      } finally {
        initialStores.close();
      }

      const rawDb = new DatabaseSync(dbPath);
      try {
        rawDb.prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?").run(cardId);
      } finally {
        rawDb.close();
      }

      const reopenedStores = createWorkboardSqliteStores({ dbPath });
      try {
        const reopened = new WorkboardStore(reopenedStores.cards, {
          boards: reopenedStores.boards,
          subscriptions: reopenedStores.subscriptions,
          attachments: reopenedStores.attachments,
        });
        await expect(reopened.get(cardId)).rejects.toThrow(/missing body/);
        await expect(reopened.listBoards()).resolves.toMatchObject({
          boards: expect.arrayContaining([
            expect.objectContaining({
              id: "ops",
              name: "Ops",
              total: 2,
              active: 1,
              archived: 1,
              byStatus: { ready: 1, todo: 1 },
            }),
          ]),
        });
      } finally {
        reopenedStores.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a version 2 workboard table to STRICT without losing rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-strict-migration-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const initialized = createWorkboardSqliteStores({ dbPath });
    initialized.close();
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        INSERT INTO workboard_boards (
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        ) VALUES ('legacy', 'Legacy board', NULL, NULL, NULL, NULL, NULL, 1, 2, NULL);
        ALTER TABLE workboard_boards RENAME TO workboard_boards_strict;
        CREATE TABLE workboard_boards (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          icon TEXT,
          color TEXT,
          default_workspace_json TEXT,
          orchestration_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        INSERT INTO workboard_boards (
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        ) SELECT
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        FROM workboard_boards_strict;
        DROP TABLE workboard_boards_strict;
        DELETE FROM workboard_schema_migrations WHERE id = 'schema-3';
        INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at)
        VALUES ('schema-2', 1);
      `);
    } finally {
      legacy.close();
    }

    try {
      const migratedStores = createWorkboardSqliteStores({ dbPath });
      try {
        await expect(migratedStores.boards.lookup("legacy")).resolves.toMatchObject({
          board: { id: "legacy", name: "Legacy board" },
        });
      } finally {
        migratedStores.close();
      }
      const migrated = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          migrated
            .prepare("SELECT strict FROM pragma_table_list WHERE name = 'workboard_boards'")
            .get(),
        ).toEqual({ strict: 1 });
        expect(
          migrated
            .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = 'schema-3'")
            .get(),
        ).toEqual({ found: 1 });
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses rollback journaling on network-backed volumes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-sqlite-network-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0xff534d42));
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      stores.close();

      const rawDb = new DatabaseSync(dbPath);
      expect(rawDb.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "delete",
      });
      rawDb.close();
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      statfs.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["", "non-empty string"],
    ["x".repeat(129), "128 characters or fewer"],
  ])("rejects invalid automation job ids", async (automationJobId, message) => {
    const store = new WorkboardStore(createMemoryStore());

    await expect(store.upsertBoard({ id: "planning", automationJobId })).rejects.toThrow(message);
  });

  it("creates and lists cards by status order and position", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const review = await store.create({
      title: "Review release notes",
      status: "review",
      priority: "high",
      labels: "release, docs",
    });
    const todo = await store.create({ title: "Fix dashboard copy", status: "todo" });

    expect((await store.list()).map((card) => card.id)).toEqual([todo.id, review.id]);
    expect(review.labels).toEqual(["release", "docs"]);
    expect(review.priority).toBe("high");
    expect(review.events?.[0]).toMatchObject({ kind: "created", toStatus: "review" });
  });

  it("does not persist empty metadata for default cards", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const card = await store.create({ title: "Plain card" });

    expect(card.metadata).toBeUndefined();
    const entry = await keyed.lookup(card.id);
    expect(Object.hasOwn(entry?.card ?? {}, "metadata")).toBe(false);
  });

  it("preserves open execution engine identifiers without rewriting historical labels", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const runtimeCard = await store.create({
      title: "Runtime identity",
      execution: {
        id: "exec-runtime",
        kind: "agent-session",
        engine: "claude-cli",
        mode: "autonomous",
        status: "running",
        model: "anthropic/claude-sonnet-4-6",
        startedAt: 1,
        updatedAt: 1,
      },
    });
    const historicalCard = await store.create({
      title: "Historical identity",
      execution: {
        id: "exec-historical",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        startedAt: 1,
        updatedAt: 1,
      },
    });

    expect(runtimeCard.execution?.engine).toBe("claude-cli");
    expect(runtimeCard.metadata?.attempts?.[0]?.engine).toBe("claude-cli");
    expect(historicalCard.execution?.engine).toBe("codex");
  });

  it("rejects empty execution records instead of fabricating lifecycle state", () => {
    expect(normalizeExecution({})).toBeUndefined();
  });

  it("preserves explicit zero positions", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const card = await store.create({ title: "Top card", status: "todo", position: 0 });

    expect(card.position).toBe(0);
  });

  it("keeps initial session, run, and task links when creating cards", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const card = await store.create({
      title: "Follow up",
      sessionKey: "agent:main:dashboard:1",
      runId: "run-1",
      taskId: "task-1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "claude",
        mode: "manual",
        status: "running",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    expect(card).toMatchObject({
      sessionKey: "agent:main:dashboard:1",
      runId: "run-1",
      taskId: "task-1",
      execution: {
        engine: "claude",
        mode: "manual",
        model: "anthropic/claude-sonnet-4-6",
      },
      metadata: {
        attempts: [
          expect.objectContaining({
            id: "agent:main:dashboard:1",
            status: "running",
            engine: "claude",
            mode: "manual",
            sessionKey: "agent:main:dashboard:1",
            startedAt: 10,
          }),
        ],
      },
    });
  });

  it("ignores dependency links from generic metadata writes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent" });
    const child = await store.create({
      title: "Child",
      metadata: {
        links: [{ id: "raw-parent", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    });

    expect(child.metadata?.links).toBeUndefined();

    const updated = await store.update(child.id, {
      metadata: {
        links: [{ id: "raw-parent-2", type: "parent", targetCardId: parent.id, createdAt: 2 }],
      },
    });
    expect(updated.metadata?.links).toBeUndefined();
  });

  it("stores card templates and metadata in the card record", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const card = await store.create({
      title: "Fix flaky lane",
      templateId: "bugfix",
      metadata: {
        comments: [{ id: "comment-1", body: "Seen twice", createdAt: 10 }],
        links: [{ id: "link-1", type: "blocks", targetCardId: "card-2", createdAt: 11 }],
        proof: [{ id: "proof-1", status: "passed", command: "pnpm test", createdAt: 12 }],
      },
    });

    await expect(keyed.lookup(card.id)).resolves.toMatchObject({
      version: 1,
      card: {
        metadata: {
          templateId: "bugfix",
          comments: [expect.objectContaining({ body: "Seen twice" })],
          links: [expect.objectContaining({ type: "blocks", targetCardId: "card-2" })],
          proof: [expect.objectContaining({ status: "passed", command: "pnpm test" })],
        },
      },
    });
  });

  it("updates automation metadata from top-level patch fields", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Tune automation" });

    const updated = await store.update(card.id, {
      tenant: "release",
      idempotencyKey: "release:1",
      skills: ["testing", "docs"],
      workspace: { kind: "scratch" },
      maxRuntimeSeconds: 120,
      maxRetries: 2,
      scheduledAt: 10_000,
    });

    expect(updated.metadata?.automation).toMatchObject({
      tenant: "release",
      idempotencyKey: "release:1",
      skills: ["testing", "docs"],
      workspace: { kind: "scratch" },
      maxRuntimeSeconds: 120,
      maxRetries: 2,
      scheduledAt: 10_000,
    });

    const cleared = await store.update(card.id, { scheduledAt: null });
    expect(cleared.metadata?.automation?.scheduledAt).toBeUndefined();
    expect(cleared.metadata?.automation).toMatchObject({
      tenant: "release",
      maxRetries: 2,
    });

    const preserved = await store.update(card.id, {
      scheduledAt: 20_000,
      maxRuntimeSeconds: undefined,
    });
    expect(preserved.metadata?.automation).toMatchObject({
      scheduledAt: 20_000,
      maxRuntimeSeconds: 120,
    });
  });

  it("only accepts workspace authority from trusted top-level provenance", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Restricted card",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      metadata: {
        automation: { workspaceAccess: { unrestricted: true } },
      },
    });

    expect(card.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: false,
      roots: ["/workspace"],
      writable: true,
    });

    const updated = await store.update(card.id, {
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    expect(updated.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: false,
      roots: ["/workspace"],
      writable: true,
    });

    const untrusted = await store.create({
      title: "Untrusted metadata",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    expect(untrusted.metadata?.automation?.workspaceAccess).toBeUndefined();
  });

  it("only accepts launch state from store-owned transitions", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Trusted launch",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: {
        automation: {
          launch: {
            phase: "prepared",
            requestedSessionKey: "injected-session",
            provisionalRunId: "injected-run",
            preparedAt: 1,
          },
        },
      },
    });
    expect(card.metadata?.automation?.launch).toBeUndefined();

    const claimed = await store.claim(card.id, { ownerId: "worker", token: "claim-token" });
    const prepared = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-trusted",
      now: 100,
      scope: { ownerId: "worker", token: claimed.token },
    });
    const updated = await store.update(card.id, {
      metadata: {
        automation: {
          launch: {
            ...prepared.launch,
            phase: "accepted",
            acceptedAt: 101,
            acceptedSessionKey: "agent:injected:subagent:workboard-default-trusted",
            acceptedRunId: "injected-accepted-run",
          },
        },
      },
    });

    expect(updated.metadata?.automation?.launch).toEqual(prepared.launch);
  });

  it("does not let a delayed launch failure overwrite a newer retry", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Retried launch", status: "ready" });
    const firstClaim = await store.claim(card.id, { ownerId: "worker" });
    const first = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-retried",
      now: 100,
      scope: { ownerId: "worker", token: firstClaim.token },
    });
    await store.failPreparedLaunch(card.id, {
      expectedLaunch: first.launch,
      reason: "first launch failed",
      failedAt: 101,
    });
    await store.unblock(card.id);
    const retryClaim = await store.claim(card.id, { ownerId: "worker" });
    const retry = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-retried",
      now: 200,
      scope: { ownerId: "worker", token: retryClaim.token },
    });

    await expect(
      store.failPreparedLaunch(card.id, {
        expectedLaunch: first.launch,
        reason: "delayed first failure",
        failedAt: 201,
      }),
    ).resolves.toBe(false);
    await expect(
      store.syncLifecycle(card.id, {
        targetStatus: "review",
        executionStatus: "review",
        sourceUpdatedAt: undefined,
        stale: undefined,
        now: 202,
        association: {
          expectedSessionKey: retry.launch.requestedSessionKey,
          expectedRunId: retry.launch.provisionalRunId,
          sessionKey: `agent:worker:${retry.launch.requestedSessionKey}`,
          acceptedAt: 150,
        },
      }),
    ).resolves.toBe(false);
    expect((await store.get(card.id))?.metadata?.automation?.launch).toEqual(retry.launch);
  });

  it("moves cards and records lifecycle timestamps", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Ship workboard" });

    const running = await store.move(card.id, "running", 500);
    expect(running.status).toBe("running");
    expect(running.position).toBe(500);
    expect(running.startedAt).toBeGreaterThanOrEqual(card.createdAt);
    expect(running.events?.at(-1)).toMatchObject({
      kind: "moved",
      fromStatus: "todo",
      toStatus: "running",
    });

    const done = await store.update(card.id, { status: "done" });
    expect(done.completedAt).toBeGreaterThanOrEqual(done.startedAt ?? 0);

    const rolledBack = await store.update(card.id, {
      status: "todo",
      startedAt: null,
      completedAt: null,
    });
    expect(rolledBack.startedAt).toBeUndefined();
    expect(rolledBack.completedAt).toBeUndefined();
  });

  it("tracks lifecycle status provenance and clears it on manual status changes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Sync status provenance" });

    const zeroSourceLifecycle = await store.update(card.id, {
      status: "running",
      metadata: { lifecycleStatusSourceUpdatedAt: 0 },
    });
    expect(zeroSourceLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(0);

    const lifecycleMoved = await store.update(card.id, {
      status: "running",
      metadata: { lifecycleStatusSourceUpdatedAt: 1000 },
    });
    expect(lifecycleMoved.metadata?.lifecycleStatusSourceUpdatedAt).toBe(1000);

    const newerLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 3000 },
    });
    expect(newerLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(3000);

    const manual = await store.move(card.id, "running", 2000);
    expect(manual.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const staleZeroLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 0 },
    });
    expect(staleZeroLifecycle).toEqual(manual);
    expect(staleZeroLifecycle.status).toBe("running");
    expect(staleZeroLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const staleLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
    });
    expect(staleLifecycle).toEqual(manual);
    expect(staleLifecycle.status).toBe("running");
    expect(staleLifecycle.updatedAt).toBe(manual.updatedAt);
    expect(staleLifecycle.events).toHaveLength(manual.events?.length ?? 0);
    expect(staleLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const freshLifecycleSourceUpdatedAt = Date.now() + 1000;
    const freshLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: freshLifecycleSourceUpdatedAt },
    });
    expect(freshLifecycle.status).toBe("review");
    expect(freshLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(
      freshLifecycleSourceUpdatedAt,
    );
  });

  it("keeps creation status from stale lifecycle patches", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Initial running status",
        status: "running",
      });

      const staleLifecycle = await store.update(card.id, {
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 1000 },
      });
      expect(staleLifecycle).toEqual(card);
      expect(staleLifecycle.status).toBe("running");
      expect(staleLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

      const freshLifecycle = await store.update(card.id, {
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 3000 },
      });
      expect(freshLifecycle.status).toBe("review");
      expect(freshLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let one stale bulk lifecycle patch strip later card updates", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const store = new WorkboardStore(createMemoryStore());
      const staleCard = await store.create({ title: "Stale bulk target" });
      const freshCard = await store.create({ title: "Fresh bulk target" });
      vi.setSystemTime(3000);
      await store.move(staleCard.id, "running", 1000);

      const patch = {
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
      } as const;
      const result = await store.bulkUpdate({
        ids: [staleCard.id, freshCard.id],
        patch,
      });

      expect(result.cards[0]).toMatchObject({ id: staleCard.id, status: "running" });
      expect(result.cards[0]?.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
      expect(result.cards[1]).toMatchObject({ id: freshCard.id, status: "review" });
      expect(result.cards[1]?.metadata?.lifecycleStatusSourceUpdatedAt).toBe(2000);
      expect(patch).toEqual({
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps non-status fields from stale lifecycle patches", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Keep stale sync details",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 1,
        updatedAt: 1000,
      },
    });
    const lifecycleMoved = await store.update(card.id, {
      status: "review",
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: {
          detectedAt: 1000,
          lastSessionUpdatedAt: 1000,
          reason: "Session has not reported recent activity.",
        },
      },
    });
    const manual = await store.update(card.id, {
      status: "running",
      metadata: lifecycleMoved.metadata,
    });

    const synced = await store.update(card.id, {
      status: "review",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "done",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 1,
        updatedAt: 2000,
      },
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: null,
      },
    });

    expect(manual.metadata?.stale).toBeDefined();
    expect(synced.status).toBe("running");
    expect(synced.execution).toMatchObject({
      runId: "run-1",
      status: "done",
      updatedAt: 2000,
    });
    expect(synced.metadata?.stale).toBeUndefined();
    expect(synced.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
    expect(synced.events?.at(-1)).toMatchObject({
      kind: "attempt_updated",
      runId: "run-1",
    });
  });

  it("clears copied lifecycle provenance on manual status patches", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Clear copied provenance" });
    const lifecycleMoved = await store.update(card.id, {
      status: "review",
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: {
          kind: "session",
          status: "done",
          updatedAt: 1000,
          observedAt: 1000,
        },
      },
    });

    const manual = await store.update(card.id, {
      status: "running",
      metadata: {
        ...lifecycleMoved.metadata,
        stale: null,
      },
    });

    expect(manual.status).toBe("running");
    expect(manual.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const staleLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 1000 },
    });
    expect(staleLifecycle.status).toBe("running");
    expect(staleLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
  });

  it("keeps execution session links aligned with edited card links", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Relink me",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const relinked = await store.update(card.id, { sessionKey: "agent:main:dashboard:2" });
    expect(relinked.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.execution?.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.events?.at(-1)).toMatchObject({
      kind: "linked",
      sessionKey: "agent:main:dashboard:2",
    });

    const unlinked = await store.update(card.id, { sessionKey: "" });
    expect(unlinked.sessionKey).toBeUndefined();
    expect(unlinked.execution?.sessionKey).toBeUndefined();

    const cleared = await store.update(card.id, { execution: null });
    expect(cleared.execution).toBeUndefined();
  });

  it("tracks execution attempts as card metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Run worker" });

    const running = await store.update(card.id, {
      status: "running",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    expect(running.metadata?.attempts).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "running",
        engine: "codex",
        runId: "run-1",
      }),
    ]);
    expect(running.events?.at(-1)).toMatchObject({ kind: "moved" });

    const blocked = await store.update(card.id, {
      execution: {
        ...running.execution!,
        status: "blocked",
        updatedAt: 20,
      },
    });

    expect(blocked.metadata?.attempts?.[0]).toMatchObject({
      status: "blocked",
      endedAt: 20,
    });
    expect(blocked.metadata?.failureCount).toBe(1);
    expect(blocked.events?.at(-1)).toMatchObject({ kind: "attempt_updated", runId: "run-1" });

    const commented = await store.addComment(card.id, { body: "Need provider follow-up." });
    expect(commented.metadata?.failureCount).toBe(1);
    expect(commented.metadata?.attempts?.[0]).toMatchObject({
      status: "blocked",
      endedAt: 20,
    });

    const retrying = await store.update(card.id, {
      execution: {
        ...running.execution!,
        id: "exec-2",
        runId: "run-2",
        status: "running",
        startedAt: 30,
        updatedAt: 30,
      },
    });
    expect(retrying.metadata?.failureCount).toBe(1);
    expect(retrying.metadata?.attempts?.[1]).toMatchObject({
      id: "run-2",
      startedAt: 30,
      status: "running",
    });

    const blockedAgain = await store.update(card.id, {
      execution: {
        ...retrying.execution!,
        status: "blocked",
        updatedAt: 40,
      },
    });
    expect(blockedAgain.metadata?.failureCount).toBe(2);
  });

  it("adds comments, links, proof, and archive metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Track proof" });

    const commented = await store.addComment(card.id, { body: "Reviewer asked for screenshots." });
    expect(commented.metadata?.comments?.[0]).toMatchObject({
      body: "Reviewer asked for screenshots.",
    });
    expect(commented.events?.at(-1)).toMatchObject({ kind: "comment_added" });

    const linked = await store.addLink(card.id, {
      type: "blocked_by",
      targetCardId: "card-upstream",
      title: "Upstream fix",
    });
    expect(linked.metadata?.links?.[0]).toMatchObject({
      type: "blocked_by",
      targetCardId: "card-upstream",
    });
    expect(linked.events?.at(-1)).toMatchObject({ kind: "link_added" });
    await expect(
      store.addLink(card.id, { type: "parent", targetCardId: "card-upstream" }),
    ).rejects.toThrow(/linkDependency/);

    const proven = await store.addProof(card.id, {
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(proven.metadata?.proof?.[0]).toMatchObject({
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(proven.events?.at(-1)).toMatchObject({ kind: "proof_added" });

    const artifacted = await store.addArtifact(card.id, {
      label: "Screenshot",
      path: "/tmp/workboard.png",
      mimeType: "image/png",
    });
    expect(artifacted.metadata?.artifacts?.[0]).toMatchObject({
      label: "Screenshot",
      path: "/tmp/workboard.png",
    });
    expect(artifacted.events?.at(-1)).toMatchObject({ kind: "artifact_added" });

    const archived = await store.archive(card.id, true);
    expect(archived.metadata?.archivedAt).toBeGreaterThan(0);
    expect(archived.events?.at(-1)).toMatchObject({ kind: "archived" });

    const restored = await store.archive(card.id, false);
    expect(restored.metadata?.archivedAt).toBeUndefined();
    expect(restored.events?.at(-1)).toMatchObject({ kind: "unarchived" });
  });

  it("ignores caller-supplied archivedAt on create so no card is born archived", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Injected archive",
      metadata: { archivedAt: Date.now() },
    });

    // Archival is a transition owned by archive(), which appends the matching
    // event. Honouring it here would exclude the card from dispatch from birth
    // with an event log recording only "created".
    expect(card.metadata?.archivedAt).toBeUndefined();
    expect(card.events?.map((event) => event.kind)).toEqual(["created"]);

    const archived = await store.archive(card.id, true);
    expect(archived.metadata?.archivedAt).toBeGreaterThan(0);
    expect(archived.events?.at(-1)).toMatchObject({ kind: "archived" });
  });

  it("resolves matching unknown proof on completion without duplicating it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Resolve worker proof", status: "running" });
      const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });
      const proofInput = {
        label: "Haiku syllable check",
        command: "review poem",
        note: "Checked each line.",
      };
      const pending = await store.addProof(claimed.card.id, proofInput, {
        ownerId: "main",
        token: "token-1",
      });

      vi.setSystemTime(6_000);
      const completed = await store.complete(claimed.card.id, {
        ownerId: "main",
        token: "token-1",
        summary: "Poem complete.",
        proofId: pending.metadata?.proof?.[0]?.id,
        proof: { ...proofInput, status: "passed" },
      });

      expect(completed.metadata?.proof).toEqual([
        {
          ...pending.metadata?.proof?.[0],
          status: "passed",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the correlated proof when metadata budget trimming is required", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Keep proof under metadata pressure",
      status: "running",
      metadata: {
        artifacts: Array.from({ length: 12 }, (_, index) => ({
          id: `artifact-${index}`,
          createdAt: index + 1,
          url: `https://example.com/${index}/${"x".repeat(1900)}`,
        })),
      },
    });
    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });
    const artifactCountBefore = claimed.card.metadata?.artifacts?.length ?? 0;
    expect(artifactCountBefore).toBeGreaterThan(5);

    const proofInput = {
      command: "pnpm test extensions/workboard",
      note: "y".repeat(1800),
    };
    const pending = await store.addProof(card.id, proofInput, {
      ownerId: "main",
      token: "token-1",
    });
    const pendingProof = pending.metadata?.proof?.at(-1);
    expect(pendingProof).toMatchObject({ status: "unknown", command: proofInput.command });
    expect(pending.metadata?.artifacts?.length ?? 0).toBeLessThan(artifactCountBefore);
    expect(Buffer.byteLength(JSON.stringify(pending.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );

    const completed = await store.complete(card.id, {
      ownerId: "main",
      token: "token-1",
      summary: "Proof survived metadata trimming.",
      proofId: pendingProof?.id,
      proof: { ...proofInput, status: "passed" },
    });

    expect(completed.metadata?.proof).toEqual([{ ...pendingProof, status: "passed" }]);
    expect(Buffer.byteLength(JSON.stringify(completed.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );
  });

  it("keeps identical completion proof append-only without an explicit proof id", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const proofInput = { command: "pnpm test extensions/workboard", note: "94 tests" };
    const card = await store.create({
      title: "Preserve historical proof",
      metadata: {
        proof: [{ id: "proof-unknown", status: "unknown", createdAt: 1_000, ...proofInput }],
      },
    });

    const failed = await store.complete(card.id, {
      summary: "A later run failed.",
      proof: { ...proofInput, status: "failed" },
    });

    expect(failed.metadata?.proof?.map((entry) => [entry.id, entry.status])).toEqual([
      ["proof-unknown", "unknown"],
      [expect.any(String), "failed"],
    ]);
  });

  it("resolves only the explicitly correlated proof across identical retries", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const proofInput = { command: "review poem", note: "Checked each line." };
    const card = await store.create({
      title: "Keep unresolved proof history",
      metadata: {
        proof: [
          { id: "proof-older", status: "unknown", createdAt: 1_000, ...proofInput },
          { id: "proof-latest", status: "unknown", createdAt: 2_000, ...proofInput },
        ],
      },
    });

    const completed = await store.complete(card.id, {
      summary: "Latest check passed.",
      proofId: "proof-latest",
      proof: { ...proofInput, status: "passed" },
    });

    expect(completed.metadata?.proof?.map((entry) => [entry.id, entry.status])).toEqual([
      ["proof-older", "unknown"],
      ["proof-latest", "passed"],
    ]);
  });

  it("reuses an explicitly correlated terminal proof with the same status", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const proof = {
      id: "proof-passed",
      status: "passed" as const,
      createdAt: 1_000,
      command: "pnpm test extensions/workboard",
    };
    const card = await store.create({
      title: "Reuse terminal proof",
      metadata: { proof: [proof] },
    });

    const completed = await store.complete(card.id, {
      summary: "Already passed.",
      proofId: proof.id,
      proof: { status: "passed", command: proof.command },
    });

    expect(completed.metadata?.proof).toEqual([proof]);
  });

  it("rejects an explicitly correlated terminal proof with a different status", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Reject terminal status rewrite",
      metadata: {
        proof: [{ id: "proof-passed", status: "passed", createdAt: 1_000 }],
      },
    });

    await expect(
      store.complete(card.id, {
        proofId: "proof-passed",
        proof: { status: "failed" },
      }),
    ).rejects.toThrow("completion proof status does not match existing proof: proof-passed");
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "todo",
      metadata: { proof: [{ id: "proof-passed", status: "passed" }] },
    });
  });

  it("rejects a completion proof id when its evidence does not match", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Reject mismatched proof",
      metadata: {
        proof: [
          {
            id: "proof-pending",
            status: "unknown",
            createdAt: 1_000,
            command: "pnpm test extensions/workboard",
          },
        ],
      },
    });

    await expect(
      store.complete(card.id, {
        proofId: "proof-pending",
        proof: { status: "passed", command: "pnpm test extensions/other" },
      }),
    ).rejects.toThrow("completion proof does not match pending proof: proof-pending");
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "todo",
      metadata: { proof: [{ id: "proof-pending", status: "unknown" }] },
    });
  });

  it("stores attachments in the plugin kv namespace and adds worker context", async () => {
    const attachments = createMemoryStore<PersistedWorkboardAttachment>();
    const store = new WorkboardStore(createMemoryStore(), { attachments });
    const card = await store.create({ title: "Review attached log" });

    const attached = await store.addAttachment(card.id, {
      fileName: "failure.log",
      mimeType: "text/plain",
      note: "Captured failing run",
      contentBase64: Buffer.from("stack trace").toString("base64"),
    });

    expect(attached.metadata?.attachments?.[0]).toMatchObject({
      fileName: "failure.log",
      byteSize: "stack trace".length,
      mimeType: "text/plain",
    });
    expect(attached.events?.at(-1)).toMatchObject({ kind: "attachment_added" });
    const attachment = attached.metadata?.attachments?.[0];
    if (!attachment) {
      throw new Error("expected attachment metadata");
    }
    const persisted = await store.getAttachment(attachment.id);
    if (!persisted) {
      throw new Error("expected persisted attachment");
    }
    expect(Buffer.from(persisted.contentBase64, "base64").toString("utf8")).toBe("stack trace");
    await expect(
      store.addAttachment(card.id, {
        fileName: "huge.bin",
        contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64"),
      }),
    ).rejects.toThrow(/attachment must be/);
    await expect(
      store.addAttachment(card.id, {
        fileName: "sqlite-sized.bin",
        contentBase64: Buffer.alloc(70 * 1024).toString("base64"),
      }),
    ).resolves.toMatchObject({
      metadata: {
        attachments: expect.arrayContaining([
          expect.objectContaining({ fileName: "sqlite-sized.bin" }),
        ]),
      },
    });
    await expect(
      store.addAttachment(card.id, {
        fileName: "padded.txt",
        contentBase64: `${Buffer.from("ok").toString("base64")}\n`,
      }),
    ).rejects.toThrow(/canonical base64/);

    const context = await store.buildWorkerContext(card.id);
    expect(context).toContain("failure.log");

    const deleted = await store.deleteAttachment(card.id, attachment.id);
    expect(deleted.metadata?.attachments).toEqual([
      expect.objectContaining({ fileName: "sqlite-sized.bin" }),
    ]);
    expect(deleted.events?.at(-1)).toMatchObject({ kind: "edited" });
    expect(await store.getAttachment(attachment.id)).toBeUndefined();
  });

  it("removes attachment blobs when the card attachment index prunes old entries", async () => {
    const attachments = createMemoryStore<PersistedWorkboardAttachment>();
    const store = new WorkboardStore(createMemoryStore(), { attachments });
    const card = await store.create({ title: "Many attachments" });
    let firstAttachmentId = "";

    for (let index = 0; index < 21; index += 1) {
      const updated = await store.addAttachment(card.id, {
        fileName: `log-${index}.txt`,
        contentBase64: Buffer.from(`log ${index}`).toString("base64"),
      });
      firstAttachmentId ||= updated.metadata?.attachments?.[0]?.id ?? "";
    }

    const saved = await store.get(card.id);
    expect(saved?.metadata?.attachments).toHaveLength(20);
    expect(await store.getAttachment(firstAttachmentId)).toBeUndefined();
    const exported = await store.exportCards();
    expect(exported.attachments).toHaveLength(20);
    expect(exported.attachments[0]).not.toHaveProperty("contentBase64");
  });

  it("records worker logs and protocol violations on cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protocol card",
      status: "running",
      sessionKey: "session-protocol",
      runId: "run-protocol",
      execution: {
        id: "exec-protocol",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const logged = await store.addWorkerLog(card.id, {
      level: "warning",
      message: "Worker nearing timeout.",
    });
    expect(logged.metadata?.workerLogs?.[0]).toMatchObject({
      level: "warning",
      message: "Worker nearing timeout.",
    });
    expect(logged.events?.at(-1)).toMatchObject({ kind: "orchestration" });

    const violated = await store.recordProtocolViolation(card.id, {
      detail: "Worker exited without workboard_complete.",
      sessionKey: "observed-session",
      runId: "observed-run",
    });
    expect(violated.status).toBe("blocked");
    expect(violated.execution?.status).toBe("blocked");
    expect(violated.metadata?.attempts).toEqual([
      expect.objectContaining({
        status: "blocked",
        error: "Worker exited without workboard_complete.",
      }),
    ]);
    expect(violated.metadata?.workerProtocol).toMatchObject({
      state: "violated",
      detail: "Worker exited without workboard_complete.",
    });
    expect(violated.metadata?.failureCount).toBe(1);
    expect(violated.metadata?.notifications).toEqual([
      expect.objectContaining({
        kind: "failed",
        sessionKey: "observed-session",
        runId: "observed-run",
      }),
    ]);
    expect(violated.events?.at(-1)).toMatchObject({ kind: "protocol_violation" });
  });

  it("keeps concurrent metadata appends from dropping siblings", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Collect notes" });

    await Promise.all([
      store.addComment(card.id, { body: "First note." }),
      store.addComment(card.id, { body: "Second note." }),
    ]);

    const saved = await store.get(card.id);
    expect(saved?.metadata?.comments?.map((comment) => comment.body).toSorted()).toEqual([
      "First note.",
      "Second note.",
    ]);
  });

  it("keeps metadata under the keyed-store value budget", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Collect a lot of notes" });

    for (let index = 0; index < 50; index += 1) {
      await store.addComment(card.id, {
        body: `${String(index).padStart(2, "0")} ${"x".repeat(1990)}`,
      });
    }

    const saved = await store.get(card.id);
    expect(Buffer.byteLength(JSON.stringify(saved?.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(saved?.metadata?.comments?.at(-1)?.body).toContain("49 ");
    expect(saved?.metadata?.comments?.length).toBeLessThan(50);
  });

  it("records append events when metadata retention drops old comments", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Track retained comments" });

    let updated = card;
    for (let index = 0; index < 51; index += 1) {
      updated = await store.addComment(card.id, { body: `Note ${index}` });
    }

    expect(updated.metadata?.comments).toHaveLength(50);
    expect(updated.metadata?.comments?.at(0)?.body).toBe("Note 1");
    expect(updated.events?.at(-1)).toMatchObject({ kind: "comment_added" });
  });

  it("keeps queued metadata when lifecycle updates add stale state", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Sync stale state" });

    await Promise.all([
      store.update(card.id, {
        status: "running",
        metadata: {
          stale: {
            detectedAt: 10,
            lastSessionUpdatedAt: 1,
            reason: "Linked session has not reported recent activity.",
          },
        },
      }),
      store.addComment(card.id, { body: "Operator note." }),
    ]);

    const saved = await store.get(card.id);
    expect(saved?.status).toBe("running");
    expect(saved?.metadata?.stale?.lastSessionUpdatedAt).toBe(1);
    expect(saved?.metadata?.comments?.map((comment) => comment.body)).toContain("Operator note.");
  });

  it("exports card records with metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Export me", templateId: "docs" });

    await expect(store.exportCards()).resolves.toMatchObject({
      cards: [expect.objectContaining({ id: card.id, metadata: { templateId: "docs" } })],
      exportedAt: expect.any(Number),
    });
  });

  it("claims cards, heartbeats, and releases the claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Coordinate worker", status: "todo" });

    const claimed = await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

    expect(claimed.token).toBeTruthy();
    expect(claimed.card.status).toBe("running");
    expect(claimed.card.agentId).toBeUndefined();
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main" });

    await expect(store.claim(card.id, { ownerId: "other" })).rejects.toThrow(/already claimed/);

    const heartbeat = await store.heartbeat(card.id, {
      ownerId: "main",
      note: "Still running tests.",
    });
    expect(heartbeat.events?.at(-1)).toMatchObject({ kind: "heartbeat" });
    expect(heartbeat.metadata?.comments?.at(-1)?.body).toBe("Still running tests.");

    await expect(store.heartbeat(card.id, { ownerId: "other" })).rejects.toThrow(/owner/);

    const released = await store.releaseClaim(card.id, { ownerId: "main", status: "review" });
    expect(released.status).toBe("review");
    expect(released.metadata?.claim).toBeUndefined();

    const tokenCard = await store.create({ title: "Token-authorized worker", status: "todo" });
    const tokenClaim = await store.claim(tokenCard.id, { ownerId: "main", ttlSeconds: 60 });

    await expect(
      store.heartbeat(tokenCard.id, { ownerId: "other", token: "wrong-token" }),
    ).rejects.toThrow(/token does not match/);
    await expect(
      store.heartbeat(tokenCard.id, { ownerId: "other", token: tokenClaim.token }),
    ).resolves.toMatchObject({ metadata: { claim: { ownerId: "main" } } });

    await expect(
      store.releaseClaim(tokenCard.id, { ownerId: "other", token: "wrong-token" }),
    ).rejects.toThrow(/token does not match/);
    const tokenReleased = await store.releaseClaim(tokenCard.id, {
      ownerId: "other",
      token: tokenClaim.token,
    });
    expect(tokenReleased.metadata?.claim).toBeUndefined();
  });

  it("atomically guards and adopts dispatcher workspace authority", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Legacy dispatch", status: "ready" });
    const expectedAuthority = {
      boardId: "default",
      status: card.status,
      agentId: card.agentId,
      workspace: card.metadata?.automation?.workspace,
      workspaceAccess: card.metadata?.automation?.workspaceAccess,
    };
    await store.update(card.id, {
      workspace: { kind: "dir", path: "/restricted" },
      workspaceAccess: { unrestricted: false, roots: ["/restricted"], writable: true },
    });

    await expect(
      store.claim(
        card.id,
        { ownerId: "dispatcher" },
        { expectedAuthority, adoptWorkspaceAccess: { unrestricted: true } },
      ),
    ).rejects.toThrow("card workspace authority changed before claim");
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          workspaceAccess: {
            unrestricted: false,
            roots: ["/restricted"],
            writable: true,
          },
        },
      },
    });

    const legacy = await store.create({ title: "Legacy scratch", status: "ready" });
    const claimed = await store.claim(
      legacy.id,
      { ownerId: "dispatcher" },
      {
        expectedAuthority: {
          boardId: "default",
          status: legacy.status,
          agentId: legacy.agentId,
          workspace: legacy.metadata?.automation?.workspace,
          workspaceAccess: legacy.metadata?.automation?.workspaceAccess,
        },
        adoptWorkspaceAccess: { unrestricted: true },
      },
    );
    expect(claimed.card.metadata?.automation?.workspaceAccess).toEqual({ unrestricted: true });
  });

  it("reports an active claim after a dependency-backed card starts running", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });

    await store.claim(child.id, { ownerId: "main", ttlSeconds: 60 });

    await expect(store.claim(child.id, { ownerId: "other" })).rejects.toThrow(
      "card already claimed by main.",
    );
  });

  it("protects a running worker's expired claim throughout its heartbeat grace period", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Grace-protected worker", status: "ready" });
      const claimed = await store.claim(card.id, { ownerId: "original", ttlSeconds: 1 });
      const expiresAt = claimed.card.metadata?.claim?.expiresAt;
      if (expiresAt === undefined) {
        throw new Error("expected a timed worker claim");
      }

      vi.setSystemTime(expiresAt + 1);
      await expect(store.claim(card.id, { ownerId: "replacement" })).rejects.toThrow(
        "card already claimed by original.",
      );
      const renewed = await store.heartbeat(card.id, {
        ownerId: "original",
        token: claimed.token,
      });
      const renewedExpiresAt = renewed.metadata?.claim?.expiresAt;
      if (renewedExpiresAt === undefined) {
        throw new Error("expected the worker heartbeat to renew its claim");
      }

      vi.setSystemTime(renewedExpiresAt + 5 * 60_000);
      await expect(store.claim(card.id, { ownerId: "replacement" })).rejects.toThrow(
        "card already claimed by original.",
      );

      vi.setSystemTime(renewedExpiresAt + 5 * 60_000 + 1);
      const replacement = await store.claim(card.id, { ownerId: "replacement" });
      expect(replacement.card.metadata?.claim?.ownerId).toBe("replacement");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves scheduled and retry-budget errors when a claim is active", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const scheduled = await store.create({ title: "Scheduled", status: "ready" });
      await store.claim(scheduled.id, { ownerId: "main", ttlSeconds: 60 });
      await store.update(scheduled.id, { status: "scheduled", scheduledAt: 10_000 });

      const exhausted = await store.create({
        title: "Exhausted",
        status: "ready",
        maxRetries: 1,
        metadata: { failureCount: 1 },
      });
      await store.claim(exhausted.id, { ownerId: "main", ttlSeconds: 60 });
      await store.update(exhausted.id, { metadata: { failureCount: 2 } });

      await expect(store.claim(scheduled.id, { ownerId: "other" })).rejects.toThrow(
        "card is scheduled for later.",
      );
      await expect(store.claim(exhausted.id, { ownerId: "other" })).rejects.toThrow(
        "card exhausted its retry budget.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized claim TTL seconds to a valid Date timestamp", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Bound claim", status: "todo" });

      const claimed = await store.claim(card.id, {
        ownerId: "main",
        ttlSeconds: Number.MAX_SAFE_INTEGER,
      });

      expect(claimed.card.metadata?.claim?.expiresAt).toBe(MAX_DATE_TIMESTAMP_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let invalid stored claim expiry block a fresh claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Invalid claim expiry",
      status: "todo",
      metadata: {
        claim: {
          ownerId: "stale-worker",
          token: "stale-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Number.MAX_VALUE,
        },
      },
    });

    const claimed = await store.claim(card.id, { ownerId: "main", token: "fresh-token" });

    expect(claimed.card.metadata?.claim).toMatchObject({
      ownerId: "main",
      token: "fresh-token",
    });
  });

  it("creates idempotent child cards and promotes them when parents finish", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({
      title: "Child",
      status: "todo",
      parents: [parent.id],
      tenant: "release",
      idempotencyKey: "fanout:1",
      skills: ["testing"],
      workspace: { kind: "scratch" },
    });

    expect(child.status).toBe("todo");
    expect(child.metadata?.links).toEqual([
      expect.objectContaining({ type: "parent", targetCardId: parent.id }),
    ]);
    await expect(store.get(parent.id)).resolves.toMatchObject({
      metadata: { links: [expect.objectContaining({ type: "child", targetCardId: child.id })] },
    });
    await expect(
      store.create({
        title: "Duplicate child",
        tenant: "release",
        idempotencyKey: "fanout:1",
      }),
    ).resolves.toMatchObject({ id: child.id });
    await expect(
      store.create({
        title: "Different tenant child",
        tenant: "qa",
        idempotencyKey: "fanout:1",
      }),
    ).resolves.toMatchObject({ title: "Different tenant child" });
    await expect(
      store.create({ title: "Unscoped child", idempotencyKey: "fanout:1" }),
    ).resolves.toMatchObject({ title: "Unscoped child" });

    await store.complete(parent.id, { summary: "Parent done." });
    const promoted = await store.promoteReady();

    expect(promoted.cards).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          tenant: "release",
          idempotencyKey: "fanout:1",
          skills: ["testing"],
          workspace: { kind: "scratch" },
        },
      },
    });
  });

  it("returns an idempotent child retry when its original parent was deleted", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Ephemeral parent" });
    const child = await store.create({
      title: "Retryable child",
      parents: [parent.id],
      tenant: "release",
      idempotencyKey: "fanout:deleted-parent",
    });

    await store.delete(parent.id);

    await expect(
      store.create({
        title: "Retryable child",
        parents: [parent.id],
        tenant: "release",
        idempotencyKey: "fanout:deleted-parent",
      }),
    ).resolves.toMatchObject({ id: child.id });
  });

  it("accepts POSIX and Windows absolute directory workspaces", async () => {
    const store = new WorkboardStore(createMemoryStore());

    await expect(
      store.create({
        title: "POSIX workspace",
        workspace: { kind: "dir", path: "/Users/me/repo" },
      }),
    ).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/Users/me/repo" } } },
    });
    await expect(
      store.create({
        title: "Windows drive workspace",
        workspace: { kind: "dir", path: String.raw`C:\Users\me\repo` },
      }),
    ).resolves.toMatchObject({
      metadata: {
        automation: { workspace: { kind: "dir", path: String.raw`C:\Users\me\repo` } },
      },
    });
    await expect(
      store.create({
        title: "Windows UNC workspace",
        workspace: { kind: "dir", path: String.raw`\\server\share\repo` },
      }),
    ).resolves.toMatchObject({
      metadata: {
        automation: { workspace: { kind: "dir", path: String.raw`\\server\share\repo` } },
      },
    });
    await expect(
      store.create({ title: "Relative workspace", workspace: { kind: "dir", path: "repo" } }),
    ).rejects.toThrow(/absolute/);
  });

  it("keeps future scheduled cards scheduled until their time arrives", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Later",
        status: "scheduled",
        scheduledAt: 10_000,
      });
      const manual = await store.create({
        title: "Manual scheduled",
        status: "scheduled",
      });
      const implicit = await store.create({
        title: "Implicit later",
        scheduledAt: 10_000,
      });
      const activeRequested = await store.create({
        title: "Active requested later",
        status: "running",
        scheduledAt: 10_000,
        execution: {
          id: "exec-scheduled",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "openai/gpt-5.5",
          startedAt: 0,
          updatedAt: 0,
        },
      });
      const parent = await store.create({ title: "Parent", status: "running" });
      const dependent = await store.create({
        title: "Dependent later",
        status: "scheduled",
        parents: [parent.id],
        scheduledAt: 10_000,
      });

      expect((await store.dispatch(1_000)).promoted).toEqual([]);
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.get(manual.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.get(implicit.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.get(activeRequested.id)).resolves.toMatchObject({ status: "scheduled" });
      expect((await store.get(activeRequested.id))?.execution).toBeUndefined();
      expect((await store.get(activeRequested.id))?.metadata?.attempts).toBeUndefined();
      await expect(store.get(dependent.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.claim(card.id, { ownerId: "main" })).rejects.toThrow(/scheduled/);
      await expect(store.claim(manual.id, { ownerId: "main" })).rejects.toThrow(/scheduled/);
      await expect(store.claim(implicit.id, { ownerId: "main" })).rejects.toThrow(/scheduled/);
      await expect(store.move(manual.id, "running", manual.position)).rejects.toThrow(/scheduled/);

      await store.complete(parent.id, { summary: "Parent done." });
      expect((await store.dispatch(5_000)).promoted).toEqual([]);
      await expect(store.get(dependent.id)).resolves.toMatchObject({ status: "scheduled" });

      expect((await store.dispatch(20_000)).promoted).toEqual([
        expect.objectContaining({ id: card.id, status: "ready" }),
        expect.objectContaining({ id: implicit.id, status: "ready" }),
        expect.objectContaining({ id: activeRequested.id, status: "ready" }),
        expect.objectContaining({ id: dependent.id, status: "ready" }),
      ]);
      await expect(store.get(manual.id)).resolves.toMatchObject({ status: "scheduled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds dependent cards out of runnable statuses until parents finish", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({
      title: "Child",
      status: "running",
      parents: [parent.id],
      execution: {
        id: "exec-held",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 1,
        updatedAt: 1,
      },
    });

    expect(child.status).toBe("todo");
    expect(child.execution).toBeUndefined();
    expect(child.metadata?.attempts).toBeUndefined();
    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(/dependencies/);
    await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(/dependencies/);
    await expect(store.move(child.id, "running", child.position)).rejects.toThrow(/dependencies/);
    await expect(store.move(child.id, "done", child.position)).rejects.toThrow(/dependencies/);
    await expect(store.update(child.id, { status: "ready" })).rejects.toThrow(/dependencies/);
    await expect(store.update(child.id, { status: "done" })).rejects.toThrow(/dependencies/);
    await expect(store.complete(child.id, { summary: "Too early." })).rejects.toThrow(
      /dependencies/,
    );

    const linked = await store.update(child.id, {
      metadata: {
        links: [
          {
            id: "ordinary-link",
            type: "relates_to",
            createdAt: Date.now(),
            url: "https://example.com/work",
          },
        ],
      },
    });
    expect(linked.metadata?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "parent", targetCardId: parent.id }),
        expect.objectContaining({ type: "relates_to", url: "https://example.com/work" }),
      ]),
    );
    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(/dependencies/);

    await store.complete(parent.id, { summary: "Parent done." });
    const dispatch = await store.dispatch();

    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
    const claimed = await store.claim(child.id, { ownerId: "main" });
    expect(claimed.card.status).toBe("running");

    await store.update(parent.id, { status: "running" });
    await store.dispatch();
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: expect.objectContaining({ ownerId: "main" }) },
    });
    await expect(store.releaseClaim(child.id, { ownerId: "main", status: "done" })).rejects.toThrow(
      /dependencies/,
    );
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: expect.objectContaining({ ownerId: "main" }) },
    });

    const lateParent = await store.create({ title: "Late parent" });
    await expect(store.linkCards(lateParent.id, child.id)).rejects.toThrow(/active child/);
  });

  it("resolves parent dependency status with targeted lookups instead of a full-corpus scan", async () => {
    const cardStore = createMemoryStore();
    const entriesSpy = vi.spyOn(cardStore, "entries");
    const store = new WorkboardStore(cardStore);

    const parent = await store.create({ title: "Parent" });
    const children = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.create({ title: `Child ${i}`, status: "todo", parents: [parent.id] }),
      ),
    );

    await store.complete(parent.id, { summary: "Parent done." });
    entriesSpy.mockClear();
    const dispatch = await store.dispatch();

    const idComparator = (left: string, right: string) => left.localeCompare(right);
    expect(dispatch.promoted.map((card) => card.id).toSorted(idComparator)).toEqual(
      children.map((child) => child.id).toSorted(idComparator),
    );
    // Regression guard for the dependencyTargetStatus N+1: before the fix, every
    // parented card being checked in this pass triggered its own additional
    // unscoped list() call (an extra full-corpus scan per child, here 8 of them).
    // Resolving parents via targeted get() calls keeps this flat regardless of
    // how many dependent cards are promoted together.
    expect(entriesSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rejects terminal children with incomplete dependency parents", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const runningParent = await store.create({ title: "Running parent", status: "running" });
    const doneChild = await store.create({ title: "Done child", status: "done" });

    await expect(store.linkCards(runningParent.id, doneChild.id)).rejects.toThrow(/terminal child/);
    await expect(
      store.create({ title: "Already done", status: "done", parents: [runningParent.id] }),
    ).rejects.toThrow(/terminal child/);

    const doneParent = await store.create({ title: "Done parent", status: "done" });
    await expect(store.linkCards(doneParent.id, doneChild.id)).resolves.toMatchObject({
      id: doneChild.id,
      status: "done",
    });
  });

  it("preserves dependency links across link caps and parent deletion", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({ title: "Child", parents: [parent.id] });

    for (let index = 0; index < 60; index += 1) {
      await store.addLink(child.id, {
        type: "relates_to",
        url: `https://example.com/${index}`,
      });
    }

    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(/dependencies/);

    await store.delete(parent.id);
    const claimed = await store.claim(child.id, { ownerId: "main" });

    expect(claimed.card.status).toBe("running");
    expect(claimed.card.metadata?.links?.some((link) => link.targetCardId === parent.id)).toBe(
      false,
    );
  });

  it("rolls back card creation when dependency link capacity rejects the parent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Fanout parent" });
    for (let index = 0; index < 50; index += 1) {
      await store.create({ title: `Child ${index}`, parents: [parent.id] });
    }

    await expect(
      store.create({
        title: "Overflow child",
        parents: [parent.id],
        idempotencyKey: "overflow",
      }),
    ).rejects.toThrow(/link limit/);

    expect((await store.list()).some((card) => card.title === "Overflow child")).toBe(false);
  });

  it("rejects invalid parent creates without persisting partial cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parents: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      parents.push((await store.create({ title: `Parent ${index}` })).id);
    }

    await expect(
      store.create({
        title: "Too many parents",
        parents,
      }),
    ).rejects.toThrow(/parents supports at most 20 entries/);
    await expect(
      store.create({
        title: "Malformed parents",
        parents: [parents[0], 123],
      }),
    ).rejects.toThrow(/parents entries must be strings/);

    await expect(
      store.create({
        title: "Orphan child",
        parents: ["missing-parent"],
        idempotencyKey: "fanout:missing",
      }),
    ).rejects.toThrow(/card not found: missing-parent/);

    expect((await store.list()).some((card) => card.title === "Too many parents")).toBe(false);
    expect((await store.list()).some((card) => card.title === "Malformed parents")).toBe(false);
    expect((await store.list()).some((card) => card.title === "Orphan child")).toBe(false);
  });

  it("rejects dependency cycles", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({ title: "First" });
    const second = await store.create({ title: "Second", parents: [first.id] });

    await expect(store.linkCards(second.id, first.id)).rejects.toThrow(/cycle/);
  });

  it("completes and blocks claimed cards with structured handoff metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ship child",
      status: "running",
      execution: {
        id: "exec-complete",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });
    const child = await store.create({ title: "Follow-up", parents: [card.id] });
    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });

    const completed = await store.complete(claimed.card.id, {
      ownerId: "main",
      token: "token-1",
      summary: "Implemented and verified.",
      proof: { status: "passed", command: "pnpm test extensions/workboard" },
      artifacts: [{ path: "/tmp/log.txt", label: "log" }],
      createdCardIds: [child.id],
    });

    expect(completed).toMatchObject({
      status: "done",
      execution: { status: "done" },
      metadata: {
        attempts: [expect.objectContaining({ status: "succeeded", endedAt: expect.any(Number) })],
        comments: [expect.objectContaining({ body: "Implemented and verified." })],
        proof: [expect.objectContaining({ status: "passed" })],
        artifacts: [expect.objectContaining({ path: "/tmp/log.txt" })],
        automation: { summary: "Implemented and verified.", createdCardIds: [child.id] },
        notifications: [expect.objectContaining({ kind: "completed" })],
      },
    });
    expect(completed.metadata?.claim).toBeUndefined();

    const blockedCard = await store.create({
      title: "Blocked work",
      status: "running",
      execution: {
        id: "exec-block",
        kind: "agent-session",
        engine: "claude",
        mode: "autonomous",
        status: "running",
        model: "anthropic/claude-sonnet-4.6",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });
    await store.claim(blockedCard.id, { ownerId: "main", token: "token-2" });
    const blocked = await store.block(blockedCard.id, {
      ownerId: "main",
      token: "token-2",
      reason: "Needs owner decision.",
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.execution?.status).toBe("blocked");
    expect(blocked.metadata?.attempts).toEqual([
      expect.objectContaining({
        status: "blocked",
        endedAt: expect.any(Number),
        error: "Needs owner decision.",
      }),
    ]);
    expect(blocked.metadata?.failureCount).toBe(1);
    expect(blocked.metadata?.claim).toBeUndefined();
    expect(blocked.metadata?.notifications).toEqual([
      expect.objectContaining({ kind: "failed", message: "Needs owner decision." }),
    ]);

    const recovered = await store.complete(
      (
        await store.create({
          title: "Recovered work",
          status: "running",
          metadata: { failureCount: 2 },
        })
      ).id,
      { summary: "Recovered." },
    );
    expect(recovered.metadata?.failureCount).toBeUndefined();
  });

  it("keeps long lifecycle handoffs in comments while capping notifications", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const completeCard = await store.create({ title: "Long complete" });
    const blockCard = await store.create({ title: "Long block" });
    const longSummary = "x".repeat(1000);
    const longReason = "y".repeat(1000);

    const completed = await store.complete(completeCard.id, { summary: longSummary });
    const blocked = await store.block(blockCard.id, { reason: longReason });

    expect(completed.metadata?.comments?.[0]?.body).toBe(longSummary);
    expect(completed.metadata?.notifications?.[0]?.message.length).toBeLessThanOrEqual(240);
    expect(blocked.metadata?.comments?.[0]?.body).toBe(longReason);
    expect(blocked.metadata?.notifications?.[0]?.message.length).toBeLessThanOrEqual(240);
  });

  it("heals oversized persisted notifications and keeps dispatching sibling cards", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-notification-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    try {
      const store = new WorkboardStore(stores.cards);
      const poisoned = await store.create({ title: "Oversized notification", status: "ready" });
      const sibling = await store.create({ title: "Unaffected sibling", status: "ready" });
      const oversized = `${"x".repeat(238)}🦞${" tail".repeat(60)}`;
      const rawDb = new DatabaseSync(dbPath);
      try {
        rawDb
          .prepare(
            "INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("oversized", poisoned.id, 0, "failed", oversized, Date.now());
      } finally {
        rawDb.close();
      }

      expect((await store.get(poisoned.id))?.metadata?.notifications?.[0]?.message).toBe(oversized);
      await expect(store.dispatch()).resolves.toBeDefined();

      const repaired = await store.get(poisoned.id);
      expect(repaired?.metadata?.notifications?.[0]?.message).toBe(`${"x".repeat(238)}…`);
      expect(repaired?.metadata?.automation?.dispatchCount).toBe(1);
      expect((await store.get(sibling.id))?.metadata?.automation?.dispatchCount).toBe(1);

      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          verifyDb
            .prepare("SELECT message FROM workboard_card_notifications WHERE id = ?")
            .get("oversized"),
        ).toEqual({ message: `${"x".repeat(238)}…` });
      } finally {
        verifyDb.close();
      }
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches ready cards and blocks expired or timed-out work", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const ready = await store.create({ title: "Ready", status: "ready" });
      const readyUpdatedAt = ready.updatedAt;
      const expired = await store.create({ title: "Expired", status: "running" });
      await store.claim(expired.id, { ownerId: "main", token: "token-1", ttlSeconds: 1 });
      const timed = await store.create({
        title: "Timed",
        status: "running",
        maxRuntimeSeconds: 1,
        execution: {
          id: "exec-1",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "openai/gpt-5.5",
          startedAt: 1_000,
          updatedAt: 1_000,
        },
      });
      const claimedTimed = await store.create({
        title: "Claimed timed",
        status: "ready",
        maxRuntimeSeconds: 1,
      });
      await store.claim(claimedTimed.id, { ownerId: "main", token: "token-2", ttlSeconds: 60 });
      const createdRunningTimed = await store.create({
        title: "Created running timed",
        status: "running",
        maxRuntimeSeconds: 1,
      });

      const result = await store.dispatch(10 * 60 * 1000);

      expect(createdRunningTimed.startedAt).toBe(1_000);
      expect(result.count).toBe(4);
      const dispatchedReady = await store.get(ready.id);
      expect(dispatchedReady?.updatedAt).toBeGreaterThan(readyUpdatedAt);
      expect(dispatchedReady).toMatchObject({
        metadata: { automation: { dispatchCount: 1, lastDispatchAt: 600_000 } },
        events: expect.arrayContaining([expect.objectContaining({ kind: "dispatch" })]),
      });
      const blockedExpired = await store.get(expired.id);
      expect(blockedExpired).toMatchObject({ status: "blocked" });
      expect(blockedExpired?.metadata?.claim).toBeUndefined();
      await expect(store.get(timed.id)).resolves.toMatchObject({
        status: "blocked",
        execution: { status: "blocked" },
        metadata: {
          attempts: [expect.objectContaining({ status: "blocked", endedAt: 600_000 })],
        },
      });
      const blockedClaimed = await store.get(claimedTimed.id);
      expect(blockedClaimed).toMatchObject({ status: "blocked" });
      expect(blockedClaimed?.metadata?.claim).toBeUndefined();
      expect(blockedClaimed?.metadata?.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "Run exceeded the card max runtime." }),
        ]),
      );
      await expect(store.get(createdRunningTimed.id)).resolves.toMatchObject({
        status: "blocked",
        metadata: {
          notifications: expect.arrayContaining([
            expect.objectContaining({ message: "Run exceeded the card max runtime." }),
          ]),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized max runtime seconds during dispatch timeout checks", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Bound runtime",
        status: "running",
        maxRuntimeSeconds: Number.MAX_SAFE_INTEGER,
      });
      if (card.startedAt === undefined) {
        throw new Error("expected running card to have startedAt");
      }

      const result = await store.dispatch(card.startedAt + Number.MAX_SAFE_INTEGER + 1);

      expect(result.blocked).toEqual([expect.objectContaining({ id: card.id })]);
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "blocked" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets in-flight retries finish before enforcing the retry budget", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const retrying = await store.create({
      title: "Retrying",
      status: "ready",
      maxRetries: 1,
      metadata: { failureCount: 1 },
    });
    await store.claim(retrying.id, { ownerId: "main", token: "token-1" });

    const retryDispatch = await store.dispatch();

    expect(retryDispatch.blocked).toEqual([]);
    await expect(store.get(retrying.id)).resolves.toMatchObject({ status: "running" });

    const exhausted = await store.create({
      title: "Exhausted",
      status: "ready",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    const exhaustedTodo = await store.create({
      title: "Exhausted todo",
      status: "todo",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    const exhaustedBacklog = await store.create({
      title: "Exhausted backlog",
      status: "backlog",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    await expect(store.claim(exhausted.id, { ownerId: "main" })).rejects.toThrow(/retry budget/);

    const exhaustedDispatch = await store.dispatch();

    expect(exhaustedDispatch.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: exhausted.id, status: "blocked" }),
        expect.objectContaining({ id: exhaustedTodo.id, status: "blocked" }),
        expect.objectContaining({ id: exhaustedBacklog.id, status: "blocked" }),
      ]),
    );
    await expect(store.get(exhausted.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: {
        notifications: [expect.objectContaining({ message: "Card exhausted its retry budget." })],
      },
    });

    const parent = await store.create({ title: "Parent retry gate", status: "running" });
    const dependent = await store.create({
      title: "Dependent exhausted",
      parents: [parent.id],
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    await store.complete(parent.id, { summary: "Parent done." });

    const dependentDispatch = await store.dispatch();

    expect(dependentDispatch.promoted.some((card) => card.id === dependent.id)).toBe(false);
    expect(dependentDispatch.blocked).toEqual([
      expect.objectContaining({ id: dependent.id, status: "blocked" }),
    ]);
  });

  it("extends claim expiry by the original TTL on heartbeat", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Long run" });
      await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

      vi.setSystemTime(31_000);
      const heartbeat = await store.heartbeat(card.id, { ownerId: "main" });

      expect(heartbeat.metadata?.claim).toMatchObject({
        claimedAt: 1_000,
        lastHeartbeatAt: 31_000,
        expiresAt: 91_000,
      });

      vi.setSystemTime(61_000);
      const secondHeartbeat = await store.heartbeat(card.id, { ownerId: "main" });
      expect(secondHeartbeat.metadata?.claim).toMatchObject({
        claimedAt: 1_000,
        lastHeartbeatAt: 61_000,
        expiresAt: 121_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps heartbeat claim renewal to a valid Date timestamp", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MAX_DATE_TIMESTAMP_MS - 30_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Near date limit" });
      await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

      vi.setSystemTime(MAX_DATE_TIMESTAMP_MS - 10_000);
      const heartbeat = await store.heartbeat(card.id, { ownerId: "main" });

      expect(heartbeat.metadata?.claim?.expiresAt).toBe(MAX_DATE_TIMESTAMP_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the claim when release status validation fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Keep claim" });
    await store.claim(card.id, { ownerId: "main", token: "token-1" });

    await expect(
      store.releaseClaim(card.id, { ownerId: "main", token: "token-1", status: "invalid" }),
    ).rejects.toThrow(/status must be one of/);

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { claim: { ownerId: "main", token: "token-1" } },
    });
  });

  it("checks mutation claim scope inside queued card writes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Scoped mutation" });
    await store.claim(card.id, { ownerId: "main", token: "token-1" });

    await expect(
      store.addComment(card.id, { body: "stale write" }, { ownerId: "other" }),
    ).rejects.toThrow(/claimed by main/);
    await expect(store.get(card.id)).resolves.not.toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "stale write" })] },
    });

    await expect(
      store.addComment(card.id, { body: "owner write" }, { ownerId: "main" }),
    ).resolves.toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "owner write" })] },
    });
  });

  it("lets operators override claims while enforcing agent-scoped moves", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Scoped move", status: "todo" });
    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });

    await expect(store.move(card.id, "review", undefined, { ownerId: "agent-b" })).rejects.toThrow(
      "card is claimed by agent-a",
    );
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });

    await expect(store.move(card.id, "review", undefined)).resolves.toMatchObject({
      status: "review",
    });
  });

  it("checks matching claim tokens inside queued card writes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Token-scoped mutation" });
    await store.claim(card.id, { ownerId: "main", token: "test-auth-token" });

    await expect(
      store.addComment(
        card.id,
        { body: "rejected write" },
        { ownerId: "other", token: "test-token-placeholder" },
      ),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      store.addComment(
        card.id,
        { body: "accepted write" },
        { ownerId: "other", token: "test-auth-token" },
      ),
    ).resolves.toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "accepted write" })] },
    });
  });

  it("clears resolved proof diagnostics when adding proof", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Needs proof",
      status: "done",
      metadata: {
        diagnostics: [
          {
            kind: "missing_proof",
            severity: "warning",
            title: "Missing proof",
            detail: "Done card needs proof.",
            actions: [],
            detectedAt: 10,
          },
        ],
      },
    });

    const updated = await store.addProof(card.id, { status: "passed", label: "CI" });

    expect(updated.metadata?.proof).toEqual([expect.objectContaining({ label: "CI" })]);
    expect(updated.metadata?.diagnostics).toBeUndefined();
  });

  it("clears resolved proof diagnostics when adding an artifact", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Needs artifact",
      status: "done",
      metadata: {
        diagnostics: [
          {
            kind: "missing_proof",
            severity: "warning",
            title: "Missing proof",
            detail: "Done card needs proof.",
            actions: [],
            detectedAt: 10,
          },
        ],
      },
    });

    const updated = await store.addArtifact(card.id, { label: "log", path: "/tmp/log.txt" });

    expect(updated.metadata?.artifacts).toEqual([expect.objectContaining({ label: "log" })]);
    expect(updated.metadata?.diagnostics).toBeUndefined();
  });

  it("does not commit proof when proof artifact validation fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Atomic proof" });

    await expect(
      store.addProofWithArtifact(
        card.id,
        { status: "passed", label: "CI" },
        { path: "x".repeat(2001) },
      ),
    ).rejects.toThrow(/artifact path/);

    await expect(store.get(card.id)).resolves.not.toMatchObject({
      metadata: { proof: [expect.objectContaining({ label: "CI" })] },
    });
  });

  it("computes and refreshes card diagnostics", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ready = await store.create({
      title: "Ready too long",
      agentId: "main",
      position: 10,
    });
    const running = await store.create({ title: "Loose run", status: "running", sessionKey: "s1" });
    const failed = await store.create({
      title: "Failed twice",
      status: "blocked",
      metadata: { failureCount: 2 },
    });
    const doneWithAttachment = await store.create({
      title: "Done with attachment",
      status: "done",
      metadata: {
        attachments: [
          {
            id: "attachment-proof",
            cardId: "attachment-card",
            fileName: "result.log",
            byteSize: 1,
            createdAt: 10,
          },
        ],
      },
    });

    const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const diagnostics = await store.refreshDiagnostics(now);

    expect(diagnostics.count).toBeGreaterThanOrEqual(4);
    const diagnosedReady = await store.get(ready.id);
    expect(diagnosedReady?.updatedAt).toBeGreaterThan(ready.updatedAt);
    expect(diagnosedReady).toMatchObject({
      metadata: { diagnostics: [expect.objectContaining({ kind: "stranded_ready" })] },
    });
    await expect(store.get(running.id)).resolves.toMatchObject({
      metadata: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ kind: "running_without_heartbeat" }),
          expect.objectContaining({ kind: "orphaned_session" }),
        ]),
      },
    });
    await expect(store.get(failed.id)).resolves.toMatchObject({
      metadata: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ kind: "blocked_too_long" }),
          expect.objectContaining({ kind: "repeated_failures" }),
        ]),
      },
    });
    await expect(store.get(doneWithAttachment.id)).resolves.not.toMatchObject({
      metadata: {
        diagnostics: expect.arrayContaining([expect.objectContaining({ kind: "missing_proof" })]),
      },
    });
  });

  it("keeps archived cards out of diagnostics without rewriting their history", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Archived completed work", status: "done" });
    const now = Date.now();

    await expect(store.refreshDiagnostics(now)).resolves.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          card: expect.objectContaining({ id: card.id }),
          diagnostics: [expect.objectContaining({ kind: "missing_proof" })],
        }),
      ],
      count: 1,
    });

    const archived = await store.archive(card.id, true);
    const changes = vi.fn();
    const unsubscribe = store.subscribeChanges(changes);

    await expect(store.diagnostics(now + 1)).resolves.toEqual({ diagnostics: [], count: 0 });
    await expect(store.refreshDiagnostics(now + 1)).resolves.toEqual({
      diagnostics: [],
      count: 0,
    });
    await expect(store.get(card.id)).resolves.toEqual(archived);
    await expect(store.list()).resolves.toEqual([archived]);
    expect(changes).not.toHaveBeenCalled();

    unsubscribe();
    const restored = await store.archive(card.id, false);
    await expect(store.diagnostics(now + 2)).resolves.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          card: expect.objectContaining({ id: restored.id }),
          diagnostics: [expect.objectContaining({ kind: "missing_proof" })],
        }),
      ],
      count: 1,
    });
  });

  it.each(WORKBOARD_STATUSES)(
    "reports archived %s cards according to terminal state",
    async (status) => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: `Archived ${status}`, status });

      await store.archive(card.id, true);

      const result = await store.diagnostics(Date.now());
      if (status === "done") {
        expect(result).toEqual({ diagnostics: [], count: 0 });
        return;
      }
      expect(result).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            card: expect.objectContaining({ id: card.id }),
            diagnostics: [
              expect.objectContaining({
                kind: "archived_but_active",
                severity: "warning",
                actions: [],
              }),
            ],
          }),
        ],
        count: 1,
      });
    },
  );

  it("keeps archived-card diagnostics transient across lifecycle changes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Archived but ready", status: "ready" });
    const now = Date.now();

    await store.archive(card.id, true);

    await expect(store.refreshDiagnostics(now)).resolves.toEqual({ diagnostics: [], count: 0 });
    await expect(store.get(card.id)).resolves.not.toHaveProperty("metadata.diagnostics");
    await expect(store.diagnostics(now)).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ card: expect.objectContaining({ id: card.id }) })],
      count: 1,
    });

    await store.archive(card.id, false);
    await expect(store.diagnostics(now + 1)).resolves.toEqual({ diagnostics: [], count: 0 });

    await store.archive(card.id, true);
    await store.move(card.id, "done", undefined);
    await expect(store.diagnostics(now + 2)).resolves.toEqual({ diagnostics: [], count: 0 });
  });

  it("does not drop concurrent updates while refreshing diagnostics", async () => {
    let proofPromise: Promise<unknown> | undefined;
    let triggered = false;
    const keyed = createMemoryStore({
      async beforeRegister(_key, value) {
        if (triggered || !value.card.metadata?.diagnostics?.length) {
          return;
        }
        triggered = true;
        proofPromise = store.addProof(value.card.id, { status: "passed", label: "CI" });
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      },
    });
    const store: WorkboardStore = new WorkboardStore(keyed);
    const card = await store.create({ title: "Ready too long", agentId: "main" });

    await store.refreshDiagnostics(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await proofPromise;

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        diagnostics: [expect.objectContaining({ kind: "stranded_ready" })],
        proof: [expect.objectContaining({ label: "CI" })],
      },
    });
  });

  it("builds bounded worker context from card metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Write docs",
      notes: "Acceptance:\n- mention tools",
      agentId: "main",
      metadata: {
        comments: [{ id: "comment-1", body: "Need proof.", createdAt: 10 }],
        proof: [{ id: "proof-1", status: "passed", command: "pnpm test", createdAt: 12 }],
        artifacts: [
          { id: "artifact-1", label: "Failure screenshot", path: "/tmp/fail.png", createdAt: 13 },
        ],
      },
    });

    await expect(store.buildWorkerContext(card.id)).resolves.toContain("## Recent comments");
    await expect(store.buildWorkerContext(card.id)).resolves.toContain("pnpm test");
    await expect(store.buildWorkerContext(card.id)).resolves.toContain("Failure screenshot");
  });

  it("keeps worker-context text bounds UTF-16 safe", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Bound context",
      metadata: {
        comments: [
          {
            id: "comment-1",
            body: `${"x".repeat(398)}🚀tail`,
            createdAt: 10,
          },
        ],
      },
    });

    await expect(store.buildWorkerContext(card.id)).resolves.toContain(`- ${"x".repeat(398)}…`);
  });

  it("scopes idempotent creates and stats by board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops work",
      boardId: "ops",
      idempotencyKey: "same",
    });
    const product = await store.create({
      title: "Product work",
      boardId: "product",
      idempotencyKey: "same",
    });
    const repeatedOps = await store.create({
      title: "Duplicate ops",
      boardId: "ops",
      idempotencyKey: "same",
    });

    expect(repeatedOps.id).toBe(ops.id);
    expect(product.id).not.toBe(ops.id);
    expect(ops.position).toBe(1000);
    expect(product.position).toBe(1000);
    await expect(store.list({ boardId: "ops" })).resolves.toHaveLength(1);
    await expect(store.listBoards()).resolves.toMatchObject({
      boards: expect.arrayContaining([
        expect.objectContaining({ id: "ops", total: 1 }),
        expect.objectContaining({ id: "product", total: 1 }),
      ]),
    });
    await expect(store.stats({ boardId: "product" })).resolves.toMatchObject({
      id: "product",
      total: 1,
      byStatus: { todo: 1 },
    });
    const prototypeAgentId = ["__", "proto__"].join("");
    const secondProduct = await store.create({
      title: "Prototype safe",
      boardId: "product",
      agentId: prototypeAgentId,
    });
    expect(secondProduct.position).toBe(2000);
    const stats = await store.stats({ boardId: "product" });
    expect(stats.byAgent[prototypeAgentId]).toBe(1);
    const metadataBoardFirst = await store.create({
      title: "Metadata board first",
      metadata: { automation: { boardId: "metadata-board" } },
    });
    const metadataBoardSecond = await store.create({
      title: "Metadata board second",
      metadata: { automation: { boardId: "metadata-board" } },
    });
    expect(metadataBoardFirst.position).toBe(1000);
    expect(metadataBoardSecond.position).toBe(2000);
  });

  it("excludes archived ready cards from active queue-age statistics", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const oldReady = await store.create({
        title: "Archived ready work",
        boardId: "ops",
        status: "ready",
      });
      vi.setSystemTime(2_000);
      await store.archive(oldReady.id, true);

      await expect(store.stats({ boardId: "ops" }, 5_000)).resolves.toMatchObject({
        total: 1,
        active: 0,
        archived: 1,
        byStatus: { ready: 1 },
      });
      await expect(store.stats({ boardId: "ops" }, 5_000)).resolves.not.toHaveProperty(
        "oldestReadyAgeMs",
      );

      vi.setSystemTime(3_000);
      await store.create({
        title: "Active ready work",
        boardId: "ops",
        status: "ready",
      });
      await expect(store.stats({ boardId: "ops" }, 5_000)).resolves.toMatchObject({
        total: 2,
        active: 1,
        archived: 1,
        byStatus: { ready: 2 },
        oldestReadyAgeMs: 2_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects completed manifests for cards not created from the parent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const unrelated = await store.create({ title: "Unrelated" });

    await expect(
      store.complete(parent.id, { createdCardIds: [unrelated.id] }, null),
    ).rejects.toThrow(/not linked/);
    const spoofed = await store.create({
      title: "Spoofed",
      createdByCardId: parent.id,
    });

    await expect(store.complete(parent.id, { createdCardIds: [spoofed.id] }, null)).rejects.toThrow(
      /not linked/,
    );

    const child = await store.create({ title: "Child", parents: [parent.id] });

    await expect(
      store.complete(parent.id, { createdCardIds: [child.id], summary: "done" }, null),
    ).resolves.toMatchObject({
      status: "done",
      metadata: { automation: { createdCardIds: [child.id] } },
    });
  });

  it("promotes, reassigns, and reclaims cards for operator recovery", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Recover me",
      status: "blocked",
      agentId: "old-agent",
      metadata: { failureCount: 2 },
    });
    await store.refreshDiagnostics(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const reassigned = await store.reassign(card.id, {
      agentId: "new-agent",
      status: "todo",
      reason: "route to fresh agent",
    });
    expect(reassigned).toMatchObject({
      agentId: "new-agent",
      status: "todo",
    });
    expect(reassigned.metadata?.failureCount).toBeUndefined();
    expect(reassigned.metadata?.diagnostics?.map((entry) => entry.kind) ?? []).not.toContain(
      "repeated_failures",
    );

    await expect(store.promote(card.id)).resolves.toMatchObject({ status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "new-agent" });

    const reclaimed = await store.reclaim(claimed.card.id, { reason: "stale session" }, null);
    expect(reclaimed).toMatchObject({ status: "ready" });
    expect(reclaimed.metadata?.claim).toBeUndefined();

    const running = await store.create({
      title: "Running recovery",
      status: "running",
      execution: {
        id: "exec-reclaim",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 100,
        updatedAt: 100,
      },
    });
    const stopped = await store.reclaim(running.id, { reason: "replace worker" }, null);
    expect(stopped.execution).toBeUndefined();
    expect(stopped.metadata?.attempts).toEqual([expect.objectContaining({ status: "stopped" })]);
    expect(stopped.metadata?.failureCount).toBeUndefined();
  });

  it("includes parent results and recent assignee work in worker context", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Design",
      status: "running",
      agentId: "agent-a",
    });
    await store.complete(parent.id, { summary: "Use board-scoped queues." }, null);
    await store.create({
      title: "Older task",
      status: "done",
      agentId: "agent-a",
      metadata: { automation: { summary: "Finished related cleanup." } },
    });
    const child = await store.create({
      title: "Implement",
      agentId: "agent-a",
      parents: [parent.id],
    });

    const context = await store.buildWorkerContext(child.id);

    expect(context).toContain("## Parent results");
    expect(context).toContain("Use board-scoped queues.");
    expect(context).toContain("## Recent done work by agent-a");
    expect(context).toContain("Finished related cleanup.");

    const crossBoardChild = await store.create({
      title: "Cross-board child",
      boardId: "product",
      parents: [parent.id],
    });

    await expect(store.buildWorkerContext(crossBoardChild.id)).resolves.toContain(
      "Use board-scoped queues.",
    );
  });

  it("persists board metadata and notification subscriptions in separate stores", async () => {
    const cards = createMemoryStore();
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>();
    const store = new WorkboardStore(cards, { boards, subscriptions });

    const board = await store.upsertBoard({
      id: "ops",
      name: "Ops",
      description: "Operational work",
      defaultWorkspace: { kind: "dir", path: "/tmp/openclaw-ops" },
    });
    const card = await store.create({ title: "Ops card", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed", "failed"],
    });

    await expect(boards.lookup("ops")).resolves.toMatchObject({
      version: 1,
      board: { id: "ops", name: "Ops", description: "Operational work" },
    });
    await expect(subscriptions.lookup(subscription.id)).resolves.toMatchObject({
      version: 1,
      subscription: {
        id: subscription.id,
        boardId: "ops",
        cardId: card.id,
        target: "session:operator",
        eventKinds: ["completed", "failed"],
      },
    });
    await expect(cards.lookup("ops")).resolves.toBeUndefined();
    expect(board.defaultWorkspace).toEqual({ kind: "dir", path: "/tmp/openclaw-ops" });
    expect((await store.listBoards()).boards.find((item) => item.id === "ops")).toMatchObject({
      name: "Ops",
      total: 1,
      active: 1,
      byStatus: { todo: 1 },
    });
    await expect(store.listNotificationSubscriptions({ boardId: "ops" })).resolves.toMatchObject({
      subscriptions: [expect.objectContaining({ id: subscription.id, cardId: card.id })],
    });
  });

  it("excludes archived cards from notification replay without discarding their history", async () => {
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>();
    const store = new WorkboardStore(createMemoryStore(), { subscriptions });
    const historical = await store.create({
      title: "Archived notifications",
      boardId: "ops",
      status: "done",
      metadata: {
        notifications: [
          { id: "archived-completed", kind: "completed", createdAt: 101, message: "Done" },
          { id: "archived-failed", kind: "failed", createdAt: 102, message: "Failed" },
        ],
        stale: { detectedAt: 103, reason: "Previous worker stopped" },
      },
    });
    const archived = await store.archive(historical.id, true);
    const active = await store.create({ title: "Active notifications", boardId: "ops" });
    await store.complete(active.id, { summary: "Still active." });
    const boardSubscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
    });
    const archivedSubscription = await store.subscribeNotifications({
      cardId: archived.id,
      target: "session:operator",
    });

    await expect(
      store.notificationEvents({ subscriptionId: boardSubscription.id }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ kind: "completed", message: "Still active." })],
    });
    await expect(
      store.notificationEvents({ subscriptionId: archivedSubscription.id }),
    ).resolves.toMatchObject({ events: [] });
    await expect(
      store.advanceNotificationEvents({ subscriptionId: archivedSubscription.id }),
    ).resolves.toMatchObject({ events: [] });
    const storedSubscription = await subscriptions.lookup(archivedSubscription.id);
    expect(storedSubscription?.subscription).not.toHaveProperty("lastEventAt");
    expect(storedSubscription?.subscription).not.toHaveProperty("lastEventId");
    expect(storedSubscription?.subscription).not.toHaveProperty("lastEventSequence");
    await expect(store.get(archived.id)).resolves.toEqual(archived);

    await store.archive(archived.id, false);
    const restored = await store.notificationEvents({
      subscriptionId: archivedSubscription.id,
    });
    expect(restored.events).toHaveLength(3);
    expect(restored.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "archived-completed", kind: "completed" }),
        expect.objectContaining({ id: "archived-failed", kind: "failed" }),
        expect.objectContaining({ kind: "stale" }),
      ]),
    );
  });

  it("replays notification events with subscription cursors", async () => {
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>();
    const store = new WorkboardStore(createMemoryStore(), { subscriptions });
    const card = await store.create({ title: "Notify me", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await store.complete(card.id, { summary: "Done." });

    const preview = await store.notificationEvents({ subscriptionId: subscription.id });
    expect(preview.events).toEqual([expect.objectContaining({ kind: "completed" })]);
    const storedPreview = await subscriptions.lookup(subscription.id);
    expect(storedPreview?.subscription).not.toHaveProperty("lastEventAt");
    expect(storedPreview?.subscription).not.toHaveProperty("lastEventId");

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
    });
    expect(first.events).toEqual([expect.objectContaining({ kind: "completed" })]);
    const event = first.events[0];
    if (!event) {
      throw new Error("expected notification event");
    }
    await expect(subscriptions.lookup(subscription.id)).resolves.toMatchObject({
      subscription: {
        lastEventAt: event.createdAt,
        lastEventId: event.id,
      },
    });
    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [],
    });
    await expect(store.notificationEvents({ subscriptionId: "missing" })).rejects.toThrow(
      /subscription not found/,
    );
    await expect(store.advanceNotificationEvents({ boardId: "ops" })).rejects.toThrow(
      /subscriptionId is required/,
    );
  });

  it("does not resurrect a subscription deleted during cursor advancement", async () => {
    let markCursorWriteStarted!: () => void;
    let releaseCursorWrite!: () => void;
    const cursorWriteStarted = new Promise<void>((resolve) => {
      markCursorWriteStarted = resolve;
    });
    const cursorWriteReleased = new Promise<void>((resolve) => {
      releaseCursorWrite = resolve;
    });
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>({
      async beforeRegister(_key, value) {
        if (!value.subscription.lastEventId) {
          return;
        }
        markCursorWriteStarted();
        await cursorWriteReleased;
      },
    });
    const store = new WorkboardStore(createMemoryStore(), { subscriptions });
    const card = await store.create({ title: "Delete in-flight notification", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });
    await store.complete(card.id, { summary: "Done." });

    const advancing = store.advanceNotificationEvents({ subscriptionId: subscription.id });
    await cursorWriteStarted;
    const deleting = store.deleteNotificationSubscription(subscription.id);
    releaseCursorWrite();

    await expect(Promise.all([advancing, deleting])).resolves.toEqual([
      expect.objectContaining({
        events: [expect.objectContaining({ kind: "completed" })],
      }),
      { deleted: true },
    ]);
    await expect(subscriptions.lookup(subscription.id)).resolves.toBeUndefined();
    await expect(store.listNotificationSubscriptions()).resolves.toEqual({ subscriptions: [] });
  });

  it("does not skip same-millisecond notification events after cursor advancement", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.create({
      title: "First same-ms event",
      boardId: "ops",
      metadata: {
        notifications: [
          {
            id: "z-event",
            kind: "completed",
            createdAt: 1234,
            sequence: 1234000,
            message: "First",
          },
        ],
      },
    });
    await store.create({
      title: "Second same-ms event",
      boardId: "ops",
      metadata: {
        notifications: [
          {
            id: "a-event",
            kind: "completed",
            createdAt: 1234,
            sequence: 1234001,
            message: "Second",
          },
        ],
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
      limit: 1,
    });
    expect(first.events).toEqual([expect.objectContaining({ id: "z-event" })]);

    const second = await store.notificationEvents({ subscriptionId: subscription.id });
    expect(second.events).toEqual([expect.objectContaining({ id: "a-event" })]);
  });

  it("does not skip unsequenced notifications after a sequenced same-millisecond event", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.create({
      title: "Sequenced notification",
      boardId: "ops",
      metadata: {
        notifications: [
          {
            id: "z-event",
            kind: "completed",
            createdAt: 1234,
            sequence: 1234000,
            message: "First",
          },
        ],
      },
    });
    await store.create({
      title: "Unsequenced notification",
      boardId: "ops",
      metadata: {
        notifications: [
          {
            id: "a-event",
            kind: "completed",
            createdAt: 1234,
            message: "Second",
          },
        ],
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
      limit: 1,
    });
    expect(first.events).toEqual([expect.objectContaining({ id: "z-event" })]);

    const second = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
      limit: 1,
    });
    expect(second.events).toEqual([expect.objectContaining({ id: "a-event" })]);
    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [],
    });
  });

  it("drains large same-millisecond notification batches without replaying delivered ids", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    for (let index = 0; index < 205; index += 1) {
      await store.create({
        title: `Same-ms event ${index}`,
        boardId: "ops",
        metadata: {
          notifications: [
            {
              id: `event-${index}`,
              kind: "completed",
              createdAt: 1234,
              sequence: 1234000 + index,
              message: `Event ${index}`,
            },
          ],
        },
      });
    }
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
      limit: 200,
    });
    expect(first.events).toHaveLength(200);
    const second = await store.advanceNotificationEvents({ subscriptionId: subscription.id });
    expect(second.events).toHaveLength(5);
    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [],
    });
  });

  it("filters replayed notification events by session and run subscriptions", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    const matching = await store.create({
      title: "Matching session",
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
    });
    const unrelated = await store.create({
      title: "Other session",
      boardId: "ops",
      sessionKey: "session-2",
      runId: "run-2",
    });
    await store.create({
      title: "Card-scoped failed notification",
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      metadata: {
        notifications: [
          {
            id: "card-scoped-failed",
            kind: "failed",
            createdAt: 1234,
            message: "Dispatch failed before stamping event scope.",
          },
        ],
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      target: "session:operator",
    });

    await store.complete(unrelated.id, { summary: "Other done." });
    await store.complete(matching.id, { summary: "Matching done." });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [
        expect.objectContaining({ id: "card-scoped-failed" }),
        expect.objectContaining({ sessionKey: "session-1", runId: "run-1" }),
      ],
    });
  });

  it("replays card-scoped subscriptions without requiring the board id", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    const card = await store.create({ title: "Ops card", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await store.complete(card.id, { summary: "Ops done." });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id, cardId: card.id }),
      events: [expect.objectContaining({ kind: "completed" })],
    });
  });

  it("replays stale metadata as stale notification events", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.create({
      title: "Stale card",
      boardId: "ops",
      metadata: {
        stale: {
          detectedAt: 1234,
          reason: "Session has not reported recent activity.",
        },
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["stale"],
    });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [
        expect.objectContaining({
          id: expect.stringContaining("stale:"),
          kind: "stale",
          createdAt: 1234,
        }),
      ],
    });
  });

  it("marks triage cards as orchestration candidates during dispatch", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore(), { boards });
    await store.upsertBoard({
      id: "planning",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const first = await store.create({
      title: "Break down import flow",
      status: "triage",
      boardId: "planning",
    });
    const archived = await store.create({
      title: "Archived import flow",
      status: "triage",
      boardId: "planning",
    });
    await store.archive(archived.id, true);
    const second = await store.create({
      title: "Break down export flow",
      status: "triage",
      boardId: "planning",
    });

    const dispatch = await store.dispatch(10);

    expect(dispatch.orchestrated).toEqual([
      expect.objectContaining({ id: first.id, status: "triage" }),
    ]);
    expect(dispatch.count).toBe(1);
    await expect(store.get(first.id)).resolves.toMatchObject({
      metadata: {
        workerProtocol: {
          state: "idle",
          detail: "Awaiting workboard_specify or workboard_decompose.",
        },
        workerLogs: [expect.objectContaining({ level: "info" })],
      },
      events: expect.arrayContaining([expect.objectContaining({ kind: "orchestration" })]),
    });
    await expect(store.get(second.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
    await expect(store.get(archived.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
  });

  it("does not mutate archived ready cards during repeated dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Archived ready work",
      status: "ready",
    });
    const archived = await store.archive(card.id, true);
    const changes = vi.fn();
    store.subscribeChanges(changes);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await expect(store.dispatch(10 + attempt)).resolves.toEqual({
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      });
    }

    await expect(store.get(card.id)).resolves.toEqual(archived);
    expect(changes).not.toHaveBeenCalled();
  });

  it("does not promote or claim an archived scheduled card", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Archived scheduled work",
        status: "scheduled",
        scheduledAt: 2_000,
      });
      const archived = await store.archive(card.id, true);
      const changes = vi.fn();
      store.subscribeChanges(changes);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(store.promoteReady(3_000 + attempt)).resolves.toEqual({
          cards: [],
          count: 0,
        });
      }
      await expect(store.claim(card.id, { ownerId: "worker" })).rejects.toThrow(/archived/);
      await expect(store.get(card.id)).resolves.toEqual(archived);
      expect(changes).not.toHaveBeenCalled();

      vi.setSystemTime(3_000);
      await store.archive(card.id, false);
      await expect(store.claim(card.id, { ownerId: "worker" })).resolves.toMatchObject({
        card: { id: card.id, status: "running" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promote, time out, or reclaim archived cards during dispatch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const timedOut = await store.create({
        title: "Archived timed-out work",
        status: "running",
        maxRuntimeSeconds: 1,
      });
      const scheduled = await store.create({
        title: "Archived scheduled work",
        status: "scheduled",
        scheduledAt: 2_000,
      });
      const parent = await store.create({ title: "Dependency parent", status: "running" });
      const dependent = await store.create({
        title: "Archived dependent work",
        parents: [parent.id],
      });
      const archived = await Promise.all([
        store.archive(timedOut.id, true),
        store.archive(scheduled.id, true),
        store.archive(dependent.id, true),
      ]);
      await store.complete(parent.id, { summary: "Dependency finished." });
      const changes = vi.fn();
      store.subscribeChanges(changes);

      await expect(store.dispatch(3_000)).resolves.toEqual({
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      });
      await expect(Promise.all(archived.map((card) => store.get(card.id)))).resolves.toEqual(
        archived,
      );
      expect(changes).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies auto orchestration dispatch caps per board", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore(), { boards });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    await store.upsertBoard({
      id: "product",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const ops = await store.create({ title: "Ops rough", status: "triage", boardId: "ops" });
    const product = await store.create({
      title: "Product rough",
      status: "triage",
      boardId: "product",
    });

    const dispatch = await store.dispatch(10);

    expect(dispatch.orchestrated.map((card) => card.id).toSorted()).toEqual(
      [ops.id, product.id].toSorted(),
    );
  });

  it("scopes dispatch mutations by board", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore(), { boards });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    await store.upsertBoard({
      id: "product",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const ops = await store.create({ title: "Ops rough", status: "triage", boardId: "ops" });
    const product = await store.create({
      title: "Product rough",
      status: "triage",
      boardId: "product",
    });

    const dispatch = await store.dispatch({ now: 10, boardId: "ops" });

    expect(dispatch.orchestrated.map((card) => card.id)).toEqual([ops.id]);
    await expect(store.get(ops.id)).resolves.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
    await expect(store.get(product.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
  });

  it("deletes board notification subscriptions with empty board metadata", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      boards: createMemoryStore<PersistedWorkboardBoard>(),
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.upsertBoard({ id: "ops", name: "Ops" });
    await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await expect(store.deleteBoard("ops")).resolves.toEqual({ deleted: true });
    await expect(store.listNotificationSubscriptions({ boardId: "ops" })).resolves.toEqual({
      subscriptions: [],
    });
  });

  it("deletes card notification subscriptions with the card", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    const card = await store.create({ title: "Notify me" });
    await store.subscribeNotifications({
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await expect(store.delete(card.id)).resolves.toEqual({ deleted: true });
    await expect(store.listNotificationSubscriptions({ cardId: card.id })).resolves.toEqual({
      subscriptions: [],
    });
  });

  it("specifies and decomposes rough cards into linked children", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Rough idea",
      status: "triage",
      boardId: "planning",
      tenant: "qa",
      idempotencyKey: "planning:rough",
    });

    const specified = await store.specify(parent.id, {
      title: "Clarified plan",
      notes: "Acceptance: two concrete follow-up cards.",
      summary: "Clarified the outcome and acceptance criteria.",
      labels: ["planning"],
    });
    expect(specified).toMatchObject({
      title: "Clarified plan",
      status: "todo",
      notes: "Acceptance: two concrete follow-up cards.",
      labels: ["planning"],
      metadata: {
        comments: [
          expect.objectContaining({ body: "Clarified the outcome and acceptance criteria." }),
        ],
      },
    });
    expect(specified.events?.at(-1)).toMatchObject({ kind: "specified" });

    const result = await store.decompose(specified.id, {
      summary: "Split into implementation and review.",
      children: [
        { title: "Implement SQLite persistence", priority: "high" },
        { title: "Review Workboard flows", agentId: "reviewer" },
      ],
    });

    expect(result.parent.status).toBe("done");
    expect(result.parent.events?.at(-1)).toMatchObject({ kind: "decomposed" });
    expect(result.parent.metadata?.automation?.createdCardIds).toEqual(
      result.children.map((child) => child.id),
    );
    expect(result.children).toEqual([
      expect.objectContaining({
        title: "Implement SQLite persistence",
        priority: "high",
        metadata: {
          automation: expect.objectContaining({
            boardId: "planning",
            tenant: "qa",
            createdByCardId: parent.id,
            idempotencyKey: "planning:rough:child:1",
          }),
          links: expect.arrayContaining([
            expect.objectContaining({ type: "parent", targetCardId: parent.id }),
          ]),
        },
      }),
      expect.objectContaining({
        title: "Review Workboard flows",
        agentId: "reviewer",
      }),
    ]);
    await expect(store.runs(parent.id)).resolves.toMatchObject({
      card: { id: parent.id },
      attempts: [],
    });
  });

  it("keeps specify as a todo-only clarification step", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Rough idea", status: "triage" });
    const blocked = await store.create({ title: "Blocked idea", status: "blocked" });

    await expect(store.specify(card.id, { status: "done" })).rejects.toThrow(/must move to todo/);
    await expect(store.specify(card.id, { status: "running" })).rejects.toThrow(
      /must move to todo/,
    );
    await expect(store.specify(blocked.id, { title: "Specified" })).rejects.toThrow(
      /only triage, backlog, or todo/,
    );
    await expect(store.specify(card.id, { title: "Specified" })).resolves.toMatchObject({
      title: "Specified",
      status: "todo",
    });
  });

  it("rolls back newly created children when decomposition fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "todo" });

    await expect(
      store.decompose(parent.id, {
        children: [{ title: "First child" }, { notes: "Missing title" }],
      }),
    ).rejects.toThrow(/title is required/);

    await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: parent.id })]);
    expect((await store.get(parent.id))?.metadata?.links).toBeUndefined();
  });

  it("rolls back links added to reused idempotent children when decomposition fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent" });
    const existingChild = await store.create({
      title: "Existing child",
      status: "ready",
      idempotencyKey: "child-key",
    });
    await store.addLink(existingChild.id, { type: "relates_to", targetCardId: parent.id });

    await expect(
      store.decompose(parent.id, {
        children: [
          { title: "Existing child", idempotencyKey: "child-key" },
          { notes: "Missing title" },
        ],
      }),
    ).rejects.toThrow(/title is required/);

    await expect(store.list()).resolves.toHaveLength(2);
    expect((await store.get(parent.id))?.metadata?.links).toBeUndefined();
    await expect(store.get(existingChild.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        links: [expect.objectContaining({ type: "relates_to", targetCardId: parent.id })],
      },
    });
  });

  it("rolls back every task-owned decomposition write in sqlite when uncontended", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-decompose-control-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    const store = new WorkboardStore(stores.cards);
    try {
      const parent = await store.create({ title: "Parent" });
      const reusedChild = await store.create({
        title: "Existing child",
        idempotencyKey: "child-key",
      });

      await expect(
        store.decompose(parent.id, {
          children: [
            { title: "New child" },
            { title: "Existing child", idempotencyKey: "child-key" },
            { notes: "Missing title" },
          ],
        }),
      ).rejects.toThrow(/title is required/);

      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({ id: parent.id }),
        expect.objectContaining({ id: reusedChild.id }),
      ]);
      expectSameCardState(await store.get(parent.id), parent);
      expectSameCardState(await store.get(reusedChild.id), reusedChild);
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reverts completed parent state while preserving a concurrent parent edit", async () => {
    const harness = createConcurrentSqliteHarness("openclaw-workboard-parent-rollback-");
    const { operation, host, paused } = harness;
    try {
      const createdParent = await operation.create({ title: "Parent", status: "ready" });
      const claimed = await operation.claim(createdParent.id, { ownerId: "worker" });
      const parent = claimed.card;
      const reusedChild = await operation.create({
        title: "Existing child",
        idempotencyKey: "child-key",
      });
      const pause = paused.pauseAfterMatchingWrite(
        (key, value) => key === parent.id && value?.card.status === "done",
      );
      const decomposition = operation.decompose(
        parent.id,
        {
          summary: "Task-owned decomposition",
          children: [{ title: "Existing child", idempotencyKey: "child-key" }],
        },
        { ownerId: "worker", token: claimed.token },
      );

      await pause.reached;
      await host.update(parent.id, { notes: "Concurrent parent edit" });
      pause.resume();

      await expect(decomposition).rejects.toThrow(/changed while you were editing/);
      const rolledBackParent = await host.get(parent.id);
      expect(rolledBackParent?.status).toBe(parent.status);
      expect(rolledBackParent?.notes).toBe("Concurrent parent edit");
      expect(rolledBackParent?.completedAt).toBeUndefined();
      expect(rolledBackParent?.metadata).toEqual(parent.metadata);
      expect(rolledBackParent?.events?.map((event) => event.kind)).toEqual([
        ...(parent.events?.map((event) => event.kind) ?? []),
        "edited",
      ]);
      expectSameCardState(await host.get(reusedChild.id), reusedChild);
    } finally {
      harness.close();
    }
  });

  it.each(["reused child", "new child"] as const)(
    "reverts decomposition-owned links while preserving a concurrent %s edit",
    async (target) => {
      const harness = createConcurrentSqliteHarness("openclaw-workboard-child-rollback-");
      const { operation, host, paused } = harness;
      try {
        const parent = await operation.create({ title: "Parent" });
        const reusedChild =
          target === "reused child"
            ? await operation.create({ title: "Existing child", idempotencyKey: "child-key" })
            : undefined;
        const pause = paused.pauseAfterMatchingWrite((_key, value) => {
          const card = value?.card;
          if (!card || (target === "reused child" && card.id !== reusedChild?.id)) {
            return false;
          }
          if (target === "new child" && card.title !== "New child") {
            return false;
          }
          return Boolean(
            card.metadata?.links?.some(
              (link) => link.type === "parent" && link.targetCardId === parent.id,
            ),
          );
        });
        const decomposition = operation.decompose(parent.id, {
          children: [
            reusedChild
              ? { title: "Existing child", idempotencyKey: "child-key" }
              : { title: "New child" },
            { notes: "Missing title" },
          ],
        });

        await pause.reached;
        const child = reusedChild ?? (await host.list()).find((card) => card.title === "New child");
        expect(child).toBeDefined();
        await host.update(child!.id, { notes: `Concurrent ${target} edit` });
        pause.resume();

        await expect(decomposition).rejects.toThrow(/title is required/);
        expectSameCardState(await host.get(parent.id), parent);
        const rolledBackChild = await host.get(child!.id);
        expect(rolledBackChild?.notes).toBe(`Concurrent ${target} edit`);
        expect(rolledBackChild?.metadata?.links).toBeUndefined();
        expect(rolledBackChild?.metadata?.automation).toMatchObject(
          target === "reused child"
            ? { idempotencyKey: "child-key" }
            : { createdByCardId: parent.id },
        );
        expect(rolledBackChild?.events?.map((event) => event.kind)).toEqual(["created", "edited"]);
      } finally {
        harness.close();
      }
    },
  );

  it("reverts a partial link while preserving a concurrent child edit", async () => {
    const harness = createConcurrentSqliteHarness("openclaw-workboard-link-rollback-");
    const { operation, host, paused } = harness;
    try {
      const parent = await operation.create({ title: "Parent" });
      const child = await operation.create({ title: "Child" });
      const pause = paused.pauseAfterMatchingWrite(
        (key, value) =>
          key === parent.id &&
          Boolean(
            value?.card.metadata?.links?.some(
              (link) => link.type === "child" && link.targetCardId === child.id,
            ),
          ),
      );
      const linking = operation.linkCards(parent.id, child.id);

      await pause.reached;
      await host.update(child.id, { notes: "Concurrent child edit" });
      pause.resume();

      await expect(linking).rejects.toThrow(/changed while you were editing/);
      expectSameCardState(await host.get(parent.id), parent);
      await expect(host.get(child.id)).resolves.toMatchObject({
        notes: "Concurrent child edit",
      });
      expect((await host.get(child.id))?.metadata?.links).toBeUndefined();
      expect((await host.get(child.id))?.events?.map((event) => event.kind)).toEqual([
        ...(child.events?.map((event) => event.kind) ?? []),
        "edited",
      ]);
    } finally {
      harness.close();
    }
  });

  it("reverts task-owned links while preserving a concurrently adopted child", async () => {
    const harness = createConcurrentSqliteHarness("openclaw-workboard-create-rollback-");
    const { operation, host, paused } = harness;
    try {
      const firstParent = await operation.create({ title: "First parent" });
      const secondParent = await operation.create({ title: "Second parent" });
      const pause = paused.pauseAfterMatchingWrite(
        (key, value) =>
          key === secondParent.id &&
          Boolean(
            value?.card.metadata?.links?.some(
              (link) => link.type === "child" && link.targetCardId !== undefined,
            ),
          ),
      );
      const creation = operation.create({
        title: "New child",
        parents: [firstParent.id, secondParent.id],
      });

      await pause.reached;
      const child = (await host.list()).find((card) => card.title === "New child");
      expect(child).toBeDefined();
      await host.update(child!.id, { notes: "Concurrent child edit" });
      pause.resume();

      await expect(creation).rejects.toThrow(/changed while you were editing/);
      await expect(host.get(child!.id)).resolves.toMatchObject({
        notes: "Concurrent child edit",
      });
      expect((await host.get(child!.id))?.metadata?.links).toBeUndefined();
      expect((await host.get(child!.id))?.events?.map((event) => event.kind)).toEqual([
        "created",
        "edited",
      ]);
      expectSameCardState(await host.get(firstParent.id), firstParent);
      expectSameCardState(await host.get(secondParent.id), secondParent);
    } finally {
      harness.close();
    }
  });

  it("preserves a linked-create failure when card compensation also fails", async () => {
    const cards = createMemoryStore();
    const store = new WorkboardStore(cards);
    const parent = await store.create({ title: "Claimed parent", status: "ready" });
    await store.claim(parent.id, { ownerId: "worker" });
    cards.delete = async () => {
      throw new Error("card compensation failed");
    };

    const error = await store
      .create({ title: "New child", parents: [parent.id] }, { ownerId: "other" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/claimed by/),
      cause: expect.objectContaining({ message: expect.stringMatching(/claimed by/) }),
    });
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/claimed by/) }),
      expect.objectContaining({ message: "card compensation failed" }),
    ]);
  });

  it("preserves parent child links when decomposition leaves the parent open", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "triage" });
    await store.addLink(parent.id, { type: "relates_to", url: "https://example.com/context" });

    const result = await store.decompose(parent.id, {
      completeParent: false,
      summary: "Split and keep parent open.",
      children: [{ title: "Child" }],
    });

    expect(result.parent.status).toBe("todo");
    expect(result.parent.metadata?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "relates_to", url: "https://example.com/context" }),
        expect.objectContaining({ type: "child", targetCardId: result.children[0]?.id }),
      ]),
    );
    await expect(
      store.complete(parent.id, {
        createdCardIds: result.children.map((child) => child.id),
        summary: "Children recorded.",
      }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("omits derived child idempotency keys when the parent key is already at the limit", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Parent",
      idempotencyKey: "p".repeat(160),
    });

    const result = await store.decompose(parent.id, {
      children: [{ title: "Child" }],
    });

    expect(result.children[0]?.metadata?.automation?.idempotencyKey).toBeUndefined();
  });

  it("links an idempotent existing child before completing decomposition", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const existingChild = await store.create({
      title: "Existing child",
      idempotencyKey: "child-key",
    });
    const parent = await store.create({ title: "Parent" });

    const result = await store.decompose(parent.id, {
      children: [{ title: "Ignored duplicate", idempotencyKey: "child-key" }],
    });

    expect(result.parent.status).toBe("done");
    expect(result.children).toEqual([expect.objectContaining({ id: existingChild.id })]);
    expect(result.parent.metadata?.automation?.createdCardIds).toEqual([existingChild.id]);
    await expect(store.get(existingChild.id)).resolves.toMatchObject({
      metadata: {
        links: expect.arrayContaining([
          expect.objectContaining({ type: "parent", targetCardId: parent.id }),
        ]),
      },
    });
  });

  it("rejects invalid status values", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await expect(store.create({ title: "Bad card", status: "later" })).rejects.toThrow(
      /status must be one of/,
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
