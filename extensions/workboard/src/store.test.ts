import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import {
  WorkboardStore,
  type PersistedWorkboardAttachment,
  type PersistedWorkboardBoard,
  type PersistedWorkboardCard,
  type PersistedWorkboardNotificationSubscription,
  type WorkboardKeyedStore,
} from "./store.js";

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

describe("WorkboardStore", () => {
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
      const board = await store.upsertBoard({ id: "planning", name: "Planning" });
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
      const attachmentId = attached.metadata?.attachments?.[0]?.id;
      const subscription = await store.subscribeNotifications({
        boardId: board.id,
        target: "agent:main:test",
        eventKinds: ["completed"],
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
        for (const sidecarPath of [`${dbPath}-wal`, `${dbPath}-shm`]) {
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
          expect.objectContaining({ id: board.id, name: "Planning" }),
        ],
      });
      expect(await reopened.get(card.id)).toMatchObject({
        id: card.id,
        labels: ["sqlite", "doctor"],
        metadata: {
          automation: { boardId: "planning" },
          comments: [expect.objectContaining({ body: "round trip" })],
          attachments: expect.arrayContaining([
            expect.objectContaining({ fileName: "proof.txt" }),
            expect.objectContaining({ fileName: "large-proof.bin" }),
          ]),
        },
      });
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
    expect(claimed.card.agentId).toBe("main");
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
      await expect(store.get(ready.id)).resolves.toMatchObject({
        updatedAt: readyUpdatedAt,
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
    await expect(store.get(ready.id)).resolves.toMatchObject({ updatedAt: ready.updatedAt });
    await expect(store.get(ready.id)).resolves.toMatchObject({
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
    await store.create({
      title: "Prototype safe",
      boardId: "product",
      agentId: prototypeAgentId,
    });
    const stats = await store.stats({ boardId: "product" });
    expect(stats.byAgent[prototypeAgentId]).toBe(1);
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
