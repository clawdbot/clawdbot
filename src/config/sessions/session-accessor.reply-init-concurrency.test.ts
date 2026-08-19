import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  updateSessionEntry,
  upsertSessionEntryCore,
  withTranscriptWriteLock,
} from "./session-accessor.js";
import {
  AGENT_ID,
  getConcurrencyWorker,
  runConcurrencyScenario,
  SESSION_KEY,
  shutdownConcurrencyWorker,
  waitForChild,
  WORKER_BOOT_TIMEOUT_MS,
} from "./session-accessor.reply-init-concurrency.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session accessor cross-process concurrency", () => {
  beforeAll(async () => {
    await getConcurrencyWorker();
  }, WORKER_BOOT_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    await shutdownConcurrencyWorker();
  });

  it("observes a child that exited before the waiter attached", async () => {
    const child = spawn(process.execPath, ["--eval", ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });

    await waitForChild(child, "already exited");
  });

  it("commits after same-session activity from another process", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-init-"));
    const storePath = path.join(tempDir, "sessions.json");
    try {
      await upsertSessionEntryCore(
        { sessionKey: SESSION_KEY, storePath },
        {
          sessionId: "existing-session",
          updatedAt: Date.now(),
        },
      );
      const initialUpdatedAt = loadSessionEntry({
        readConsistency: "latest",
        sessionKey: SESSION_KEY,
        storePath,
      })?.updatedAt;
      if (typeof initialUpdatedAt !== "number") {
        throw new Error("initial session timestamp was not persisted");
      }
      const activeTurnUpdatedAt = initialUpdatedAt + 20;
      const preparedUpdatedAt = initialUpdatedAt + 30;

      const result = await runConcurrencyScenario(
        {
          kind: "reply-init",
          preparedUpdatedAt,
          storePath,
        },
        async (snapshot) => {
          expect(snapshot.revision).toBe(JSON.stringify({ sessionId: "existing-session" }));
          await updateSessionEntry(
            { sessionKey: SESSION_KEY, storePath },
            () => ({ updatedAt: activeTurnUpdatedAt }),
            { skipMaintenance: true },
          );
        },
      );
      expect(result).toMatchObject({
        ok: true,
        sessionEntry: {
          sessionId: "existing-session",
          updatedAt: preparedUpdatedAt,
        },
      });
      expect(
        loadSessionEntry({ readConsistency: "latest", sessionKey: SESSION_KEY, storePath }),
      ).toMatchObject({
        sessionId: "existing-session",
        updatedAt: preparedUpdatedAt,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a transcript rewrite after another process commits an append", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-rewrite-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "cross-process-transcript";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "original content" },
        },
      ]);

      const result = await runConcurrencyScenario(
        {
          kind: "transcript-rewrite",
          rewriteMode: "read-then-replace",
          sessionId,
          storePath,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "user",
              content: "committed concurrent append",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        name: "SqliteTranscriptMutationConflictError",
        message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "original content" },
        },
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            content: "committed concurrent append",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("preserves locked replaceEvents without a prior readEvents call", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-replace-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "replace-without-read";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    const replacement = [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "replacement",
        parentId: null,
        message: { role: "assistant", content: "replacement content" },
      },
    ];

    try {
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
      await withTranscriptWriteLock(scope, async (transcript) => {
        await transcript.replaceEvents(replacement);
      });

      await expect(loadTranscriptEvents(scope)).resolves.toEqual(replacement);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("guards a second replace after replacing without a prior read", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-double-replace-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "double-replace-without-read";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    const firstReplacement = [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "first-replacement",
        parentId: null,
        message: { role: "assistant", content: "first replacement" },
      },
    ];
    try {
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
      const result = await runConcurrencyScenario(
        {
          kind: "transcript-rewrite",
          rewriteMode: "replace-twice",
          sessionId,
          storePath,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            eventId: "concurrent-append",
            message: { role: "user", content: "concurrent append" },
            parentId: "first-replacement",
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        name: "SqliteTranscriptMutationConflictError",
        message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        ...firstReplacement,
        expect.objectContaining({
          type: "message",
          id: "concurrent-append",
          parentId: "first-replacement",
          message: expect.objectContaining({
            role: "user",
            content: "concurrent append",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("refreshes a read snapshot after an append in the same locked callback", async () => {
    const tempDir = tempDirs.make("openclaw-transcript-self-append-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "rewrite-after-own-append";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };

    try {
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "original content" },
        },
      ]);

      await withTranscriptWriteLock(scope, async (transcript) => {
        await transcript.readEvents();
        await transcript.appendMessage({
          cwd: tempDir,
          eventId: "owned-append",
          message: { role: "user", content: "owned append" },
          parentId: "rewrite-target",
        });
        const currentEvents = await loadTranscriptEvents(scope);
        const rewrittenEvents = currentEvents.map((event) => {
          if (
            typeof event !== "object" ||
            event === null ||
            Array.isArray(event) ||
            (event as { id?: unknown }).id !== "rewrite-target"
          ) {
            return event;
          }
          return Object.assign({}, event, {
            message: { role: "assistant", content: "rewritten content" },
          });
        });
        await transcript.replaceEvents(rewrittenEvents);
      });

      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "rewrite-target",
          parentId: null,
          message: { role: "assistant", content: "rewritten content" },
        },
        expect.objectContaining({
          type: "message",
          id: "owned-append",
          parentId: "rewrite-target",
          message: { role: "user", content: "owned append" },
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a sync transcript rewrite after another process commits an append", async () => {
    const tempDir = tempDirs.make("openclaw-sync-transcript-rewrite-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-cross-process-transcript";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });
      const userMessageId = (
        await appendTranscriptMessage(scope, {
          cwd: tempDir,
          eventId: "user-message",
          message: { role: "user", content: "question" },
        })
      ).messageId;

      const result = await runConcurrencyScenario(
        {
          kind: "sync-transcript-rewrite",
          sessionId,
          storePath,
          targetEntryId: userMessageId,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 1 });
          // Foreign append lands after the worker's SessionManager.open() read
          // but before its synchronous removeTrailingEntries() rewrite -- the
          // exact window a fresh in-function read would already include,
          // silently discarding this row. The worker's caller-tracked snapshot
          // must still catch it.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "committed concurrent reply",
              timestamp: Date.now(),
            },
            parentId: userMessageId,
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        name: "SqliteTranscriptMutationConflictError",
        message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "user-message",
          message: expect.objectContaining({ role: "user", content: "question" }),
        }),
        expect.objectContaining({
          type: "message",
          parentId: "user-message",
          message: expect.objectContaining({
            role: "assistant",
            content: "committed concurrent reply",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("silently drops a foreign append when the rewrite snapshot is a stale post-handshake refresh", async () => {
    const tempDir = tempDirs.make("openclaw-sync-append-race-bug-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-append-race-bug";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });

      const result = await runConcurrencyScenario(
        {
          kind: "sync-append-race",
          sessionId,
          storePath,
          useAtomicSnapshot: false,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          // Foreign append lands after the worker captured its stale nextEntries
          // but before its separate post-handshake refresh -- the exact
          // refreshPersistedRowSnapshot()-style gap ClawSweeper flagged.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toEqual({ ok: true, rewriteRejected: false });
      // Bug reproduced: the stale refresh trivially matches the now-current DB
      // (it already includes the foreign row), so the rewrite proceeds and
      // silently deletes the foreign row since nextEntries never saw it.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "local-append",
          message: expect.objectContaining({ role: "user", content: "local append" }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects the rewrite and preserves a foreign append when the snapshot is captured atomically", async () => {
    const tempDir = tempDirs.make("openclaw-sync-append-race-fix-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-append-race-fix";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });

      const result = await runConcurrencyScenario(
        {
          kind: "sync-append-race",
          sessionId,
          storePath,
          useAtomicSnapshot: true,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          // Same foreign-append timing as the bug case above, but the worker
          // now reuses the snapshot captured inside its own append transaction
          // (before this gap ever ran) instead of re-reading afterward.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toEqual({ ok: true, rewriteRejected: true });
      // Fix verified: the pre-gap snapshot correctly lacks the foreign row, so
      // the rewrite is rejected and the foreign row survives untouched.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "local-append",
          message: expect.objectContaining({ role: "user", content: "local append" }),
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            content: "foreign concurrent reply",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("silently drops a foreign append when a second rewrite's snapshot is a stale post-commit refresh", async () => {
    const tempDir = tempDirs.make("openclaw-sync-rewrite-race-bug-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-rewrite-race-bug";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });

      const result = await runConcurrencyScenario(
        {
          kind: "sync-rewrite-race",
          sessionId,
          storePath,
          useAtomicSnapshot: false,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          // Foreign append lands after the worker's first rewrite committed but
          // before its second rewrite -- the exact refreshPersistedRowSnapshot()
          // gap ClawSweeper flagged at the rewrite call sites in
          // session-manager-core.ts / session-manager-branching.ts.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toEqual({ ok: true, rewriteRejected: false });
      // Bug reproduced: the stale post-commit refresh trivially matches the
      // now-current DB (it already includes the foreign row), so the second
      // rewrite proceeds and silently deletes the foreign row since its
      // in-memory nextEvents never saw it.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "rewrite-a-target",
          message: expect.objectContaining({ role: "assistant", content: "rewrite a" }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a second rewrite and preserves a foreign append when its snapshot is captured atomically", async () => {
    const tempDir = tempDirs.make("openclaw-sync-rewrite-race-fix-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-rewrite-race-fix";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });

      const result = await runConcurrencyScenario(
        {
          kind: "sync-rewrite-race",
          sessionId,
          storePath,
          useAtomicSnapshot: true,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          // Same foreign-append timing as the bug case above, but the worker's
          // second rewrite now reuses the snapshot captured inside the first
          // rewrite's own write transaction (before this gap ever ran)
          // instead of a separate out-of-transaction refresh.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toEqual({ ok: true, rewriteRejected: true });
      // Fix verified: the pre-gap snapshot correctly lacks the foreign row, so
      // the second rewrite is rejected and the foreign row survives untouched.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "rewrite-a-target",
          message: expect.objectContaining({ role: "assistant", content: "rewrite a" }),
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            content: "foreign concurrent reply",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects the first record and preserves a foreign append when the deferred header folds atomically", async () => {
    const tempDir = tempDirs.make("openclaw-sync-initial-header-race-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-initial-header-race";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });

      const result = await runConcurrencyScenario(
        {
          kind: "sync-initial-header-race",
          sessionId,
          storePath,
        },
        async (ready) => {
          // SessionManager.open on an empty transcript defers the header, so it
          // starts with zero entries and its tracked snapshot is empty.
          expect(ready).toEqual({ eventCount: 0 });
          // Foreign row lands in the gap between open() and the manager's first
          // appendMessage; appendTranscriptMessage auto-creates the canonical
          // header for the still-empty transcript. Pre-fix, the manager's first
          // record ran the header append in a separate prior transaction that
          // collided with that foreign-created header and threw an unclean
          // transcript-event-not-appended error. The fold now revalidates the
          // tracked empty snapshot inside the first record's own transaction,
          // sees the foreign row, and rejects closed with the conflict error.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toEqual({ ok: true, appendRejected: true });
      // Fix verified: the manager's deferred header never commits because its
      // first record fails closed atomically instead of racing the header into
      // a separate transaction, so the foreign append's row (and the header it
      // auto-created) survive untouched.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            content: "foreign concurrent reply",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rebases and reloads a manager raw append when a foreign row lands before it", async () => {
    const tempDir = tempDirs.make("openclaw-sync-raw-append-race-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-raw-append-race";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });
      // Populate the transcript so the manager opens with a non-deferred header
      // and a non-empty tracked snapshot -- the raw (non-message) append path,
      // not the header-fold path.
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "seed-message",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ]);

      const result = await runConcurrencyScenario(
        {
          kind: "sync-raw-append-race",
          sessionId,
          storePath,
        },
        async (ready) => {
          // Header filtered out of getEntries(); one seed message remains.
          expect(ready).toEqual({ eventCount: 1 });
          // Foreign row lands after the manager's open() read but before its raw
          // appendModelChange, still declaring "seed-message" as its parent. The
          // append core rebases that stale parentId onto the new tail (the same
          // active-branch rebase message appends already get) instead of folding
          // the foreign row into an unreconciled snapshot, and surfaces the rebase
          // as effectiveParentId so the manager reloads rather than trusting a
          // fileEntries view a later rewrite could otherwise drop the row from.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
            parentId: "seed-message",
          });
        },
      );
      expect(result).toEqual({ ok: true, entryCount: 3 });
      // Fix verified: the raw append rebases onto the foreign row's id (surviving
      // untouched) instead of the stale declared parent, and the manager's reload
      // picks up all three post-rebase entries -- nothing is silently dropped.
      const events = await loadTranscriptEvents(scope);
      expect(events).toHaveLength(4);
      expect(events[0]).toEqual(expect.objectContaining({ type: "session", id: sessionId }));
      expect(events[1]).toEqual(
        expect.objectContaining({
          type: "message",
          id: "seed-message",
          message: expect.objectContaining({ role: "user", content: "seed" }),
        }),
      );
      expect(events[2]).toEqual(
        expect.objectContaining({
          type: "message",
          parentId: "seed-message",
          message: expect.objectContaining({
            role: "assistant",
            content: "foreign concurrent reply",
          }),
        }),
      );
      const foreignMessageId = (events[2] as { id: string }).id;
      expect(events[3]).toEqual(
        expect.objectContaining({
          type: "model_change",
          parentId: foreignMessageId,
          provider: "openclaw",
          modelId: "sonnet-4.6",
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps an id-less foreign row alive after a manager active-branch append races it", async () => {
    const tempDir = tempDirs.make("openclaw-sync-foreign-id-less-race-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-foreign-id-less-race";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });
      // Same starting point as the raw-append-race test above: a non-deferred
      // header and a non-empty tracked snapshot, so the manager's append below
      // takes the active-branch tail-rebase path rather than the header-fold path.
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "seed-message",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ]);

      const result = await runConcurrencyScenario(
        {
          kind: "sync-foreign-id-less-race",
          sessionId,
          storePath,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 1 });
          // An id-less foreign row lands during the handshake gap, matching the
          // real extensions/msteams FeedbackEvent shape exactly: no `id`, no
          // `parentId`, appended via appendTranscriptEvent with no options --
          // the same call recordChannelFeedbackEvent makes. It has no non-blank
          // id, so it never gets a transcript_event_identities row and the
          // tail-rebase parentId check the raw-append-race test above relies on
          // cannot see it -- foreignRowDetected is the only signal available.
          await appendTranscriptEvent(scope, {
            type: "custom",
            event: "feedback",
            ts: Date.now(),
            messageId: "seed-message",
            value: "positive",
            sessionKey: SESSION_KEY,
            agentId: AGENT_ID,
            conversationId: "conv-1",
          });
        },
      );
      // The worker's own model_change append is removed again by its
      // removeTrailingEntries((entry) => entry.type === "model_change") call
      // (see the worker script), which forces the real production rewrite
      // path (replacePersistedTranscript) to run from this manager's
      // in-memory fileEntries/opaqueFileEntries. getEntries() only counts
      // indexed (id-bearing) fileEntries left after that removal -- just
      // seed-message; the id-less feedback row is tracked separately as an
      // opaque entry (see isIndexedSessionEntry) and is not reflected here
      // either way, so entryCount alone cannot distinguish pre-fix from
      // post-fix -- the persisted DB rows asserted below are the real proof.
      expect(result).toEqual({ ok: true, entryCount: 1 });
      // Fix verified: foreignRowDetected forced a reload right after the
      // append, so this manager's opaqueFileEntries picked up the id-less
      // feedback row before the rewrite ran, and the rewrite below preserves
      // it. Pre-fix, the manager never observes the row-count mismatch (no
      // parentId ever moved), so its in-memory opaqueFileEntries never
      // learns about the foreign row, and the rewrite -- built purely from
      // that stale in-memory state -- silently omits it: only 2 rows
      // (header + seed-message) would remain, permanently dropping feedback.
      const events = await loadTranscriptEvents(scope);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(expect.objectContaining({ type: "session", id: sessionId }));
      expect(events[1]).toEqual(
        expect.objectContaining({
          type: "message",
          id: "seed-message",
          message: expect.objectContaining({ role: "user", content: "seed" }),
        }),
      );
      expect(events[2]).toEqual(
        expect.objectContaining({
          type: "custom",
          event: "feedback",
          messageId: "seed-message",
          value: "positive",
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("reloads the manager after a deferred-header conflict so a retry succeeds", async () => {
    const tempDir = tempDirs.make("openclaw-sync-initial-header-retry-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-initial-header-retry";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });

      const result = await runConcurrencyScenario(
        {
          kind: "sync-initial-header-race",
          retryAfterConflict: true,
          sessionId,
          storePath,
        },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 0 });
          // Foreign row lands in the gap between open() and the manager's first
          // appendMessage, so the deferred-header fold fails closed. The manager
          // must reload durable state from that conflict; a retry on the SAME
          // instance then observes the foreign header/row and commits instead of
          // repeating the stale-snapshot conflict forever.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
          });
        },
      );
      expect(result).toEqual({ ok: true, appendRejected: true, retrySucceeded: true });
      // Fix verified: the first record rejected closed and reloaded the manager,
      // so the retry appended a fresh row after the foreign header + reply rather
      // than repeating the conflict.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            content: "foreign concurrent reply",
          }),
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: "manager retry" }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a side-mode append and preserves a foreign append when a foreign row lands before it", async () => {
    const tempDir = tempDirs.make("openclaw-sync-side-mode-append-race-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sync-side-mode-append-race";
    const scope = {
      agentId: AGENT_ID,
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
      });
      // Populate the transcript so the manager opens with a non-deferred header
      // and a non-empty tracked snapshot -- same starting point as the raw-append
      // race above, but this worker then enters side-append mode (a leaf control
      // with appendMode: "side", the same path compaction/custom_message side
      // writes use) before the handshake gap.
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "seed-message",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ]);

      const result = await runConcurrencyScenario(
        {
          kind: "sync-side-mode-append-race",
          sessionId,
          storePath,
          targetEntryId: "seed-message",
        },
        async (ready) => {
          // Header and leaf control filtered out of getEntries(); one seed
          // message remains.
          expect(ready).toEqual({ eventCount: 1 });
          // Foreign row lands after the manager entered side mode but before its
          // side-mode append. A side-mode append declares its exact parentId and
          // never rebases, so it carries no active-branch signal for appendEntry
          // to detect the foreign row through -- the manager's snapshot guard is
          // the only thing that can reject this instead of silently adopting the
          // contaminated snapshot a later rewrite could then validate and delete
          // the foreign row from.
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            message: {
              role: "assistant",
              content: "foreign concurrent reply",
              timestamp: Date.now(),
            },
            parentId: "seed-message",
          });
        },
      );
      expect(result).toEqual({ ok: true, appendRejected: true });
      // Fix verified: the side-mode append is rejected closed instead of
      // silently folding the foreign row into the snapshot it would otherwise
      // adopt, so the foreign row survives untouched and no side note lands.
      // The leaf-control row that entered side mode is itself a legitimate,
      // already-committed append from before the handshake gap.
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "seed-message",
          message: expect.objectContaining({ role: "user", content: "seed" }),
        }),
        expect.objectContaining({ type: "leaf", targetId: "seed-message" }),
        expect.objectContaining({
          type: "message",
          parentId: "seed-message",
          message: expect.objectContaining({
            role: "assistant",
            content: "foreign concurrent reply",
          }),
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
