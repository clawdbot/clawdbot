import { describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SessionWriteLockStaleError } from "../../session-write-lock-error.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

describe("attempt session-lock teardown budgets", () => {
  it("bounds cleanup acquisition and releases before a started writer settles", async () => {
    vi.useFakeTimers();
    try {
      let markWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve;
      });
      let resumeWrite!: () => void;
      const writeBlocked = new Promise<void>((resolve) => {
        resumeWrite = resolve;
      });
      const release = vi.fn(async () => undefined);
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release })),
        lockOptions: { sessionFile: "agent:main:main" },
        runId: "cleanup-budget-run",
        sessionId: "cleanup-budget-session",
      });
      const write = controller.withSessionWriteLock(async () => {
        markWriteStarted();
        await writeBlocked;
      });
      await writeStarted;

      const cleanupAcquisition = controller.acquireForCleanup();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const cleanupLock = await cleanupAcquisition;
      expect(release).toHaveBeenCalledOnce();
      expect(controller.hasSessionTakeover()).toBe(true);

      await cleanupLock.release();
      await expect(controller.dispose()).resolves.toBeUndefined();
      resumeWrite();
      await expect(write).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-releases a started writer at the teardown budget and fences its late persist", async () => {
    vi.useFakeTimers();
    try {
      await withOpenClawTestState({ label: "attempt-session-lock-late-persist" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "late-persist-session",
          sessionKey: "agent:main:late-persist-session",
          storePath: state.path("sessions.json"),
        };
        await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const sessionManager = SessionManager.open(target, state.workspaceDir);
        sessionManager.appendModelChange("test", "before");
        const before = await loadTranscriptEvents(target);
        const leaseError = new SessionWriteLockStaleError({
          lockPath: `sqlite:session-write:${target.sessionKey}`,
          owner: "released teardown lease",
          staleReasons: ["lease-lost"],
        });
        let owned = true;
        const release = vi.fn(async () => {
          owned = false;
        });
        const controller = await createEmbeddedAttemptSessionLockController({
          acquireSessionWriteLock: vi.fn(async () => ({
            assertOwned: () => {
              if (!owned) {
                throw leaseError;
              }
            },
            release,
          })),
          lockOptions: { sessionFile: target.sessionKey },
          runId: "late-persist-run",
          sessionId: target.sessionId,
        });
        let markWriteStarted!: () => void;
        const writeStarted = new Promise<void>((resolve) => {
          markWriteStarted = resolve;
        });
        let resumeWrite!: () => void;
        const writeBlocked = new Promise<void>((resolve) => {
          resumeWrite = resolve;
        });
        const write = withOwnedSessionTranscriptWrites(
          {
            sessionFile: target.sessionKey,
            sessionKey: target.sessionKey,
            sessionTarget: target,
            assertOwned: () => controller.assertOwned(),
            withSessionWriteLock: (run, options) => controller.withSessionWriteLock(run, options),
          },
          async () =>
            await controller.withSessionWriteLock(async () => {
              markWriteStarted();
              await writeBlocked;
              sessionManager.appendModelChange("test", "too-late");
            }),
        );
        await writeStarted;

        const disposal = controller.dispose();
        await vi.advanceTimersByTimeAsync(5_000 + 29_999);
        expect(release).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(disposal).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledOnce();

        resumeWrite();
        await expect(write).rejects.toBe(leaseError);
        await expect(loadTranscriptEvents(target)).resolves.toEqual(before);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a started persist settle within the teardown budget before releasing", async () => {
    await withOpenClawTestState(
      { label: "attempt-session-lock-settled-persist" },
      async (state) => {
        const target = {
          agentId: "main",
          sessionId: "settled-persist-session",
          sessionKey: "agent:main:settled-persist-session",
          storePath: state.path("sessions.json"),
        };
        await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const sessionManager = SessionManager.open(target, state.workspaceDir);
        sessionManager.appendModelChange("test", "before");
        const release = vi.fn(async () => undefined);
        const controller = await createEmbeddedAttemptSessionLockController({
          acquireSessionWriteLock: vi.fn(async () => ({ assertOwned: () => undefined, release })),
          lockOptions: { sessionFile: target.sessionKey },
        });
        let markWriteStarted!: () => void;
        const writeStarted = new Promise<void>((resolve) => {
          markWriteStarted = resolve;
        });
        let resumeWrite!: () => void;
        const writeBlocked = new Promise<void>((resolve) => {
          resumeWrite = resolve;
        });
        const write = withOwnedSessionTranscriptWrites(
          {
            sessionFile: target.sessionKey,
            sessionKey: target.sessionKey,
            sessionTarget: target,
            assertOwned: () => controller.assertOwned(),
            withSessionWriteLock: (run, options) => controller.withSessionWriteLock(run, options),
          },
          async () =>
            await controller.withSessionWriteLock(async () => {
              markWriteStarted();
              await writeBlocked;
              sessionManager.appendModelChange("test", "within-budget");
            }),
        );
        await writeStarted;
        const disposal = controller.dispose();
        await Promise.resolve();
        expect(release).not.toHaveBeenCalled();

        resumeWrite();
        await Promise.all([write, disposal]);
        expect(release).toHaveBeenCalledOnce();
        await expect(loadTranscriptEvents(target)).resolves.toContainEqual(
          expect.objectContaining({ modelId: "within-budget", type: "model_change" }),
        );
      },
    );
  });
});
