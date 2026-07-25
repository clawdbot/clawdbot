// Coverage for embedded attempt session-file ownership and write locks.
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolveSessionTranscriptPathInDir } from "../../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { appendSessionTranscriptMessage } from "../../../config/sessions/transcript-append.test-support.js";
import {
  runWithOwnedSessionTranscriptWriteLock,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../../../shared/transcript-only-openclaw-assistant.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "../../session-write-lock-error.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import { resetSessionWriteLockStateForTest } from "../../session-write-lock.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  acquireEmbeddedAttemptSessionFileOwner,
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
} from "./attempt.session-lock.js";
import { resetEmbeddedAttemptSessionFileOwnersForTest } from "./attempt.session-lock.test-support.js";

const lockOptions = {
  sessionFile: "/tmp/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

const tempDirs: string[] = [];
const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  resetEmbeddedAttemptSessionFileOwnersForTest();
  resetSessionWriteLockStateForTest();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile(): Promise<string> {
  // Use a real file so owner normalization can exercise realpath/symlink
  // behavior.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-lock-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
  return sessionFile;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

function cloneBigIntStatWith(
  stat: Awaited<ReturnType<typeof fs.stat>>,
  fields: Partial<Awaited<ReturnType<typeof fs.stat>>>,
): Awaited<ReturnType<typeof fs.stat>> {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, fields) as Awaited<
    ReturnType<typeof fs.stat>
  >;
}

describe("embedded attempt session lock lifecycle", () => {
  it("recognizes an unchanged session file trusted by the previous prompt release", async () => {
    const sessionFile = await createTempSessionFile();
    const options = { ...lockOptions, sessionFile };
    const first = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });

    expect(await first.readTrustedCurrentSessionFileSnapshot()).toBeUndefined();
    await first.releaseForPrompt();
    await first.dispose();

    const second = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });
    expect(await second.readTrustedCurrentSessionFileSnapshot()).toBeDefined();
    await second.dispose();
  });

  it("does not trust a session file changed after the previous prompt release", async () => {
    const sessionFile = await createTempSessionFile();
    const options = { ...lockOptions, sessionFile };
    const first = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });
    await first.releaseForPrompt();
    await first.dispose();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    const second = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });
    expect(await second.readTrustedCurrentSessionFileSnapshot()).toBeUndefined();
    await second.dispose();
  });

  it("publishes a known owned append for the next attempt", async () => {
    const sessionFile = await createTempSessionFile();
    const options = { ...lockOptions, sessionFile };
    const first = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });
    await fs.appendFile(sessionFile, '{"type":"message","id":"owned"}\n', "utf8");
    first.refreshAfterOwnedSessionWrite();
    await first.releaseForPrompt();
    await first.dispose();

    const second = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });
    expect(await second.readTrustedCurrentSessionFileSnapshot()).toBeDefined();
    await second.dispose();
  });

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

  it("clamps oversized session file owner wait timeouts before arming timers", async () => {
    const sessionFile = await createTempSessionFile();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const firstOwner = await acquireEmbeddedAttemptSessionFileOwner({ sessionFile });
    const secondOwnerPromise = acquireEmbeddedAttemptSessionFileOwner({
      sessionFile,
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
    });

    await Promise.resolve();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    firstOwner.release();
    const secondOwner = await secondOwnerPromise;
    secondOwner.release();
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
    // Exceptions after prompt submission can skip cleanup acquisition; dispose
    // still owns the original eager lock.
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
    // A filesystem error can occur after the controller clears its in-memory
    // lock reference; the underlying lease still must be released.
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

  it("allows globally resolved session metadata while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal = vi.fn(async () => ({ release }));
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: "model-snapshot",
          id: "model-snapshot",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: { provider: "openai", modelId: "gpt-5.1" },
        }),
        JSON.stringify({
          type: "label",
          id: "label-change",
          parentId: "model-snapshot",
          timestamp: new Date().toISOString(),
          targetId: "model-change",
          label: "runtime setting",
        }),
        JSON.stringify({
          type: "session_info",
          id: "session-info",
          parentId: "label-change",
          timestamp: new Date().toISOString(),
          name: "session title",
        }),
        JSON.stringify({
          type: "session_info",
          id: "session-info-clear",
          parentId: "session-info",
          timestamp: new Date().toISOString(),
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    expect(controller.hasSessionTakeover()).toBe(false);
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledWith([
      expect.objectContaining({ type: "custom", id: "model-snapshot" }),
      expect.objectContaining({ type: "label", id: "label-change" }),
      expect.objectContaining({ type: "session_info", id: "session-info" }),
      expect.objectContaining({ type: "session_info", id: "session-info-clear" }),
    ]);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();
  });

  it("rejects global metadata when the active session manager cannot resync", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "session_info",
        id: "session-info",
        parentId: null,
        timestamp: new Date().toISOString(),
        name: "session title",
      })}\n`,
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("preserves an unflushed first user turn while merging global metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-first-turn-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "first-turn",
        timestamp: new Date().toISOString(),
        cwd: dir,
      })}\n`,
      "utf8",
    );
    const staleManager = SessionManager.open(sessionFile, dir, dir);
    staleManager.appendMessage({
      role: "user",
      content: "question",
      timestamp: 1,
    });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        staleManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => staleManager.setSessionFile(sessionFile),
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          id: "model-snapshot",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "model-snapshot",
          data: { provider: "openai", modelId: "gpt-5.1" },
        }),
        JSON.stringify({
          type: "session_info",
          id: "session-info",
          parentId: "model-snapshot",
          timestamp: new Date().toISOString(),
          name: "first turn",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await controller.withSessionWriteLock(() => undefined);

    const reopenedBeforeReply = SessionManager.open(sessionFile, dir, dir);
    expect(
      reopenedBeforeReply.buildSessionContext().messages.map((message) => message.role),
    ).toEqual(["user"]);
    expect(reopenedBeforeReply.getSessionName()).toBe("first turn");

    await controller.withSessionWriteLock(() => {
      staleManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "messages",
        provider: "anthropic",
        model: "sonnet-4.6",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
    });

    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(reopened.getSessionName()).toBe("first turn");
    expect(reopened.getEntry("model-snapshot")).toMatchObject({
      type: "custom",
      customType: "model-snapshot",
    });
  });

  it("persists the restored leaf before returning from a prompt-released merge", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-leaf-fence-"));
    tempDirs.push(dir);
    const initialManager = SessionManager.create(dir, dir);
    initialManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const baseAnswerId = initialManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "base answer" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const sessionFile = initialManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected persisted session file");
    }
    const staleManager = SessionManager.open(sessionFile, dir, dir);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        staleManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => staleManager.setSessionFile(sessionFile),
    });
    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "side-delivery",
        parentId: baseAnswerId,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "side delivery" }],
          provider: "openclaw",
          model: "delivery-mirror",
        },
      })}\n`,
      "utf8",
    );

    await controller.withSessionWriteLock(() => undefined);

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            parentId?: string | null;
            targetId?: string | null;
            appendParentId?: string | null;
            appendMode?: string;
          },
      );
    expect(records.at(-1)).toMatchObject({
      type: "leaf",
      parentId: "side-delivery",
      targetId: baseAnswerId,
      appendParentId: "side-delivery",
      appendMode: "side",
    });
    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(reopened.getLeafId()).toBe(baseAnswerId);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("side delivery");
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("publishes the restoring leaf for every active session fence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-shared-leaf-"));
    tempDirs.push(dir);
    const initialManager = SessionManager.create(dir, dir);
    initialManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const baseAnswerId = initialManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "base answer" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const sessionFile = initialManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected persisted session file");
    }
    const firstManager = SessionManager.open(sessionFile, dir, dir);
    const secondManager = SessionManager.open(sessionFile, dir, dir);
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        firstManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => firstManager.setSessionFile(sessionFile),
    });
    await firstController.releaseForPrompt();
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        secondManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => secondManager.setSessionFile(sessionFile),
    });
    await secondController.releaseForPrompt();

    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "shared-side-delivery",
        parentId: baseAnswerId,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "side delivery" }],
          provider: "openclaw",
          model: "delivery-mirror",
        },
      })}\n`,
      "utf8",
    );
    await firstController.withSessionWriteLock(() => undefined);
    const recordsAfterFirstMerge = (await fs.readFile(sessionFile, "utf8")).trim().split("\n");

    await secondController.withSessionWriteLock(() => undefined);

    const recordsAfterSecondMerge = (await fs.readFile(sessionFile, "utf8")).trim().split("\n");
    expect(recordsAfterSecondMerge).toHaveLength(recordsAfterFirstMerge.length);
    expect(JSON.parse(recordsAfterSecondMerge.at(-1) ?? "{}")).toMatchObject({
      type: "leaf",
      targetId: baseAnswerId,
      appendParentId: "shared-side-delivery",
      appendMode: "side",
    });
    expect(firstController.hasSessionTakeover()).toBe(false);
    expect(secondController.hasSessionTakeover()).toBe(false);
    await firstController.dispose();
    await secondController.dispose();
  });

  it("reloads a trusted first-turn rewrite for every active session fence", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-attempt-session-shared-rewrite-"),
    );
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "shared-first-turn",
        timestamp: new Date().toISOString(),
        cwd: dir,
      })}\n`,
      "utf8",
    );
    const firstManager = SessionManager.open(sessionFile, dir, dir);
    const firstUserId = firstManager.appendMessage({
      role: "user",
      content: "first prepared question",
      timestamp: 1,
    });
    const secondManager = SessionManager.open(sessionFile, dir, dir);
    secondManager.appendMessage({
      role: "user",
      content: "stale prepared question",
      timestamp: 1,
    });
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        firstManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => firstManager.setSessionFile(sessionFile),
    });
    await firstController.releaseForPrompt();
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        secondManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => secondManager.setSessionFile(sessionFile),
    });
    await secondController.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "session_info",
        id: "shared-session-info",
        parentId: null,
        timestamp: new Date().toISOString(),
        name: "shared first turn",
      })}\n`,
      "utf8",
    );

    await firstController.withSessionWriteLock(() => undefined);
    await secondController.withSessionWriteLock(() => undefined);

    expect(secondManager.getLeafId()).toBe(firstUserId);
    expect(secondManager.getSessionName()).toBe("shared first turn");
    expect(secondManager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "first prepared question" },
    ]);
    expect(firstController.hasSessionTakeover()).toBe(false);
    expect(secondController.hasSessionTakeover()).toBe(false);
    await firstController.dispose();
    await secondController.dispose();
  });

  it("preserves globally resolved metadata when a stale manager appends the reply branch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-metadata-"));
    tempDirs.push(dir);
    const initialManager = SessionManager.create(dir, dir);
    initialManager.appendMessage({
      role: "user",
      content: "question",
      timestamp: 1,
    });
    const rootId = initialManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const sessionFile = initialManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected persisted session file");
    }
    const staleManager = SessionManager.open(sessionFile, dir, dir);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) =>
        staleManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true }),
      reloadPromptReleasedSessionFile: () => staleManager.setSessionFile(sessionFile),
    });

    await controller.releaseForPrompt();
    const metadataManager = SessionManager.open(sessionFile, dir, dir);
    const customId = metadataManager.appendCustomEntry("model-snapshot", {
      provider: "openai",
      modelId: "gpt-5.1",
    });
    metadataManager.appendLabelChange(rootId, "runtime setting");
    metadataManager.appendSessionInfo("session title");

    await controller.withSessionWriteLock(() => {
      staleManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "messages",
        provider: "anthropic",
        model: "sonnet-4.6",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 3,
      });
    });
    (
      staleManager as unknown as {
        replacePersistedTranscript: () => void;
      }
    ).replacePersistedTranscript();

    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(reopened.getSessionName()).toBe("session title");
    expect(reopened.getLabel(rootId)).toBe("runtime setting");
    expect(reopened.getEntry(customId)).toMatchObject({
      type: "custom",
      customType: "model-snapshot",
    });
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(controller.hasSessionTakeover()).toBe(false);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();
  });

  it.each([
    ["custom without customType", { type: "custom", data: { provider: "openai" } }],
    ["custom with empty customType", { type: "custom", customType: "" }],
    ["label without targetId", { type: "label", label: "runtime setting" }],
    ["label with non-string label", { type: "label", targetId: "model-change", label: 42 }],
    ["session_info with non-string name", { type: "session_info", name: 42 }],
  ])(
    "rejects malformed session control entries while the prompt lock is released: %s",
    async (_, entry) => {
      const sessionFile = await createTempSessionFile();
      const release = vi.fn(async () => {});
      const acquireSessionWriteLockLocal = vi.fn(async () => ({ release }));
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: acquireSessionWriteLockLocal,
        lockOptions: { ...lockOptions, sessionFile },
      });

      await controller.releaseForPrompt();
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          id: "malformed-control-entry",
          parentId: null,
          timestamp: new Date().toISOString(),
          ...entry,
        })}\n`,
        "utf8",
      );

      await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
        EmbeddedAttemptSessionTakeoverError,
      );
      expect(controller.hasSessionTakeover()).toBe(true);

      const cleanupLock = await controller.acquireForCleanup();
      await cleanupLock.release();
    },
  );

  it.each([
    [
      "model_change",
      {
        type: "model_change",
        provider: "openai",
        modelId: "gpt-5.1",
      },
    ],
    [
      "thinking_level_change",
      {
        type: "thinking_level_change",
        thinkingLevel: "high",
      },
    ],
    [
      "message",
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "concurrent user input" }] },
      },
    ],
    [
      "custom_message",
      {
        type: "custom_message",
        customType: "extension-context",
        content: "prompt-affecting extension content",
        display: false,
      },
    ],
    [
      "compaction",
      {
        type: "compaction",
        summary: "Compacted context that would affect the next prompt.",
        firstKeptEntryId: "root",
        tokensBefore: 42,
      },
    ],
    [
      "branch_summary",
      {
        type: "branch_summary",
        fromId: "root",
        summary: "Branch summary that would affect the next prompt.",
      },
    ],
    ["leaf", { type: "leaf", targetId: null }],
  ])(
    "rejects prompt-affecting session entries while the prompt lock is released: %s",
    async (_, entry) => {
      const sessionFile = await createTempSessionFile();
      const release = vi.fn(async () => {});
      const acquireSessionWriteLockLocal = vi.fn(async () => ({ release }));
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: acquireSessionWriteLockLocal,
        lockOptions: { ...lockOptions, sessionFile },
      });

      await controller.releaseForPrompt();
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          id: "prompt-affecting-entry",
          parentId: null,
          timestamp: new Date().toISOString(),
          ...entry,
        })}\n`,
        "utf8",
      );

      await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
        EmbeddedAttemptSessionTakeoverError,
      );
      expect(controller.hasSessionTakeover()).toBe(true);

      const cleanupLock = await controller.acquireForCleanup();
      await cleanupLock.release();
    },
  );

  it("allows delivery mirror appends while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal11 = vi.fn(async () => ({ release }));
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal11,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
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
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ model: "delivery-mirror" }),
      }),
    ]);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("allows delivery mirror side appends with leaf controls while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal = vi.fn(async () => ({ release }));
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });

    await controller.releaseForPrompt();
    const timestamp = "2026-07-04T17:03:02.949Z";
    const firstMirror = {
      type: "message",
      id: "delivery-mirror-1",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "image-1.jpg" }],
        api: "openai-responses",
        provider: "openclaw",
        model: "delivery-mirror",
        stopReason: "stop",
        idempotencyKey: "run-message-tool:message-tool:fingerprint:call-1",
      },
    };
    const leaf = {
      type: "leaf",
      id: "delivery-leaf",
      parentId: firstMirror.id,
      timestamp,
      targetId: "assistant-tool-call",
      appendParentId: firstMirror.id,
      appendMode: "side",
    };
    const sideMirrors = [2, 3, 4].map((index) => ({
      type: "message",
      id: `delivery-mirror-${index}`,
      parentId: index === 2 ? firstMirror.id : `delivery-mirror-${index - 1}`,
      timestamp,
      appendMode: "side",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `image-${index}.jpg` }],
        api: "openai-responses",
        provider: "openclaw",
        model: "delivery-mirror",
        stopReason: "stop",
        idempotencyKey: `run-message-tool:message-tool:fingerprint:call-${index}`,
      },
    }));
    await fs.appendFile(
      sessionFile,
      [firstMirror, leaf, ...sideMirrors].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledWith([
      expect.objectContaining({ type: "message", id: firstMirror.id }),
      expect.objectContaining({
        type: "prompt_released_opaque",
        preserveActiveLeaf: true,
        record: expect.objectContaining({ type: "leaf", id: leaf.id }),
      }),
      ...sideMirrors.map((mirror) => expect.objectContaining({ type: "message", id: mirror.id })),
    ]);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("rejects active leaf controls while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "leaf",
        id: "active-leaf-control",
        parentId: null,
        timestamp: "2026-07-04T17:03:02.949Z",
        targetId: null,
      })}\n`,
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(mergePromptReleasedSessionEntries).not.toHaveBeenCalled();
  });

  it("allows mixed delivery mirror and global metadata appends", async () => {
    const sessionFile = await createTempSessionFile();
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          id: "delivery-mirror",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
          },
        }),
        JSON.stringify({
          type: "label",
          id: "delivery-label",
          parentId: "delivery-mirror",
          timestamp: new Date().toISOString(),
          targetId: "delivery-mirror",
          label: "delivered",
        }),
        JSON.stringify({
          type: "session_info",
          id: "session-info",
          parentId: "delivery-label",
          timestamp: new Date().toISOString(),
          name: "session title",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledWith([
      expect.objectContaining({ type: "message", id: "delivery-mirror" }),
      expect.objectContaining({
        type: "label",
        id: "delivery-label",
        targetId: "delivery-mirror",
      }),
      expect.objectContaining({ type: "session_info", id: "session-info" }),
    ]);
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
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal10,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
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
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "session_info",
        id: "session-info",
        parentId: null,
        timestamp: new Date().toISOString(),
        name: "migrated title",
      })}\n`,
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    await expect(fs.readFile(sessionFile, "utf8")).resolves.toContain('"parentId"');
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ model: "delivery-mirror" }),
      }),
      expect.objectContaining({ type: "session_info", id: "session-info" }),
    ]);
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

  it("allows ctime-only fingerprint drift while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocalCtimeDrift = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocalCtimeDrift,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();

    const stableStat = await fs.stat(sessionFile, { bigint: true });
    const driftedStat = cloneBigIntStatWith(stableStat, {
      ctimeNs: stableStat.ctimeNs + 1_000_000n,
    });
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
      if (target === sessionFile && options?.bigint === true) {
        return driftedStat;
      }
      throw new Error(`unexpected stat call for ${String(target)}`);
    });

    try {
      await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    } finally {
      statSpy.mockRestore();
    }
    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocalCtimeDrift).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("allows a byte-identical in-place rewrite while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, oldTime, oldTime);
    const before = await fs.stat(sessionFile, { bigint: true });
    const originalBytes = await fs.readFile(sessionFile);
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocalIdenticalRewrite = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocalIdenticalRewrite,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.writeFile(sessionFile, originalBytes);
    const after = await fs.stat(sessionFile, { bigint: true });

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(await fs.readFile(sessionFile)).toEqual(originalBytes);
    await expect(controller.reacquireAfterPrompt()).resolves.toBeUndefined();
    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocalIdenticalRewrite).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    await controller.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("rejects a same-size rewrite racing the byte-identical snapshot", async () => {
    const sessionFile = await createTempSessionFile();
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, oldTime, oldTime);
    const before = await fs.stat(sessionFile, { bigint: true });
    const originalBytes = await fs.readFile(sessionFile);
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.writeFile(sessionFile, originalBytes);
    // Force the first rewrite past the fingerprint fast path even on filesystems
    // that coalesce timestamps; the next path stat is snapshot validation.
    const rewrittenTime = new Date("2021-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, rewrittenTime, rewrittenTime);
    const after = await fs.stat(sessionFile, { bigint: true });

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);

    const realStat = fs.stat.bind(fs);
    let armedStatCalls = 0;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
      if (target === sessionFile && options?.bigint === true) {
        armedStatCalls += 1;
        if (armedStatCalls === 2) {
          await fs.writeFile(sessionFile, '{"type":"sessioN"}\n', "utf8");
        }
      }
      return await realStat(target, options);
    });

    try {
      await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
        EmbeddedAttemptSessionTakeoverError,
      );
    } finally {
      statSpy.mockRestore();
    }
    expect(armedStatCalls).toBeGreaterThanOrEqual(2);
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("trusts owned writes after accepting ctime-only fingerprint drift", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocalOwnedAfterDrift = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocalOwnedAfterDrift,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();

    const stableStat = await fs.stat(sessionFile, { bigint: true });
    const driftedStat = cloneBigIntStatWith(stableStat, {
      ctimeNs: stableStat.ctimeNs + 1_000_000n,
    });
    const appendedText = '{"type":"message","id":"owned-after-drift"}\n';
    const changedStat = cloneBigIntStatWith(stableStat, {
      ctimeNs: stableStat.ctimeNs + 2_000_000n,
      mtimeNs: stableStat.mtimeNs + 1_000_000n,
      size: stableStat.size + BigInt(Buffer.byteLength(appendedText)),
    });
    let currentStat = driftedStat;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
      if (target === sessionFile && options?.bigint === true) {
        return currentStat;
      }
      throw new Error(`unexpected stat call for ${String(target)}`);
    });

    try {
      await expect(
        controller.withSessionWriteLock(
          async () => {
            currentStat = changedStat;
            await fs.appendFile(sessionFile, appendedText, "utf8");
          },
          { publishOwnedWrite: true },
        ),
      ).resolves.toBeUndefined();
      await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    } finally {
      statSpy.mockRestore();
    }
    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLockLocalOwnedAfterDrift).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("allows a byte-identical rewrite for digest-backed transcript snapshots", async () => {
    const sessionFile = await createTempSessionFile();
    const originalBytes = Buffer.alloc(8 * 1024 * 1024 + 1, "x");
    await fs.writeFile(sessionFile, originalBytes);
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, oldTime, oldTime);
    const before = await fs.stat(sessionFile, { bigint: true });
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.writeFile(sessionFile, originalBytes);
    const after = await fs.stat(sessionFile, { bigint: true });

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    await expect(controller.reacquireAfterPrompt()).resolves.toBeUndefined();
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("rejects changed bytes for digest-backed transcript snapshots", async () => {
    const sessionFile = await createTempSessionFile();
    const originalBytes = Buffer.alloc(8 * 1024 * 1024 + 1, "x");
    await fs.writeFile(sessionFile, originalBytes);
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    const file = await fs.open(sessionFile, "r+");
    try {
      await file.write(Buffer.from("y"), 0, 1, 0);
    } finally {
      await file.close();
    }

    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects same-inode, same-size transcript rewrites when one byte changes", async () => {
    const sessionFile = await createTempSessionFile();
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, oldTime, oldTime);
    const before = await fs.stat(sessionFile, { bigint: true });
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.writeFile(sessionFile, '{"type":"sessioN"}\n', "utf8");
    const after = await fs.stat(sessionFile, { bigint: true });

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects truncated transcript rewrites", async () => {
    const sessionFile = await createTempSessionFile();
    const before = await fs.stat(sessionFile);
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.truncate(sessionFile, before.size - 1);

    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("fails closed when a metadata-only snapshot is too large to verify", async () => {
    const sessionFile = await createTempSessionFile();
    await fs.truncate(sessionFile, 32 * 1024 * 1024 + 1);
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, oldTime, oldTime);
    const before = await fs.stat(sessionFile, { bigint: true });
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocalOversizeDrift = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocalOversizeDrift,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    const newTime = new Date("2021-01-01T00:00:00.000Z");
    await fs.utimes(sessionFile, newTime, newTime);
    const after = await fs.stat(sessionFile, { bigint: true });

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
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

  it("authorizes entry-cache advancement only under the exact trusted file lock", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    const stat = await fs.stat(sessionFile, { bigint: true });
    const snapshot = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };

    expect(controller.canAdvanceSessionEntryCache(snapshot)).toBe(false);
    await expect(
      controller.withSessionWriteLock(() => {
        expect(controller.canAdvanceSessionEntryCache(snapshot)).toBe(true);
        return "locked";
      }),
    ).resolves.toBe("locked");
    expect(controller.canAdvanceSessionEntryCache(snapshot)).toBe(false);
  });

  it("publishes an exact owned snapshot only while the write lock is active", async () => {
    const sessionFile = await createTempSessionFile();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({
        release: vi.fn(async () => {}),
      })),
      lockOptions: { ...lockOptions, sessionFile },
    });
    const readSnapshot = async () => {
      const stat = await fs.stat(sessionFile, { bigint: true });
      return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
      };
    };
    const initialSnapshot = await readSnapshot();

    expect(controller.publishOwnedSessionFileSnapshot(initialSnapshot)).toBe(false);
    await controller.withSessionWriteLock(async () => {
      expect(controller.publishOwnedSessionFileSnapshot(initialSnapshot)).toBe(true);
      await fs.appendFile(sessionFile, '{"type":"message","id":"owned"}\n', "utf8");
      expect(controller.publishOwnedSessionFileSnapshot(initialSnapshot)).toBe(false);
      expect(controller.publishOwnedSessionFileSnapshot(await readSnapshot())).toBe(true);
    });
    expect(controller.publishOwnedSessionFileSnapshot(await readSnapshot())).toBe(false);
    await controller.dispose();
  });

  it("publishes only an unchanged repair-validated snapshot while retaining the lock", async () => {
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLockLocal = vi.fn(async () => ({
      release: vi.fn(async () => {}),
    }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const stat = await fs.stat(sessionFile, { bigint: true });
    const snapshot = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };

    expect(controller.publishValidatedSessionFileSnapshot(snapshot)).toBe(true);
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");
    expect(controller.publishValidatedSessionFileSnapshot(snapshot)).toBe(false);
    await controller.dispose();
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

  it("refreshes the prompt fence after an owned session manager compaction append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal2 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal2,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile), {
      withCompactionPersistence: (append, validateAppend) =>
        controller.withOwnedSessionFileWrite(append, validateAppend),
    });
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "old question",
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      api: "messages",
      provider: "openclaw",
      model: "session-lock-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    await controller.releaseForPrompt();
    sessionManager.appendCompaction("threshold summary", firstKeptEntryId, 160_001);

    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("persists compaction through the SQLite transcript owner without a JSONL append fence", async () => {
    const dir = autoTempDirs.make("openclaw-attempt-sqlite-compaction-");
    const sessionId = "sqlite-compaction-session";
    const sessionKey = "sqlite-compaction";
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        chatType: "direct",
        spawnedCwd: dir,
        updatedAt: Date.now(),
      },
    );
    const sessionFile = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile));
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "old question",
      timestamp: 1,
    });

    await controller.releaseForPrompt();
    sessionManager.appendCompaction("sqlite summary", firstKeptEntryId, 160_001);

    expect(await loadTranscriptEvents({ sessionId, sessionKey, storePath })).toContainEqual(
      expect.objectContaining({ type: "compaction", summary: "sqlite summary" }),
    );
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("still rejects unowned external compaction appends before the prompt stream lock is reacquired", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal1 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal1,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      JSON.stringify({
        type: "compaction",
        id: "external-compaction",
        parentId: "session",
        timestamp: new Date().toISOString(),
        summary: "external summary",
        firstKeptEntryId: "session",
        tokensBefore: 160_001,
      }) + "\n",
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "finalize")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("still rejects an external edit that happens before an owned session manager compaction append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal0 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal0,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile), {
      withCompactionPersistence: (append, validateAppend) =>
        controller.withOwnedSessionFileWrite(append, validateAppend),
    });
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "old question",
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      api: "messages",
      provider: "openclaw",
      model: "session-lock-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external-edit"}\n', "utf8");
    sessionManager.appendCompaction("threshold summary", firstKeptEntryId, 160_001);

    await expect(controller.withSessionWriteLock(() => "finalize")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("still rejects an external edit interleaved inside an owned session manager compaction append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal30 = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal30,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile), {
      withCompactionPersistence: (append, validateAppend) =>
        controller.withOwnedSessionFileWrite(() => {
          appendFileSync(sessionFile, '{"type":"message","id":"external-edit"}\n', "utf8");
          return append();
        }, validateAppend),
    });
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "old question",
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      api: "messages",
      provider: "openclaw",
      model: "session-lock-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    await controller.releaseForPrompt();
    sessionManager.appendCompaction("threshold summary", firstKeptEntryId, 160_001);

    await expect(controller.withSessionWriteLock(() => "finalize")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("allows owned session manager compaction after a later controller advances the prompt fence", async () => {
    const sessionFile = await createTempSessionFile();
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
      lockOptions: { ...lockOptions, sessionFile },
    });
    await firstController.releaseForPrompt();
    await firstController.dispose();

    const release = vi.fn(async () => {});
    const acquireSessionWriteLockLocal29 = vi.fn(async () => ({ release }));
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal29,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile), {
      withCompactionPersistence: (append, validateAppend) =>
        secondController.withOwnedSessionFileWrite(append, validateAppend),
    });
    const firstKeptEntryId = await secondController.withSessionWriteLock(() => {
      const entryId = sessionManager.appendMessage({
        role: "user",
        content: "new question",
        timestamp: 1,
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "new answer" }],
        api: "messages",
        provider: "openclaw",
        model: "session-lock-test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      return entryId;
    });

    await secondController.releaseForPrompt();
    sessionManager.appendCompaction("threshold summary", firstKeptEntryId, 160_001);

    await expect(secondController.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    expect(secondController.hasSessionTakeover()).toBe(false);
  });

  it("allows owned session manager compaction after another controller publishes an owned write", async () => {
    const sessionFile = await createTempSessionFile();
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
      lockOptions: { ...lockOptions, sessionFile },
    });
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile), {
      withCompactionPersistence: (append, validateAppend) =>
        firstController.withOwnedSessionFileWrite(append, validateAppend),
    });
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "old question",
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      api: "messages",
      provider: "openclaw",
      model: "session-lock-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.releaseForPrompt();
    await secondController.withSessionWriteLock(
      async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"owned-other"}\n', "utf8");
      },
      { publishOwnedWrite: true },
    );
    sessionManager.appendCompaction("threshold summary", firstKeptEntryId, 160_001);

    await expect(firstController.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    expect(firstController.hasSessionTakeover()).toBe(false);
  });

  it("validates first-turn exact assistant appends through the production facade", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-facade-"));
    tempDirs.push(dir);
    const sessionId = "facade-session";
    const sessionKey = "facade";
    const storePath = path.join(dir, "sessions.json");
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, dir);
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
        spawnedCwd: dir,
        updatedAt: Date.now(),
      },
    );
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });
    await controller.releaseForPrompt();

    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey,
        withSessionWriteLock: (operation, options) =>
          controller.withSessionWriteLock(operation, options),
      },
      async () =>
        await appendExactAssistantMessageToSessionTranscript({
          agentId: "main",
          sessionKey,
          storePath,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first-turn delivery" }],
            api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
            provider: "openclaw",
            model: "delivery-mirror",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        }),
    );

    expect(result.ok).toBe(true);
    const events = await loadTranscriptEvents({ sessionId, sessionKey, storePath });
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "first-turn delivery" }],
          role: "assistant",
        }),
      }),
    );
    expect(mergePromptReleasedSessionEntries).not.toHaveBeenCalled();
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("serializes concurrent nested owned transcript publications", async () => {
    const sessionFile = await createTempSessionFile();
    const mergedIds: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) => {
        for (const entry of entries) {
          if (entry.type === "prompt_released_opaque") {
            continue;
          }
          if (mergedIds.includes(entry.id)) {
            throw new Error(`duplicate merged entry ${entry.id}`);
          }
          mergedIds.push(entry.id);
        }
      },
    });
    await controller.releaseForPrompt();

    let releaseFirstWrite!: () => void;
    const firstWriteCanFinish = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const appendOwnedAssistant = async (id: string): Promise<string> => {
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "sonnet-4.6",
          },
        })}\n`,
        "utf8",
      );
      return id;
    };

    await controller.withSessionWriteLock(async () => {
      const firstWrite = controller.withSessionWriteLock(
        async () => {
          markFirstWriteStarted();
          await firstWriteCanFinish;
          return await appendOwnedAssistant("owned-first");
        },
        {
          publishOwnedWrite: true,
          resolvePublishedEntries: (id) => [{ kind: "id", id }],
        },
      );
      await firstWriteStarted;
      const secondWrite = controller.withSessionWriteLock(
        () => appendOwnedAssistant("owned-second"),
        {
          publishOwnedWrite: true,
          resolvePublishedEntries: (id) => [{ kind: "id", id }],
        },
      );
      releaseFirstWrite();
      await Promise.all([firstWrite, secondWrite]);
    });

    expect(mergedIds).toEqual(["owned-first", "owned-second"]);
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("drains unawaited nested publications before publishing the parent fence", async () => {
    const sessionFile = await createTempSessionFile();
    const mergedIds: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) => {
        for (const entry of entries) {
          if (entry.type !== "prompt_released_opaque") {
            mergedIds.push(entry.id);
          }
        }
      },
    });
    await controller.releaseForPrompt();

    let releaseNestedWrite!: () => void;
    const nestedWriteCanFinish = new Promise<void>((resolve) => {
      releaseNestedWrite = resolve;
    });
    let markNestedWriteStarted!: () => void;
    const nestedWriteStarted = new Promise<void>((resolve) => {
      markNestedWriteStarted = resolve;
    });
    let parentSettled = false;
    const parentWrite = controller
      .withSessionWriteLock(
        async () => {
          await fs.appendFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              id: "parent-publication",
              parentId: null,
              timestamp: new Date().toISOString(),
              message: {
                role: "assistant",
                provider: "anthropic",
                model: "sonnet-4.6",
              },
            })}\n`,
            "utf8",
          );
          void controller.withSessionWriteLock(
            async () => {
              markNestedWriteStarted();
              await nestedWriteCanFinish;
              await controller.withSessionWriteLock(
                async () => {
                  await fs.appendFile(
                    sessionFile,
                    `${JSON.stringify({
                      type: "message",
                      id: "unawaited-nested",
                      parentId: null,
                      timestamp: new Date().toISOString(),
                      message: {
                        role: "assistant",
                        provider: "anthropic",
                        model: "sonnet-4.6",
                      },
                    })}\n`,
                    "utf8",
                  );
                  return "unawaited-nested";
                },
                {
                  publishOwnedWrite: true,
                  resolvePublishedEntries: (id) => [{ kind: "id", id }],
                },
              );
            },
            { publishOwnedWrite: true },
          );
          await nestedWriteStarted;
          return "parent-publication";
        },
        {
          publishOwnedWrite: true,
          resolvePublishedEntries: (id) => [{ kind: "id", id }],
        },
      )
      .finally(() => {
        parentSettled = true;
      });

    await nestedWriteStarted;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const settledBeforeNestedWrite = parentSettled;
    releaseNestedWrite();
    await parentWrite;

    expect(settledBeforeNestedWrite).toBe(false);
    expect(mergedIds).toEqual(["parent-publication", "unawaited-nested"]);
    await expect(controller.withSessionWriteLock(() => "next write")).resolves.toBe("next write");
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("drains unawaited publications started from an ordinary lock scope", async () => {
    const sessionFile = await createTempSessionFile();
    const mergedIds: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: (entries) => {
        for (const entry of entries) {
          if (entry.type !== "prompt_released_opaque") {
            mergedIds.push(entry.id);
          }
        }
      },
    });
    await controller.releaseForPrompt();

    let releasePublication!: () => void;
    const publicationCanFinish = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let markPublicationStarted!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      markPublicationStarted = resolve;
    });
    let outerSettled = false;
    const outerWrite = controller
      .withSessionWriteLock(async () => {
        void controller.withSessionWriteLock(
          async () => {
            markPublicationStarted();
            await publicationCanFinish;
            await fs.appendFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                id: "ordinary-scope-publication",
                parentId: null,
                timestamp: new Date().toISOString(),
                message: {
                  role: "assistant",
                  provider: "anthropic",
                  model: "sonnet-4.6",
                },
              })}\n`,
              "utf8",
            );
            return "ordinary-scope-publication";
          },
          {
            publishOwnedWrite: true,
            resolvePublishedEntries: (id) => [{ kind: "id", id }],
          },
        );
        await publicationStarted;
      })
      .finally(() => {
        outerSettled = true;
      });

    await publicationStarted;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const settledBeforePublication = outerSettled;
    releasePublication();
    await outerWrite;

    expect(settledBeforePublication).toBe(false);
    expect(mergedIds).toEqual(["ordinary-scope-publication"]);
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("reacquires the lock for inherited publications that start during fence merge", async () => {
    const sessionFile = await createTempSessionFile();
    const mergedIds: string[] = [];
    let markFirstMergeStarted!: () => void;
    const firstMergeStarted = new Promise<void>((resolve) => {
      markFirstMergeStarted = resolve;
    });
    let releaseFirstMerge!: () => void;
    const firstMergeCanFinish = new Promise<void>((resolve) => {
      releaseFirstMerge = resolve;
    });
    let mergeCount = 0;
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: async (entries) => {
        mergeCount += 1;
        if (mergeCount === 1) {
          markFirstMergeStarted();
          await firstMergeCanFinish;
        }
        for (const entry of entries) {
          if (entry.type !== "prompt_released_opaque") {
            mergedIds.push(entry.id);
          }
        }
      },
    });
    await controller.releaseForPrompt();

    const appendOwnedAssistant = async (id: string): Promise<string> => {
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "sonnet-4.6",
          },
        })}\n`,
        "utf8",
      );
      return id;
    };

    let lateWriteRan = false;
    let lateWrite!: Promise<string>;
    const parentWrite = controller.withSessionWriteLock(
      async () => {
        lateWrite = (async () => {
          await firstMergeStarted;
          return await controller.withSessionWriteLock(
            async () => {
              lateWriteRan = true;
              return await appendOwnedAssistant("late-inherited");
            },
            {
              publishOwnedWrite: true,
              resolvePublishedEntries: (id) => [{ kind: "id", id }],
            },
          );
        })();
        return await appendOwnedAssistant("parent-publication");
      },
      {
        publishOwnedWrite: true,
        resolvePublishedEntries: (id) => [{ kind: "id", id }],
      },
    );

    await firstMergeStarted;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(lateWriteRan).toBe(false);
    releaseFirstMerge();
    await expect(parentWrite).resolves.toBe("parent-publication");
    await expect(lateWrite).resolves.toBe("late-inherited");

    expect(mergedIds).toEqual(["parent-publication", "late-inherited"]);
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
  });

  it("rejects interleaved assistant rows and stops already-queued publications", async () => {
    const sessionFile = await createTempSessionFile();
    const mergePromptReleasedSessionEntries = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });
    await controller.releaseForPrompt();

    let releaseFirstWrite!: () => void;
    const firstWriteCanFinish = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    let secondWriteRan = false;
    const appendAssistant = async (id: string): Promise<string> => {
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "sonnet-4.6",
          },
        })}\n`,
        "utf8",
      );
      return id;
    };

    await expect(
      controller.withSessionWriteLock(async () => {
        const firstWrite = controller.withSessionWriteLock(
          async () => {
            markFirstWriteStarted();
            await firstWriteCanFinish;
            await appendAssistant("interleaved-external");
            return await appendAssistant("owned-entry");
          },
          {
            publishOwnedWrite: true,
            resolvePublishedEntries: (id) => [{ kind: "id", id }],
          },
        );
        await firstWriteStarted;
        const secondWrite = controller.withSessionWriteLock(
          async () => {
            secondWriteRan = true;
            return await appendAssistant("queued-entry");
          },
          {
            publishOwnedWrite: true,
            resolvePublishedEntries: (id) => [{ kind: "id", id }],
          },
        );
        releaseFirstWrite();
        const results = await Promise.allSettled([firstWrite, secondWrite]);
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(secondWriteRan).toBe(false);
    expect(mergePromptReleasedSessionEntries).not.toHaveBeenCalled();
    expect(controller.hasSessionTakeover()).toBe(true);
    await controller.dispose();
  });

  it("preserves an outer failure when a nested publication detects takeover", async () => {
    const sessionFile = await createTempSessionFile();
    const outerFailure = new Error("outer operation failed");
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: vi.fn(),
    });
    await controller.releaseForPrompt();

    await expect(
      controller.withSessionWriteLock(async () => {
        const nestedPublication = controller.withSessionWriteLock(
          async () => {
            await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");
            return "owned";
          },
          {
            publishOwnedWrite: true,
            resolvePublishedEntries: (id) => [{ kind: "id", id }],
          },
        );
        const [nestedResult] = await Promise.allSettled([nestedPublication]);
        expect(nestedResult.status).toBe("rejected");
        throw outerFailure;
      }),
    ).rejects.toBe(outerFailure);
    expect(controller.hasSessionTakeover()).toBe(true);
    await controller.dispose();
  });

  it("deactivates publication contexts inherited by delayed descendants", async () => {
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLockLocal = vi.fn(async () => ({
      release: vi.fn(async () => {}),
    }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries: vi.fn(),
    });
    await controller.releaseForPrompt();

    let releaseDelayedWrite!: () => void;
    const delayedWriteCanStart = new Promise<void>((resolve) => {
      releaseDelayedWrite = resolve;
    });
    let delayedWrite!: Promise<string>;
    await controller.withSessionWriteLock(
      async () => {
        delayedWrite = delayedWriteCanStart.then(() =>
          controller.withSessionWriteLock(() => "delayed-write"),
        );
        await fs.appendFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            id: "publication-entry",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              provider: "anthropic",
              model: "sonnet-4.6",
            },
          })}\n`,
          "utf8",
        );
        return "publication-entry";
      },
      {
        publishOwnedWrite: true,
        resolvePublishedEntries: (id) => [{ kind: "id", id }],
      },
    );

    releaseDelayedWrite();
    await expect(delayedWrite).resolves.toBe("delayed-write");
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(3);
    expect(controller.hasSessionTakeover()).toBe(false);
    await controller.dispose();
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

  it("releases a retained post-prompt lock after takeover so the next inbound can acquire it", async () => {
    const sessionFile = await createTempSessionFile();
    const options = { ...lockOptions, sessionFile, timeoutMs: 250 };
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    await expect(
      controller.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
    expect(controller.hasSessionTakeover()).toBe(true);

    const nextController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: options,
    });
    await nextController.withSessionWriteLock(async () => {
      await fs.appendFile(sessionFile, '{"type":"message","id":"next-inbound"}\n', "utf8");
    });
    await nextController.dispose();
    await controller.dispose();

    const transcript = await fs.readFile(sessionFile, "utf8");
    expect(transcript).toContain('"id":"next-inbound"');
    expect(transcript).not.toContain('"id":"late"');
  });

  it("waits for active retained writers before releasing a takeover lock", async () => {
    const sessionFile = await createTempSessionFile();
    const events: string[] = [];
    let markActiveWriteStarted!: () => void;
    const activeWriteStarted = new Promise<void>((resolve) => {
      markActiveWriteStarted = resolve;
    });
    let releaseActiveWrite!: () => void;
    const activeWriteCanFinish = new Promise<void>((resolve) => {
      releaseActiveWrite = () => {
        events.push("active-finish");
        resolve();
      };
    });
    const releasePrep = vi.fn(async () => events.push("prep-release"));
    const releaseRetained = vi.fn(async () => events.push("retained-release"));
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: releasePrep })
      .mockResolvedValueOnce({ release: releaseRetained });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    const activeWriteResult = Promise.allSettled([
      controller.withSessionWriteLock(async () => {
        events.push("active-start");
        markActiveWriteStarted();
        await activeWriteCanFinish;
      }),
    ]).then(([result]) => result);
    await activeWriteStarted;
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    let takeoverSettled = false;
    const takeoverWriteResult = Promise.allSettled([
      controller.withSessionWriteLock(async () => {
        events.push("late-write");
      }),
    ]).then(([result]) => {
      takeoverSettled = true;
      return result;
    });
    await waitUntil(
      () => controller.hasSessionTakeover(),
      "expected takeover detection while active retained writer was still running",
    );

    expect(takeoverSettled).toBe(false);
    expect(releaseRetained).not.toHaveBeenCalled();

    releaseActiveWrite();
    const [activeResult, takeoverResult] = await Promise.all([
      activeWriteResult,
      takeoverWriteResult,
    ]);
    expect(activeResult.status).toBe("rejected");
    expect(takeoverResult.status).toBe("rejected");
    if (activeResult.status === "rejected") {
      expect(activeResult.reason).toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
    }
    if (takeoverResult.status === "rejected") {
      expect(takeoverResult.reason).toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
    }

    expect(releaseRetained).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["prep-release", "active-start", "active-finish", "retained-release"]);
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
  });

  it("releaseHeldLockWithFence sets deferred flag when bailed out during active scope; re-attempted after scope deactivation (#95915)", async () => {
    const events: string[] = [];
    const releasePrep = vi.fn(async () => events.push("prep-release"));
    const releaseRetained = vi.fn(async () => events.push("retained-release"));
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: releasePrep })
      .mockResolvedValueOnce({ release: releaseRetained });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();

    await controller.withSessionWriteLock(async () => {
      events.push("write-start");
      await controller.releaseHeldLockForAbort();
      events.push("write-end");
    });

    expect(events).toEqual(["prep-release", "write-start", "write-end", "retained-release"]);
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
  });

  it("controls the held lock lifecycle across deferred abort release, reacquisition, and prompt release", async () => {
    const events: string[] = [];
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("init-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("held-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("reacquire-release")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();

    await controller.withSessionWriteLock(async () => {
      events.push("write");
      await controller.releaseHeldLockForAbort();
    });

    expect(events).toEqual(["init-release", "write", "held-release"]);

    await controller.reacquireAfterPrompt();
    await controller.releaseForPrompt();

    expect(events).toEqual(["init-release", "write", "held-release", "reacquire-release"]);
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(3);
  });

  it("releases a prompt reacquire that resolves after controller disposal", async () => {
    const releaseInitial = vi.fn(async () => {});
    const releaseLate = vi.fn(async () => {});
    let resolveReacquiredLock!: (lock: { release(): Promise<void> }) => void;
    const reacquiredLock = new Promise<{ release(): Promise<void> }>((resolve) => {
      resolveReacquiredLock = resolve;
    });
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: releaseInitial })
      .mockImplementationOnce(async () => await reacquiredLock);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const reacquire = controller.reacquireAfterPrompt();
    await waitUntil(
      () => acquireSessionWriteLockLocal.mock.calls.length === 2,
      "expected prompt cleanup to begin reacquiring the session lock",
    );
    await controller.dispose();
    resolveReacquiredLock({ release: releaseLate });
    await reacquire;

    expect(releaseInitial).toHaveBeenCalledTimes(1);
    expect(releaseLate).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight prompt reacquisition before cleanup adopts its lock", async () => {
    const sessionFile = await createTempSessionFile();
    const releaseInitial = vi.fn(async () => {});
    const releaseReacquired = vi.fn(async () => {});
    const releaseUnexpected = vi.fn(async () => {});
    let finishReacquisition!: (lock: { release(): Promise<void> }) => void;
    const reacquisitionCanFinish = new Promise<{ release(): Promise<void> }>((resolve) => {
      finishReacquisition = resolve;
    });
    let markFenceValidationStarted!: () => void;
    const fenceValidationStarted = new Promise<void>((resolve) => {
      markFenceValidationStarted = resolve;
    });
    let finishFenceValidation!: () => void;
    const fenceValidationCanFinish = new Promise<void>((resolve) => {
      finishFenceValidation = resolve;
    });
    const mergePromptReleasedSessionEntries = vi.fn(async () => {
      markFenceValidationStarted();
      await fenceValidationCanFinish;
    });
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: releaseInitial })
      .mockImplementationOnce(async () => await reacquisitionCanFinish)
      .mockResolvedValueOnce({ release: releaseUnexpected });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions: { ...lockOptions, sessionFile },
      mergePromptReleasedSessionEntries,
    });

    await controller.releaseForPrompt();
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "delivery during prompt" }],
        provider: "openclaw",
        model: "delivery-mirror",
      },
    });
    const reacquire = controller.reacquireAfterPrompt();
    await waitUntil(
      () => acquireSessionWriteLockLocal.mock.calls.length === 2,
      "expected prompt reacquisition to start",
    );
    let cleanupSettled = false;
    const cleanupLockPromise = controller.acquireForCleanup().then((lock) => {
      cleanupSettled = true;
      return lock;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(cleanupSettled).toBe(false);
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
    finishReacquisition({ release: releaseReacquired });
    await fenceValidationStarted;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(cleanupSettled).toBe(false);
    expect(releaseReacquired).not.toHaveBeenCalled();
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledTimes(1);

    finishFenceValidation();
    await reacquire;
    const cleanupLock = await cleanupLockPromise;
    expect(releaseReacquired).not.toHaveBeenCalled();
    await cleanupLock.release();

    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
    expect(releaseInitial).toHaveBeenCalledTimes(1);
    expect(releaseReacquired).toHaveBeenCalledTimes(1);
    expect(releaseUnexpected).not.toHaveBeenCalled();
    expect(mergePromptReleasedSessionEntries).toHaveBeenCalledTimes(1);
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("does not retry cleanup acquisition after prompt reacquire lock contention", async () => {
    const reacquireError = new SessionWriteLockTimeoutError({
      timeoutMs: lockOptions.timeoutMs,
      owner: "pid=test",
      lockPath: `${lockOptions.sessionFile}.lock`,
    });
    const releaseInitial = vi.fn(async () => {});
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: releaseInitial })
      .mockRejectedValueOnce(reacquireError)
      .mockResolvedValueOnce({ release: vi.fn(async () => {}) });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const reacquire = controller.reacquireAfterPrompt();
    const cleanupLockPromise = controller.acquireForCleanup();

    await expect(reacquire).rejects.toBe(reacquireError);
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();

    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
    expect(releaseInitial).toHaveBeenCalledTimes(1);
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("makes a late prompt reacquire a no-op after cleanup starts", async () => {
    const releases: string[] = [];
    let resolveCleanupLock!: (lock: { release(): Promise<void> }) => void;
    const pendingCleanupLock = new Promise<{ release(): Promise<void> }>((resolve) => {
      resolveCleanupLock = resolve;
    });
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          releases.push("prep");
        }),
      })
      .mockImplementationOnce(async () => await pendingCleanupLock)
      .mockResolvedValueOnce({
        release: vi.fn(async () => {
          releases.push("unexpected");
        }),
      });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLockPromise = controller.acquireForCleanup();
    await waitUntil(
      () => acquireSessionWriteLockLocal.mock.calls.length === 2,
      "expected cleanup lock acquisition to start",
    );
    let lateReacquireSettled = false;
    const lateReacquire = controller.reacquireAfterPrompt().then(() => {
      lateReacquireSettled = true;
    });
    await Promise.resolve();
    const settledBeforeCleanupAcquired = lateReacquireSettled;

    resolveCleanupLock({
      release: vi.fn(async () => {
        releases.push("cleanup");
      }),
    });
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();
    await lateReacquire;

    expect(settledBeforeCleanupAcquired).toBe(true);
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(2);
    expect(releases).toEqual(["prep", "cleanup"]);
  });

  it("takeHeldLockAfterRetainedIdle does not self-deadlock when called from inside active write scope (#95915)", async () => {
    const events: string[] = [];
    const acquireSessionWriteLockLocal = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("init-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("held-release")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=test",
          lockPath: `${lockOptions.sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: acquireSessionWriteLockLocal,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();

    const takeoverError = await controller
      .withSessionWriteLock(async () => {
        events.push("write-start");
        const cleanupLock = await controller.acquireForCleanup();
        await cleanupLock.release();
        events.push("cleanup-inside-done");
      })
      .catch((error: unknown) => error);

    expect(takeoverError).toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(events).toEqual(["init-release", "write-start", "cleanup-inside-done", "held-release"]);
    expect(acquireSessionWriteLockLocal).toHaveBeenCalledTimes(3);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
