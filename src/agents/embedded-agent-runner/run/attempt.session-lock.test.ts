import { describe, expect, it, vi } from "vitest";
import { SessionWriteLockStaleError } from "../../session-write-lock-error.js";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
} from "./attempt.session-lock.js";

describe("createEmbeddedAttemptSessionLockController", () => {
  it("reloads SQLite transcript state after prompt-time writers finish", async () => {
    const reloadPromptReleasedSessionFile = vi.fn(async () => undefined);
    const acquireSessionWriteLock = vi.fn(async () => ({ release: async () => undefined }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile,
    });

    await controller.reacquireAfterPrompt();

    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
    expect(acquireSessionWriteLock).toHaveBeenCalledWith({
      sessionFile: "agent:main:main",
      targetKind: "session-key",
    });
  });

  it("serializes the complete SQLite write callbacks", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    const first = controller.withSessionWriteLock(async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    const second = controller.withSessionWriteLock(() => {
      events.push("second");
    });

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("fences transcript writes after the SQLite session lease is lost", async () => {
    const leaseError = new SessionWriteLockStaleError({
      lockPath: "sqlite:session-write:agent:main:main",
      owner: "replacement",
      staleReasons: ["lease-lost"],
    });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({
        assertOwned: () => {
          throw leaseError;
        },
        release: async () => undefined,
      })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(controller.withSessionWriteLock(() => undefined)).rejects.toBe(leaseError);
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("blocks prompt submission after the SQLite session lease is lost", async () => {
    const leaseError = new SessionWriteLockStaleError({
      lockPath: "sqlite:session-write:agent:main:main",
      owner: "replacement",
      staleReasons: ["lease-lost"],
    });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({
        assertOwned: () => {
          throw leaseError;
        },
        release: async () => undefined,
      })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(controller.releaseForPrompt()).rejects.toBe(leaseError);
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("allows nested writes to reuse the active lifecycle owner", async () => {
    const events: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await controller.withSessionWriteLock(async () => {
      events.push("outer:start");
      await controller.withSessionWriteLock(() => {
        events.push("nested");
      });
      events.push("outer:end");
    });

    expect(events).toEqual(["outer:start", "nested", "outer:end"]);
  });

  it("queues async descendants that resume after their lifecycle owner exits", async () => {
    let resumeDescendant!: () => void;
    const descendantBlocked = new Promise<void>((resolve) => {
      resumeDescendant = resolve;
    });
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const events: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    let descendant!: Promise<void>;

    await controller.withSessionWriteLock(() => {
      descendant = (async () => {
        await descendantBlocked;
        await controller.withSessionWriteLock(() => {
          events.push("descendant");
        });
      })();
    });
    const second = controller.withSessionWriteLock(async () => {
      events.push("second:start");
      await secondBlocked;
      events.push("second:end");
    });

    await vi.waitFor(() => expect(events).toEqual(["second:start"]));
    resumeDescendant();
    await Promise.resolve();
    expect(events).toEqual(["second:start"]);
    releaseSecond();
    await Promise.all([second, descendant]);

    expect(events).toEqual(["second:start", "second:end", "descendant"]);
  });

  it("keeps the lifecycle held until detached nested writes settle", async () => {
    let releaseNested!: () => void;
    const nestedBlocked = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const events: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    const outer = controller.withSessionWriteLock(() => {
      void controller.withSessionWriteLock(async () => {
        events.push("nested:start");
        await nestedBlocked;
        events.push("nested:end");
      });
    });
    const second = controller.withSessionWriteLock(() => {
      events.push("second");
    });

    await vi.waitFor(() => expect(events).toEqual(["nested:start"]));
    releaseNested();
    await Promise.all([outer, second]);

    expect(events).toEqual(["nested:start", "nested:end", "second"]);
  });

  it("serializes sibling nested writes in submission order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await controller.withSessionWriteLock(async () => {
      const first = controller.withSessionWriteLock(async () => {
        events.push("first:start");
        await firstBlocked;
        events.push("first:end");
      });
      const second = controller.withSessionWriteLock(() => {
        events.push("second");
      });
      await vi.waitFor(() => expect(events).toEqual(["first:start"]));
      releaseFirst();
      await Promise.all([first, second]);
    });

    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("propagates failures from detached nested writes", async () => {
    const nestedError = new Error("nested write failed");
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(
      controller.withSessionWriteLock(() => {
        void controller.withSessionWriteLock(() => {
          throw nestedError;
        });
      }),
    ).rejects.toBe(nestedError);
  });

  it("waits for every detached nested write before propagating failure", async () => {
    const nestedError = new Error("nested write failed");
    let releaseSlowWrite!: () => void;
    const slowWriteBlocked = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });
    const slowWriteStarted = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const completion = controller.withSessionWriteLock(() => {
      void controller.withSessionWriteLock(() => {
        throw nestedError;
      });
      void controller.withSessionWriteLock(async () => {
        slowWriteStarted();
        await slowWriteBlocked;
      });
    });
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(slowWriteStarted).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    releaseSlowWrite();
    await expect(completion).rejects.toBe(nestedError);
  });

  it("preserves the callback error when a handled nested write also failed", async () => {
    const primaryError = new Error("outer write failed");
    const nestedError = new Error("nested write failed");
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(
      controller.withSessionWriteLock(async () => {
        await controller
          .withSessionWriteLock(() => {
            throw nestedError;
          })
          .catch(() => undefined);
        throw primaryError;
      }),
    ).rejects.toBe(primaryError);
    expect(primaryError.cause).toBe(nestedError);
  });

  it("preserves a frozen callback error when nested drain also failed", async () => {
    const primaryError = new Error("outer write failed");
    Object.freeze(primaryError);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(
      controller.withSessionWriteLock(async () => {
        await controller
          .withSessionWriteLock(() => {
            throw new Error("nested write failed");
          })
          .catch(() => undefined);
        throw primaryError;
      }),
    ).rejects.toBe(primaryError);
  });

  it("does not attach a propagated nested error as its own cause", async () => {
    const nestedError = new Error("nested write failed");
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(
      controller.withSessionWriteLock(async () => {
        await controller.withSessionWriteLock(() => {
          throw nestedError;
        });
      }),
    ).rejects.toBe(nestedError);
    expect(nestedError.cause).toBeUndefined();
  });

  it("terminally fences writes after a generic prompt reload failure", async () => {
    const reloadError = new Error("reload failed");
    const run = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile: () => {
        throw reloadError;
      },
    });

    await expect(controller.reacquireAfterPrompt()).rejects.toBe(reloadError);
    await expect(controller.withSessionWriteLock(run)).rejects.toBe(reloadError);
    await controller.releaseForPrompt();
    await expect(controller.reacquireAfterPrompt()).rejects.toBe(reloadError);
    await expect(controller.acquireForCleanup()).resolves.toBeDefined();

    expect(run).not.toHaveBeenCalled();
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("marks only takeover reload failures as session takeover", async () => {
    const takeoverError = new EmbeddedAttemptSessionTakeoverError("agent:main:main");
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile: () => {
        throw takeoverError;
      },
    });

    await expect(controller.reacquireAfterPrompt()).rejects.toBe(takeoverError);

    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("does not wait on a stalled reload after the disposal timeout", async () => {
    vi.useFakeTimers();
    try {
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
        lockOptions: { sessionFile: "agent:main:main" },
        reloadPromptReleasedSessionFile: async () => await new Promise<void>(() => {}),
      });

      await controller.releaseForPrompt();
      void controller.reacquireAfterPrompt();
      await Promise.resolve();
      const disposal = controller.dispose();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(disposal).resolves.toBeUndefined();
      await expect(controller.releaseForPrompt()).rejects.toThrow(
        "attempt disposed before prompt submission",
      );
      await expect(controller.reacquireAfterPrompt()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued writes inside the disposal timeout when prompt reload stalls", async () => {
    vi.useFakeTimers();
    try {
      let markReloadStarted!: () => void;
      const reloadStarted = new Promise<void>((resolve) => {
        markReloadStarted = resolve;
      });
      let finishReload!: () => void;
      const reloadBlocked = new Promise<void>((resolve) => {
        finishReload = resolve;
      });
      const release = vi.fn(async () => undefined);
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release })),
        lockOptions: { sessionFile: "agent:main:main" },
        reloadPromptReleasedSessionFile: async () => {
          markReloadStarted();
          await reloadBlocked;
        },
      });
      await controller.releaseForPrompt();
      const reacquire = controller.reacquireAfterPrompt();
      await reloadStarted;
      const writeCallback = vi.fn();
      const queuedWrite = controller.withSessionWriteLock(writeCallback);
      const queuedWriteOutcome = queuedWrite.then(
        () => undefined,
        (error: unknown) => error,
      );

      const disposal = controller.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(disposal).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
      expect(writeCallback).not.toHaveBeenCalled();

      finishReload();
      await expect(reacquire).resolves.toBeUndefined();
      await expect(queuedWriteOutcome).resolves.toEqual(
        expect.objectContaining({ message: "attempt disposed before transcript write" }),
      );
      expect(writeCallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects disposal from inside a write callback", async () => {
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await controller.withSessionWriteLock(async () => {
      await expect(controller.dispose()).rejects.toThrow(
        "cannot dispose an attempt from inside a transcript write callback",
      );
      expect(release).not.toHaveBeenCalled();
    });
    expect(release).not.toHaveBeenCalled();
    await controller.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects cleanup from inside a write callback", async () => {
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await controller.withSessionWriteLock(async () => {
      await expect(controller.acquireForCleanup()).rejects.toThrow(
        "cannot start attempt cleanup inside a transcript write callback",
      );
      expect(release).not.toHaveBeenCalled();
    });
    const cleanupLock = await controller.acquireForCleanup();
    await expect(controller.withSessionWriteLock(async () => undefined)).rejects.toThrow(
      "attempt cleanup started before transcript write",
    );
    await cleanupLock.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps cleanup ownership until the granted cleanup lock is released", async () => {
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const cleanupLock = await controller.acquireForCleanup();

    let disposeSettled = false;
    const disposal = controller.dispose().then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();

    expect(disposeSettled).toBe(false);
    expect(release).not.toHaveBeenCalled();
    await cleanupLock.release();
    await disposal;
    expect(release).toHaveBeenCalledOnce();
  });

  it("retries the underlying release when cleanup release fails", async () => {
    const releaseError = new Error("release failed");
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(releaseError)
      .mockResolvedValueOnce(undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const cleanupLock = await controller.acquireForCleanup();
    const disposal = controller.dispose();

    await expect(cleanupLock.release()).rejects.toBe(releaseError);
    await expect(disposal).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("rejects a second cleanup acquisition without replacing ownership", async () => {
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const cleanupLock = await controller.acquireForCleanup();

    await expect(controller.acquireForCleanup()).rejects.toThrow("attempt cleanup already started");
    await cleanupLock.release();
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it("allows cleanup from an async descendant after its write callback settles", async () => {
    let resumeDescendant!: () => void;
    const descendantBlocked = new Promise<void>((resolve) => {
      resumeDescendant = resolve;
    });
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    let descendant!: Promise<void>;

    await controller.withSessionWriteLock(() => {
      descendant = (async () => {
        await descendantBlocked;
        const cleanupLock = await controller.acquireForCleanup();
        await cleanupLock.release();
      })();
    });
    resumeDescendant();
    await descendant;

    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps a started write callback locked beyond the disposal timeout", async () => {
    vi.useFakeTimers();
    try {
      let releaseWrite!: () => void;
      const writeBlocked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const release = vi.fn(async () => undefined);
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release })),
        lockOptions: { sessionFile: "agent:main:main" },
      });
      const writeStarted = vi.fn();
      const write = controller.withSessionWriteLock(async () => {
        writeStarted();
        await writeBlocked;
      });
      await vi.waitFor(() => expect(writeStarted).toHaveBeenCalledOnce());

      let disposeSettled = false;
      const disposal = controller.dispose().then(() => {
        disposeSettled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disposeSettled).toBe(false);
      expect(release).not.toHaveBeenCalled();

      releaseWrite();
      await Promise.all([write, disposal]);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a started write finish nested writes after disposal begins", async () => {
    let resumeOuter!: () => void;
    const outerBlocked = new Promise<void>((resolve) => {
      resumeOuter = resolve;
    });
    const nestedWrite = vi.fn();
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const outer = controller.withSessionWriteLock(async () => {
      await outerBlocked;
      await controller.withSessionWriteLock(nestedWrite);
    });
    await Promise.resolve();
    const disposal = controller.dispose();

    resumeOuter();
    await Promise.all([outer, disposal]);
    expect(nestedWrite).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps disposal tied to a released prompt until the bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
        lockOptions: { sessionFile: "agent:main:main" },
      });
      await controller.releaseForPrompt();
      let disposed = false;
      const disposal = controller.dispose().then(() => {
        disposed = true;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(disposed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a released prompt when reacquire arrives after disposal", async () => {
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    await controller.releaseForPrompt();
    const disposal = controller.dispose();

    await controller.reacquireAfterPrompt();
    await expect(disposal).resolves.toBeUndefined();
  });

  it("keeps a queued next prompt settlement after the prior reacquire finishes", async () => {
    vi.useFakeTimers();
    try {
      let markReloadStarted!: () => void;
      const reloadStarted = new Promise<void>((resolve) => {
        markReloadStarted = resolve;
      });
      let finishReload!: () => void;
      const reloadBlocked = new Promise<void>((resolve) => {
        finishReload = resolve;
      });
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
        lockOptions: { sessionFile: "agent:main:main" },
        reloadPromptReleasedSessionFile: async () => {
          markReloadStarted();
          await reloadBlocked;
        },
      });

      await controller.releaseForPrompt();
      const firstReacquire = controller.reacquireAfterPrompt();
      await reloadStarted;
      const secondRelease = controller.releaseForPrompt();
      finishReload();
      await Promise.all([firstReacquire, secondRelease]);

      let disposed = false;
      const disposal = controller.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(disposed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps repeated disposal bounded after abort clears the prompt release", async () => {
    vi.useFakeTimers();
    try {
      let markReloadStarted!: () => void;
      const reloadStarted = new Promise<void>((resolve) => {
        markReloadStarted = resolve;
      });
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
        lockOptions: { sessionFile: "agent:main:main" },
        reloadPromptReleasedSessionFile: async () => {
          markReloadStarted();
          await new Promise<void>(() => {});
        },
      });

      await controller.releaseForPrompt();
      void controller.reacquireAfterPrompt();
      await reloadStarted;
      await controller.releaseHeldLockForAbort();
      const firstDisposal = controller.dispose();
      const secondDisposal = controller.dispose();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(Promise.all([firstDisposal, secondDisposal])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a late SDK prompt handoff after cleanup has started", async () => {
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await controller.acquireForCleanup();
    await expect(controller.releaseForPrompt()).rejects.toThrow(
      "attempt cleanup started before prompt submission",
    );
  });

  it("rejects a late SDK prompt handoff after disposal", async () => {
    const write = vi.fn();
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await controller.dispose();
    await controller.dispose();
    await expect(controller.releaseForPrompt()).rejects.toThrow(
      "attempt disposed before prompt submission",
    );
    await expect(controller.withSessionWriteLock(write)).rejects.toThrow(
      "attempt disposed before transcript write",
    );
    expect(write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retries direct disposal when the underlying release fails", async () => {
    const releaseError = new Error("release failed");
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(releaseError)
      .mockResolvedValueOnce(undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });

    await expect(controller.dispose()).rejects.toBe(releaseError);
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("keeps session ownership until an active write callback settles", async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const release = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const write = controller.withSessionWriteLock(async () => await writeBlocked);
    await Promise.resolve();
    let disposeSettled = false;
    const disposal = controller.dispose().then(() => {
      disposeSettled = true;
    });

    await Promise.resolve();
    expect(disposeSettled).toBe(false);
    expect(release).not.toHaveBeenCalled();
    releaseWrite();
    await Promise.all([write, disposal]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reloads after a delayed prompt following a non-terminal sessions_yield abort", async () => {
    const reloadPromptReleasedSessionFile = vi.fn();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile,
    });

    await controller.releaseHeldLockForAbort({ terminal: false });
    await expect(controller.releaseForPrompt()).resolves.toBeUndefined();
    await expect(controller.reacquireAfterPrompt()).resolves.toBeUndefined();
    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
  });

  it("reloads released transcript state during cleanup after a terminal abort", async () => {
    const reloadPromptReleasedSessionFile = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile,
    });

    await controller.releaseForPrompt();
    await controller.releaseHeldLockForAbort();
    const cleanupLock = await controller.acquireForCleanup();

    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
    await cleanupLock.release();
  });

  it("rejects cleanup acquisition when disposal wins during prompt reload", async () => {
    vi.useFakeTimers();
    try {
      let markReloadStarted!: () => void;
      const reloadStarted = new Promise<void>((resolve) => {
        markReloadStarted = resolve;
      });
      let finishReload!: () => void;
      const reloadBlocked = new Promise<void>((resolve) => {
        finishReload = resolve;
      });
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
        lockOptions: { sessionFile: "agent:main:main" },
        reloadPromptReleasedSessionFile: async () => {
          markReloadStarted();
          await reloadBlocked;
        },
      });
      await controller.releaseForPrompt();
      const cleanupAcquisition = controller.acquireForCleanup();
      const cleanupOutcome = cleanupAcquisition.then(
        () => undefined,
        (error: unknown) => error,
      );
      await reloadStarted;

      const disposal = controller.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(disposal).resolves.toBeUndefined();
      finishReload();

      await expect(cleanupOutcome).resolves.toEqual(
        expect.objectContaining({ message: "attempt disposed before cleanup" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets cleanup settle a completed prompt when the SDK omits reacquire", async () => {
    const reloadPromptReleasedSessionFile = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile,
    });

    await controller.releaseForPrompt();
    await expect(controller.acquireForCleanup()).resolves.toBeDefined();
    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
    await expect(controller.reacquireAfterPrompt()).resolves.toBeUndefined();
    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
    await expect(controller.releaseForPrompt()).rejects.toThrow(
      "attempt cleanup started before prompt submission",
    );
  });
});

describe("installPromptSubmissionLockRelease", () => {
  it("preserves the provider error when prompt settlement also fails", async () => {
    const providerError = new Error("provider failed");
    const settlementError = new Error("reacquire failed");
    const session = {
      agent: {
        streamFn: vi.fn(async () => {
          throw providerError;
        }),
      },
    };
    installPromptSubmissionLockRelease({
      session,
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => {
        throw settlementError;
      }),
    });

    await expect(session.agent.streamFn()).rejects.toBe(providerError);
    expect(providerError.cause).toBe(settlementError);
  });

  it("does not attach a shared provider and settlement error as its own cause", async () => {
    const sharedError = new Error("shared failure");
    const session = {
      agent: {
        streamFn: vi.fn(async () => {
          throw sharedError;
        }),
      },
    };
    installPromptSubmissionLockRelease({
      session,
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => {
        throw sharedError;
      }),
    });

    await expect(session.agent.streamFn()).rejects.toBe(sharedError);
    expect(sharedError.cause).toBeUndefined();
  });

  it("preserves an undefined prompt settlement rejection", async () => {
    const session = { agent: { streamFn: vi.fn(async () => "ok") } };
    const undefinedRejection = new Promise<void>((_resolve, reject) => {
      queueMicrotask(() => {
        Reflect.apply(reject, undefined, [undefined]);
      });
    });
    installPromptSubmissionLockRelease({
      session,
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(() => undefinedRejection),
    });

    await expect(session.agent.streamFn()).rejects.toBeUndefined();
  });

  it("preserves a frozen provider error when prompt settlement also fails", async () => {
    const providerError = new Error("frozen provider failure");
    Object.freeze(providerError);
    const session = {
      agent: {
        streamFn: vi.fn(async () => {
          throw providerError;
        }),
      },
    };
    installPromptSubmissionLockRelease({
      session,
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => {
        throw new Error("settlement failed");
      }),
    });

    await expect(session.agent.streamFn()).rejects.toBe(providerError);
  });
});
