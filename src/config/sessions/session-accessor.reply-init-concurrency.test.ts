import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
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
});
