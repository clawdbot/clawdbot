import { describe, expect, it, vi } from "vitest";
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
    expect(() => controller.withOwnedSessionFileWrite(write)).toThrow(
      "attempt disposed before transcript write",
    );
    await expect(controller.withSessionWriteLock(write)).rejects.toThrow(
      "attempt disposed before transcript write",
    );
    expect(write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
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
  it("reacquires after a post-stream event drain failure", async () => {
    const drainError = new Error("event drain failed");
    const session = { agent: { streamFn: vi.fn(async () => "ok") } };
    const waitForSessionEvents = vi
      .fn<(session: unknown) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(drainError);
    const reacquireAfterPrompt = vi.fn(async () => undefined);
    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt,
    });

    await expect(session.agent.streamFn()).rejects.toBe(drainError);
    expect(reacquireAfterPrompt).toHaveBeenCalledOnce();
  });

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
      waitForSessionEvents: vi.fn(async () => undefined),
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => {
        throw settlementError;
      }),
    });

    await expect(session.agent.streamFn()).rejects.toBe(providerError);
    expect(providerError.cause).toBe(settlementError);
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
      waitForSessionEvents: vi.fn(async () => undefined),
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
      waitForSessionEvents: vi.fn(async () => undefined),
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => {
        throw new Error("settlement failed");
      }),
    });

    await expect(session.agent.streamFn()).rejects.toBe(providerError);
  });
});
