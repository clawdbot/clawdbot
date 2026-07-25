import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
} from "./attempt.session-lock.js";

describe("createEmbeddedAttemptSessionLockController", () => {
  it("reloads SQLite transcript state after prompt-time writers finish", async () => {
    const reloadPromptReleasedSessionFile = vi.fn(async () => undefined);
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
      reloadPromptReleasedSessionFile,
    });

    await controller.reacquireAfterPrompt();

    expect(reloadPromptReleasedSessionFile).toHaveBeenCalledOnce();
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
});
