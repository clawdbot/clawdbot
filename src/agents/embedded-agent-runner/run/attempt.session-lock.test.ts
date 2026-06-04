import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendSessionTranscriptMessage } from "../../../config/sessions/transcript-append.js";
import {
  runWithOwnedSessionTranscriptWriteLock,
  runWithOwnedSessionTranscriptWritePublication,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "../../session-write-lock-error.js";
import {
  acquireSessionWriteLock,
  resetSessionWriteLockStateForTest,
} from "../../session-write-lock.js";
import {
  acquireEmbeddedAttemptSessionFileOwner,
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
  resetEmbeddedAttemptSessionFileOwnersForTest,
} from "./attempt.session-lock.js";

const lockOptions = {
  sessionFile: "/tmp/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetEmbeddedAttemptSessionFileOwnersForTest();
  resetSessionWriteLockStateForTest();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-lock-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
  return sessionFile;
}

describe("embedded attempt session lock lifecycle", () => {
  it("serializes embedded attempts that share a session file owner", async () => {
    const sessionFile = await createTempSessionFile();
    const firstOwner = await acquireEmbeddedAttemptSessionFileOwner({ sessionFile });

    let secondOwnerAcquired = false;
    const secondOwnerPromise = acquireEmbeddedAttemptSessionFileOwner({ sessionFile }).then(
      (owner) => {
        secondOwnerAcquired = true;
        return owner;
      },
    );

    await Promise.resolve();
    expect(secondOwnerAcquired).toBe(false);

    firstOwner.release();
    const secondOwner = await secondOwnerPromise;
    expect(secondOwnerAcquired).toBe(true);
    secondOwner.release();
  });

  it("uses the same embedded attempt owner for symlinked session file paths", async () => {
    const sessionFile = await createTempSessionFile();
    const symlinkFile = path.join(path.dirname(sessionFile), "session-link.jsonl");
    await fs.symlink(sessionFile, symlinkFile);
    const firstOwner = await acquireEmbeddedAttemptSessionFileOwner({ sessionFile });

    let symlinkOwnerAcquired = false;
    const symlinkOwnerPromise = acquireEmbeddedAttemptSessionFileOwner({
      sessionFile: symlinkFile,
    }).then((owner) => {
      symlinkOwnerAcquired = true;
      return owner;
    });

    await Promise.resolve();
    expect(symlinkOwnerAcquired).toBe(false);

    firstOwner.release();
    const symlinkOwner = await symlinkOwnerPromise;
    expect(symlinkOwnerAcquired).toBe(true);
    symlinkOwner.release();
  });

  it("releases the coarse attempt lock before prompt submission and reacquires for cleanup", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLockLocal28 = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("cleanup")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal28,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLockLocal28).toHaveBeenCalledTimes(2);
    expect(acquireSessionWriteLockLocal28).toHaveBeenNthCalledWith(1, lockOptions);
    expect(acquireSessionWriteLockLocal28).toHaveBeenNthCalledWith(2, lockOptions);
    expect(releases).toEqual(["prep", "cleanup"]);
  });

  it("releases the eagerly-held attempt lock on dispose when cleanup is skipped (#86014)", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLockLocal27 = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("held")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal27,
      lockOptions,
    });

    // An exception on the post-prompt path skips acquireForCleanup; the run's outer finally
    // must still release the eagerly-held lock or it leaks to the live process.
    await controller.dispose();
    await controller.dispose(); // idempotent

    expect(acquireSessionWriteLockLocal27).toHaveBeenCalledTimes(1);
    expect(releases).toEqual(["held"]);
  });

  it("releases the eagerly-held lock when the fence read throws during prompt release", async () => {
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocalFad845 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocalFad845,
      lockOptions,
    });

    // Simulate a transient, non-ENOENT filesystem error (e.g. EIO/EMFILE) while the
    // prompt-release path reads the session-file fence. This fires AFTER the controller
    // has cleared its in-memory `heldLock` reference but BEFORE the underlying file lock
    // is released, which is the window that orphans the lock.
    const statError = Object.assign(new Error("simulated I/O failure"), { code: "EIO" });
    const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(statError);

    try {
      await expect(controller.releaseForPrompt()).rejects.toThrow();

      // The underlying file lock must still be released so later turns do not wait for
      // the full maxHoldMs watchdog before the stale lease is reclaimed.
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("releaseHeldLockForAbort and dispose are idempotent in succession (#86816)", async () => {
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal26 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal26,
      lockOptions,
    });

    await controller.releaseHeldLockForAbort();
    await controller.releaseHeldLockForAbort();
    await controller.dispose();
    await controller.dispose();

    expect(acquireSessionWriteLockLocal26).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("waits for pending timeout abort release before dispose resolves (#86816)", async () => {
    let markHeldReleaseStarted!: () => void;
    const heldReleaseStarted = new Promise<void>((resolve) => {
      markHeldReleaseStarted = resolve;
    });
    let unblockHeldRelease!: () => void;
    const heldReleaseCanFinish = new Promise<void>((resolve) => {
      unblockHeldRelease = resolve;
    });
    const release = vi.fn(async () => {
      markHeldReleaseStarted();
      await heldReleaseCanFinish;
    });
    const acquireSessionWriteLockLocal25 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal25,
      lockOptions,
    });

    const abortRelease = controller.releaseHeldLockForAbort();
    await heldReleaseStarted;
    let disposeSettled = false;
    const dispose = controller.dispose().then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();

    expect(disposeSettled).toBe(false);

    unblockHeldRelease();
    await abortRelease;
    await dispose;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("waits for pending timeout abort release before prompt release resolves (#86816)", async () => {
    let markHeldReleaseStarted!: () => void;
    const heldReleaseStarted = new Promise<void>((resolve) => {
      markHeldReleaseStarted = resolve;
    });
    let unblockHeldRelease!: () => void;
    const heldReleaseCanFinish = new Promise<void>((resolve) => {
      unblockHeldRelease = resolve;
    });
    const release = vi.fn(async () => {
      markHeldReleaseStarted();
      await heldReleaseCanFinish;
    });
    const acquireSessionWriteLockLocal24 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal24,
      lockOptions,
    });

    const abortRelease = controller.releaseHeldLockForAbort();
    await heldReleaseStarted;
    let promptReleaseSettled = false;
    const promptRelease = controller.releaseForPrompt().then(() => {
      promptReleaseSettled = true;
    });
    await Promise.resolve();

    expect(promptReleaseSettled).toBe(false);

    unblockHeldRelease();
    await abortRelease;
    await promptRelease;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("waits for pending timeout abort release before prompt reacquire (#86816)", async () => {
    const events: string[] = [];
    let markHeldReleaseStarted!: () => void;
    const heldReleaseStarted = new Promise<void>((resolve) => {
      markHeldReleaseStarted = resolve;
    });
    let unblockHeldRelease!: () => void;
    const heldReleaseCanFinish = new Promise<void>((resolve) => {
      unblockHeldRelease = resolve;
    });
    const acquireSessionWriteLockLocal23 = vi
      .fn()
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          events.push("held-release-start");
          markHeldReleaseStarted();
          await heldReleaseCanFinish;
          events.push("held-release-end");
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          events.push("reacquired-release");
        }),
      });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal23,
      lockOptions,
    });

    const abortRelease = controller.releaseHeldLockForAbort();
    await heldReleaseStarted;
    const reacquire = controller.reacquireAfterPrompt();
    await Promise.resolve();

    expect(acquireSessionWriteLockLocal23).toHaveBeenCalledTimes(1);

    unblockHeldRelease();
    await abortRelease;
    await reacquire;
    await controller.dispose();

    expect(acquireSessionWriteLockLocal23).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["held-release-start", "held-release-end", "reacquired-release"]);
  });

  it("waits for active retained-lock writes before abort release (#86816)", async () => {
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal22 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal22,
      lockOptions,
    });
    let finishWrite!: () => void;
    const writeCanFinish = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });

    const activeWrite = controller.withSessionWriteLock(async () => {
      markWriteStarted();
      await writeCanFinish;
    });
    await writeStarted;

    let abortReleaseSettled = false;
    const abortRelease = controller.releaseHeldLockForAbort().then(() => {
      abortReleaseSettled = true;
    });
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();
    expect(abortReleaseSettled).toBe(false);

    finishWrite();
    await activeWrite;
    await abortRelease;

    expect(acquireSessionWriteLockLocal22).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("marks retained-lock use before the retained acquisition resolves (#86816)", async () => {
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal21 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal21,
      lockOptions,
    });
    let finishWrite!: () => void;
    const writeCanFinish = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });

    const activeWrite = controller.withSessionWriteLock(async () => {
      await writeCanFinish;
    });
    let abortReleaseSettled = false;
    const abortRelease = controller.releaseHeldLockForAbort().then(() => {
      abortReleaseSettled = true;
    });
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();
    expect(abortReleaseSettled).toBe(false);

    finishWrite();
    await activeWrite;
    await abortRelease;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("waits for active retained-lock writes before cleanup takes the lock (#86816)", async () => {
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal20 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal20,
      lockOptions,
    });
    let finishWrite!: () => void;
    const writeCanFinish = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });

    const activeWrite = controller.withSessionWriteLock(async () => {
      markWriteStarted();
      await writeCanFinish;
    });
    await writeStarted;

    let cleanupAcquired = false;
    const cleanupLockPromise = controller.acquireForCleanup().then((lock) => {
      cleanupAcquired = true;
      return lock;
    });
    await Promise.resolve();

    expect(cleanupAcquired).toBe(false);
    expect(release).not.toHaveBeenCalled();

    finishWrite();
    await activeWrite;
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reacquires cleanup lock when timeout abort already released the held lock (#86816)", async () => {
    const events: string[] = [];
    let markHeldReleaseStarted!: () => void;
    const heldReleaseStarted = new Promise<void>((resolve) => {
      markHeldReleaseStarted = resolve;
    });
    let unblockHeldRelease!: () => void;
    const heldReleaseCanFinish = new Promise<void>((resolve) => {
      unblockHeldRelease = resolve;
    });
    const acquireSessionWriteLockLocal19 = vi
      .fn()
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          events.push("held-release-start");
          markHeldReleaseStarted();
          await heldReleaseCanFinish;
          events.push("held-release-end");
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          events.push("cleanup-release");
        }),
      });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal19,
      lockOptions,
    });

    const abortRelease = controller.releaseHeldLockForAbort();
    await heldReleaseStarted;
    const cleanupLockPromise = controller.acquireForCleanup();
    await Promise.resolve();

    expect(acquireSessionWriteLockLocal19).toHaveBeenCalledTimes(1);

    unblockHeldRelease();
    await abortRelease;
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();

    expect(acquireSessionWriteLockLocal19).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["held-release-start", "held-release-end", "cleanup-release"]);
  });

  it("keeps cleanup waiting while timeout abort owns the held-lock drain (#86816)", async () => {
    const events: string[] = [];
    let finishWrite!: () => void;
    const writeCanFinish = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let markHeldReleaseStarted!: () => void;
    const heldReleaseStarted = new Promise<void>((resolve) => {
      markHeldReleaseStarted = resolve;
    });
    let unblockHeldRelease!: () => void;
    const heldReleaseCanFinish = new Promise<void>((resolve) => {
      unblockHeldRelease = resolve;
    });
    const acquireSessionWriteLockLocal18 = vi
      .fn()
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          events.push("held-release-start");
          markHeldReleaseStarted();
          await heldReleaseCanFinish;
          events.push("held-release-end");
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          events.push("cleanup-release");
        }),
      });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal18,
      lockOptions,
    });

    const activeWrite = controller.withSessionWriteLock(async () => {
      markWriteStarted();
      await writeCanFinish;
    });
    await writeStarted;
    const abortRelease = controller.releaseHeldLockForAbort();
    const cleanupLockPromise = controller.acquireForCleanup();

    finishWrite();
    await activeWrite;
    await heldReleaseStarted;
    await Promise.resolve();

    expect(acquireSessionWriteLockLocal18).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["held-release-start"]);

    unblockHeldRelease();
    await abortRelease;
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();

    expect(acquireSessionWriteLockLocal18).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["held-release-start", "held-release-end", "cleanup-release"]);
  });

  it("dispose does not double-release a lock already handed to cleanup", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLockLocal17 = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("held")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal17,
      lockOptions,
    });

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();
    await controller.dispose();

    expect(acquireSessionWriteLockLocal17).toHaveBeenCalledTimes(1);
    expect(releases).toEqual(["held"]);
  });

  it("defensively releases the coarse attempt lock on sessions_yield abort cleanup", async () => {
    const events: string[] = [];
    const acquireSessionWriteLockLocal16 = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("cleanup-release")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal16,
      lockOptions,
    });

    await controller.releaseHeldLockForAbort();
    await controller.withSessionWriteLock(async () => {
      events.push("yield-cleanup-write");
    });

    expect(acquireSessionWriteLockLocal16).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["prep-release", "yield-cleanup-write", "cleanup-release"]);
  });

  it("keeps the session fence active after releasing for sessions_yield abort cleanup", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal15 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal15,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseHeldLockForAbort();
    await fs.appendFile(sessionFile, '{"type":"message","id":"abort-takeover"}\n', "utf8");

    await expect(controller.withSessionWriteLock(() => "yield-cleanup")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockLocal15).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("runs post-prompt transcript writes under a short reacquired lock", async () => {
    const events: string[] = [];
    const acquireSessionWriteLockLocal14 = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("post-release")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal14,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await controller.withSessionWriteLock(async () => {
      events.push("post-write");
    });

    expect(acquireSessionWriteLockLocal14).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["prep-release", "post-write", "post-release"]);
  });

  it("reuses its active post-prompt lock for nested session writes", async () => {
    const events: string[] = [];
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLockLocal13 = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("post-release")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=789",
          lockPath: `${sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal13,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.withSessionWriteLock(async () => {
      events.push("outer-start");
      await fs.appendFile(sessionFile, '{"type":"message","id":"local"}\n', "utf8");
      await controller.withSessionWriteLock(async () => {
        events.push("inner-write");
      });
      events.push("outer-end");
    });

    expect(acquireSessionWriteLockLocal13).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "prep-release",
      "outer-start",
      "inner-write",
      "outer-end",
      "post-release",
    ]);
  });

  it("rejects post-prompt writes when another owner advances the session file", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal12 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal12,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"takeover"}\n', "utf8");

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(release).toHaveBeenCalledTimes(2);
  });

  it("allows delivery mirror appends while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal11 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal11,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "mirrored media delivery" }],
        provider: "openclaw",
        model: "delivery-mirror",
      },
    });

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("allows delivery mirror appends that migrate legacy linear transcripts", async () => {
    const sessionFile = await createTempSessionFile();
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "legacy-user",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
      "utf8",
    );
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal10 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal10,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "mirrored migrated media delivery" }],
        provider: "openclaw",
        model: "delivery-mirror",
      },
    });

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    await expect(fs.readFile(sessionFile, "utf8")).resolves.toContain('"parentId"');
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("refreshes the prompt fence after an owned write throws", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal9 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal9,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await expect(
      controller.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"owned-before-error"}\n', "utf8");
        throw new Error("downstream event handler failed");
      }),
    ).rejects.toThrow("downstream event handler failed");
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocal9).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a released lock from inherited async context", async () => {
    const sessionFile = await createTempSessionFile();
    let resumeDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      resumeDetached = resolve;
    });
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal8 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal8,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    let detachedWrite!: Promise<void>;
    await controller.withSessionWriteLock(async () => {
      detachedWrite = (async () => {
        await detachedGate;
        await controller.withSessionWriteLock(async () => {
          await fs.appendFile(sessionFile, '{"type":"message","id":"detached-owned"}\n', "utf8");
        });
      })();
    });

    resumeDetached();
    await detachedWrite;
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocal8).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it("keeps post-provider transcript writes owned after prompt stream returns", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal7 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal7,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"provider-error"}\n', "utf8");
    controller.refreshAfterOwnedSessionWrite();

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocal7).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("still rejects external edits before the prompt stream lock is reacquired", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal6 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal6,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockLocal6).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("still rejects external edits after the prompt stream lock is reacquired", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal5 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal5,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"external-after-reacquire"}\n',
      "utf8",
    );

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockLocal5).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("refreshes the prompt fence after an owned transcript mirror append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal4 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal4,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey: "agent:main:discord:channel:123",
        withSessionWriteLock: (operation) => controller.withSessionWriteLock(operation),
      },
      async () =>
        await runWithOwnedSessionTranscriptWriteLock(
          { sessionFile, sessionKey: "agent:main:discord:channel:123" },
          async () => {
            await fs.appendFile(sessionFile, '{"type":"message","id":"delivery-mirror"}\n', "utf8");
          },
        ),
    );
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocal4).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("refreshes the prompt fence after an owned session manager append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal3 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal3,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"owned-session-manager"}\n', "utf8");
    controller.refreshAfterOwnedSessionWrite();

    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("allows post-prompt writes after the prompt context publishes an owned transcript write", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLockLocal2 = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal2,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal2,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const promptActiveSession = async (run: () => Promise<void>): Promise<void> =>
      await withOwnedSessionTranscriptWrites(
        {
          sessionFile,
          sessionKey: "agent:main:slack:channel:456",
          withSessionWriteLock: (operation, options) =>
            secondController.withSessionWriteLock(operation, options),
        },
        run,
      );
    await promptActiveSession(
      async () =>
        await runWithOwnedSessionTranscriptWritePublication(
          { sessionFile, sessionKey: "agent:main:slack:channel:456" },
          async () => {
            await fs.appendFile(sessionFile, '{"type":"message","id":"same-process"}\n', "utf8");
          },
        ),
    );
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"post-prompt"}\n', "utf8");
        return "post-write";
      }),
    ).resolves.toBe("post-write");

    expect(firstController.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocal2).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("allows prompt-stream announcement writes from another controller but still rejects external edits", async () => {
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLockAnnouncement = vi.fn(async () => ({ release: vi.fn() }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockAnnouncement,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const sessionKey = "agent:main:imessage:requester";
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockAnnouncement,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const forwardedOptions: Array<{ publishOwnedWrite?: boolean } | undefined> = [];
    const announceSession = {
      agent: {
        streamFn: vi.fn(async () => {
          await runWithOwnedSessionTranscriptWritePublication(
            { sessionFile, sessionKey },
            async () => {
              await fs.appendFile(
                sessionFile,
                '{"type":"message","id":"announcement-complete"}\n',
                "utf8",
              );
            },
          );
        }),
      },
    };

    installPromptSubmissionLockRelease({
      session: announceSession,
      waitForSessionEvents: (sessionToDrain) =>
        secondController.waitForSessionEvents(sessionToDrain),
      releaseForPrompt: () => secondController.releaseForPrompt(),
      reacquireAfterPrompt: () => secondController.reacquireAfterPrompt(),
      sessionFile,
      sessionKey,
      withSessionWriteLock: (run, options) => {
        forwardedOptions.push(options);
        return secondController.withSessionWriteLock(run, options);
      },
    });

    await announceSession.agent.streamFn();
    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"post-announcement"}\n', "utf8");
        return "post-announcement";
      }),
    ).resolves.toBe("post-announcement");
    expect(firstController.hasSessionTakeover()).toBe(false);

    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"external-after-announcement"}\n',
      "utf8",
    );
    await expect(firstController.withSessionWriteLock(() => "late")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(forwardedOptions).toContainEqual({ publishOwnedWrite: true });
  });

  it("rejects external edits interleaved while another controller holds cleanup lock", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLockInner = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockInner,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockInner,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.releaseForPrompt();
    const cleanupLock = await secondController.acquireForCleanup();

    await fs.appendFile(sessionFile, '{"type":"message","id":"external-cleanup"}\n', "utf8");
    await cleanupLock.release();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockInner).toHaveBeenCalledTimes(4);
    expect(releases).toEqual(["release", "release", "release", "release"]);
  });

  it("rejects external edits interleaved inside a broad owned transcript lock", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLockScoped = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockScoped,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockScoped,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey: "agent:main:slack:channel:789",
        withSessionWriteLock: (operation, options) =>
          secondController.withSessionWriteLock(operation, options),
      },
      async () =>
        await runWithOwnedSessionTranscriptWriteLock(
          { sessionFile, sessionKey: "agent:main:slack:channel:789" },
          async () => {
            await fs.appendFile(
              sessionFile,
              '{"type":"message","id":"external-owned-scope"}\n',
              "utf8",
            );
            await runWithOwnedSessionTranscriptWritePublication(
              { sessionFile, sessionKey: "agent:main:slack:channel:789" },
              async () => {
                await fs.appendFile(
                  sessionFile,
                  '{"type":"message","id":"same-process"}\n',
                  "utf8",
                );
              },
            );
          },
        ),
    );
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockScoped).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external edits interleaved during a broad same-process locked callback", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLockItem = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockItem,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockItem,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.withSessionWriteLock(async () => {
      await fs.appendFile(sessionFile, '{"type":"message","id":"same-process"}\n', "utf8");
      await fs.appendFile(sessionFile, '{"type":"message","id":"external-interleaved"}\n', "utf8");
    });
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockItem).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external session edits even when another controller releases for prompt afterward", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLockCandidate = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockCandidate,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockCandidate,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockCandidate).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external session edits even when another controller appends under lock afterward", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLockEntry = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockEntry,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockEntry,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.withSessionWriteLock(async () => {
      await fs.appendFile(sessionFile, '{"type":"message","id":"same-process"}\n', "utf8");
    });
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLockEntry).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("returns a no-op cleanup lock after prompt lock reacquisition times out", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLockResult = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=123",
          lockPath: `${lockOptions.sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockResult,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLockResult).toHaveBeenCalledTimes(2);
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(releases).toEqual(["prep"]);
  });

  it("skips cleanup lock reacquisition after a post-prompt lock timeout", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLockValue = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=456",
          lockPath: `${lockOptions.sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockValue,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      SessionWriteLockTimeoutError,
    );
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLockValue).toHaveBeenCalledTimes(2);
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(releases).toEqual(["prep"]);
  });

  it("skips cleanup lock reacquisition after a post-prompt stale lock", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockRejectedValueOnce(
        new SessionWriteLockStaleError({
          owner: "pid=789 alive=true ageMs=1800001",
          lockPath: `${lockOptions.sessionFile}.lock`,
          staleReasons: ["too-old"],
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      SessionWriteLockStaleError,
    );
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(releases).toEqual(["prep"]);
  });

  it("wraps provider stream submission with queued transcript drain and lock release", async () => {
    const events: string[] = [];
    const streamFn = vi.fn(async (..._args: unknown[]) => {
      events.push("stream");
    });
    const waitForSessionEvents = vi.fn(async () => {
      events.push("drain");
    });
    const releaseForPrompt = vi.fn(async () => {
      events.push("release");
    });
    const reacquireAfterPrompt = vi.fn(async () => {
      events.push("reacquire");
    });
    const session = { agent: { streamFn } };

    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });

    await session.agent.streamFn("model", "context");

    expect(waitForSessionEvents).toHaveBeenCalledWith(session);
    expect(releaseForPrompt).toHaveBeenCalledTimes(1);
    expect(reacquireAfterPrompt).toHaveBeenCalledTimes(1);
    expect(streamFn).toHaveBeenCalledWith("model", "context");
    expect(events).toEqual(["drain", "release", "stream", "drain", "reacquire"]);
  });

  it("rewraps provider stream submission after the stream function is rebuilt", async () => {
    const events: string[] = [];
    const firstStreamFn = vi.fn(async (..._args: unknown[]) => {
      events.push("first-stream");
    });
    const secondStreamFn = vi.fn(async (..._args: unknown[]) => {
      events.push("second-stream");
    });
    const waitForSessionEvents = vi.fn(async () => {
      events.push("drain");
    });
    const releaseForPrompt = vi.fn(async () => {
      events.push("release");
    });
    const reacquireAfterPrompt = vi.fn(async () => {
      events.push("reacquire");
    });
    const session = { agent: { streamFn: firstStreamFn } };

    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });
    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });
    await session.agent.streamFn("first-model");

    session.agent.streamFn = secondStreamFn;
    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });
    await session.agent.streamFn("second-model");

    expect(firstStreamFn).toHaveBeenCalledTimes(1);
    expect(secondStreamFn).toHaveBeenCalledTimes(1);
    expect(waitForSessionEvents).toHaveBeenCalledTimes(4);
    expect(releaseForPrompt).toHaveBeenCalledTimes(2);
    expect(reacquireAfterPrompt).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "drain",
      "release",
      "first-stream",
      "drain",
      "reacquire",
      "drain",
      "release",
      "second-stream",
      "drain",
      "reacquire",
    ]);
  });

  it("treats transcript appends during prompt streaming as owned session writes", async () => {
    const sessionFile = await createTempSessionFile();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: {
        ...lockOptions,
        sessionFile,
        timeoutMs: 1_000,
      },
    });
    const session = {
      agent: {
        streamFn: vi.fn(async (..._args: unknown[]) => {
          await appendSessionTranscriptMessage({
            transcriptPath: sessionFile,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "mirrored message-tool delivery" }],
            },
          });
        }),
      },
    };

    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents: (sessionToDrain) => controller.waitForSessionEvents(sessionToDrain),
      releaseForPrompt: () => controller.releaseForPrompt(),
      reacquireAfterPrompt: () => controller.reacquireAfterPrompt(),
      sessionFile,
      withSessionWriteLock: (run) => controller.withSessionWriteLock(run),
    });

    await session.agent.streamFn("model", "context");
    const cleanupLock = await controller.acquireForCleanup({ session });
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    await expect(fs.readFile(sessionFile, "utf8")).resolves.toContain(
      "mirrored message-tool delivery",
    );
  });

  it("keeps prompt-stream transcript appends from blocking session-locked hook writes", async () => {
    const sessionFile = await createTempSessionFile();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: {
        ...lockOptions,
        sessionFile,
        timeoutMs: 250,
      },
    });
    await controller.releaseForPrompt();

    let releaseHookAppend!: () => void;
    const hookCanAppend = new Promise<void>((resolve) => {
      releaseHookAppend = resolve;
    });
    let markHookHasLock!: () => void;
    const hookHasLock = new Promise<void>((resolve) => {
      markHookHasLock = resolve;
    });

    const hookAppend = controller.withSessionWriteLock(async () => {
      markHookHasLock();
      await hookCanAppend;
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "session-locked hook write" }],
        },
      });
    });
    await hookHasLock;

    const promptAppend = withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        withSessionWriteLock: (run, options) => controller.withSessionWriteLock(run, options),
      },
      async () =>
        await appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "prompt-stream write" }],
          },
        }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    releaseHookAppend();
    await Promise.all([hookAppend, promptAppend]);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    const transcript = await fs.readFile(sessionFile, "utf8");
    expect(transcript).toContain("session-locked hook write");
    expect(transcript).toContain("prompt-stream write");
    expect(controller.hasSessionTakeover()).toBe(false);
  });
});
