import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
  installSessionEventWriteLock,
  installSessionExternalHookWriteLock,
} from "./attempt.session-lock.js";

const lockOptions = {
  sessionFile: "/tmp/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
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
  it("releases the coarse attempt lock before prompt submission and reacquires for cleanup", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("cleanup")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(acquireSessionWriteLock).toHaveBeenNthCalledWith(1, lockOptions);
    expect(acquireSessionWriteLock).toHaveBeenNthCalledWith(2, lockOptions);
    expect(releases).toEqual(["prep", "cleanup"]);
  });

  it("runs post-prompt transcript writes under a short reacquired lock", async () => {
    const events: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("post-release")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await controller.withSessionWriteLock(async () => {
      events.push("post-write");
    });

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["prep-release", "post-write", "post-release"]);
  });

  it("reuses its active post-prompt lock for nested session writes", async () => {
    const events: string[] = [];
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLock = vi
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
      acquireSessionWriteLock,
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

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "prep-release",
      "outer-start",
      "inner-write",
      "outer-end",
      "post-release",
    ]);
  });

  it("drains queued Pi session events before reacquiring for cleanup", async () => {
    const events: string[] = [];
    let resolveQueue!: () => void;
    const session = {
      _agentEventQueue: new Promise<void>((resolve) => {
        resolveQueue = resolve;
      }).then(() => {
        events.push("events-drained");
      }),
    };
    let acquireCount = 0;
    const acquireSessionWriteLock = vi.fn(async () => {
      acquireCount += 1;
      events.push(`acquire-${acquireCount}`);
      return {
        release: vi.fn(async () => {
          events.push("release");
        }),
      };
    });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });
    await controller.releaseForPrompt();
    const cleanupLockPromise = controller.acquireForCleanup({ session });

    await Promise.resolve();
    expect(events).toEqual(["acquire-1", "release"]);

    resolveQueue();
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();

    expect(events).toEqual(["acquire-1", "release", "events-drained", "acquire-2", "release"]);
  });

  it("rejects post-prompt writes when another owner advances the session file", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
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

  it("returns a no-op cleanup lock after prompt lock reacquisition times out", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
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
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(releases).toEqual(["prep"]);
  });

  it("skips cleanup lock reacquisition after a post-prompt lock timeout", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
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
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      SessionWriteLockTimeoutError,
    );
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
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
    const session = { agent: { streamFn } };

    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });

    await session.agent.streamFn("model", "context");

    expect(waitForSessionEvents).toHaveBeenCalledWith(session);
    expect(releaseForPrompt).toHaveBeenCalledTimes(1);
    expect(streamFn).toHaveBeenCalledWith("model", "context");
    expect(events).toEqual(["drain", "release", "stream"]);
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
    const session = { agent: { streamFn: firstStreamFn } };

    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });
    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });
    await session.agent.streamFn("first-model");

    session.agent.streamFn = secondStreamFn;
    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });
    await session.agent.streamFn("second-model");

    expect(firstStreamFn).toHaveBeenCalledTimes(1);
    expect(secondStreamFn).toHaveBeenCalledTimes(1);
    expect(waitForSessionEvents).toHaveBeenCalledTimes(2);
    expect(releaseForPrompt).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "drain",
      "release",
      "first-stream",
      "drain",
      "release",
      "second-stream",
    ]);
  });

  it("locks agent events that can reach transcript writers or registered extension hooks", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async (_options: typeof lockOptions) => ({
      release: vi.fn(async () => {
        releases.push("released");
      }),
    }));
    const processed: Array<string | undefined> = [];
    const hasHandlers = vi.fn(() => false);
    const session = {
      _extensionRunner: { hasHandlers },
      _processAgentEvent: vi.fn(async (event: { type?: string }) => {
        processed.push(event.type);
      }),
    };

    installSessionEventWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        const lock = await acquireSessionWriteLock(lockOptions);
        try {
          return await run();
        } finally {
          await lock.release();
        }
      },
    });

    await session._processAgentEvent({ type: "message_update" });
    await session._processAgentEvent({ type: "tool_execution_end" });
    await session._processAgentEvent({ type: "message_end" });
    await session._processAgentEvent({ type: "agent_end" });
    await session._processAgentEvent({});

    expect(processed).toEqual([
      "message_update",
      "tool_execution_end",
      "message_end",
      "agent_end",
      undefined,
    ]);
    expect(hasHandlers).toHaveBeenCalledWith("tool_execution_end");
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(acquireSessionWriteLock).toHaveBeenCalledWith(lockOptions);
    expect(releases).toEqual(["released", "released", "released"]);
  });

  it("locks Pi extension hooks that can mutate the session outside agent events", async () => {
    const locked: string[] = [];
    const called: string[] = [];
    const hasHandlers = vi.fn(
      (eventType: string) =>
        eventType === "tool_call" ||
        eventType === "tool_result" ||
        eventType === "before_provider_request",
    );
    const session = {
      _extensionRunner: { hasHandlers },
      compact: vi.fn(async () => called.push("compact")),
      agent: {
        beforeToolCall: vi.fn(async () => called.push("tool_call")),
        afterToolCall: vi.fn(async () => called.push("tool_result")),
        onPayload: vi.fn(async () => {
          called.push("before_provider_request");
          return { ok: true };
        }),
        onResponse: vi.fn(async () => called.push("after_provider_response")),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        locked.push("lock");
        return await run();
      },
    });

    await session.agent.beforeToolCall();
    await session.agent.afterToolCall();
    await expect(session.agent.onPayload()).resolves.toEqual({ ok: true });
    await session.agent.onResponse();
    await session.compact();

    expect(called).toEqual([
      "tool_call",
      "tool_result",
      "before_provider_request",
      "after_provider_response",
      "compact",
    ]);
    expect(locked).toEqual(["lock", "lock", "lock", "lock"]);
    expect(hasHandlers).toHaveBeenCalledWith("tool_result");
    expect(hasHandlers).toHaveBeenCalledWith("before_provider_request");
    expect(hasHandlers).toHaveBeenCalledWith("after_provider_response");
  });

  it("fences tool calls even when no extension hook is registered", async () => {
    const events: string[] = [];
    const session = {
      _extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
      agent: {
        beforeToolCall: vi.fn(async () => {
          events.push("tool_call");
        }),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        events.push("lock");
        return await run();
      },
    });

    await session.agent.beforeToolCall();

    expect(events).toEqual(["lock", "tool_call"]);
    expect(session._extensionRunner.hasHandlers).not.toHaveBeenCalledWith("tool_call");
  });

  it("drains queued session events before locking a tool-call extension hook", async () => {
    const events: string[] = [];
    let resolveQueue!: () => void;
    const session = {
      _agentEventQueue: new Promise<void>((resolve) => {
        resolveQueue = resolve;
      }).then(() => {
        events.push("queue-drained");
      }),
      _extensionRunner: {
        hasHandlers: vi.fn((eventType: string) => eventType === "tool_call"),
      },
      agent: {
        beforeToolCall: vi.fn(async () => {
          events.push("hook-start");
          await session._agentEventQueue;
          events.push("hook-end");
        }),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        events.push("lock");
        return await run();
      },
    });

    const hookPromise = session.agent.beforeToolCall();
    await Promise.resolve();
    expect(events).toEqual([]);

    resolveQueue();
    await hookPromise;

    expect(events).toEqual(["queue-drained", "lock", "hook-start", "hook-end"]);
  });
});
