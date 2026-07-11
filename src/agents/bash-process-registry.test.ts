/**
 * Bash process registry tests.
 * Covers output caps, finished-session retention, cleanup, and PTY cursor mode
 * state for background exec sessions.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  deleteSession,
  drainSession,
  getActiveBackgroundExecSessionCount,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
  setJobTtlMs,
  tail,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureInt: vi.fn(() => 0),
}));

vi.mock("../infra/secure-random.js", () => ({
  generateSecureInt: randomMocks.generateSecureInt,
}));

describe("bash process registry", () => {
  function createRegistrySession(params: {
    id?: string;
    maxOutputChars: number;
    pendingMaxOutputChars: number;
    backgrounded: boolean;
  }): ProcessSession {
    return createProcessSessionFixture({
      id: params.id ?? "sess",
      command: "echo test",
      child: { pid: 123, removeAllListeners: vi.fn() } as unknown as ChildProcessWithoutNullStreams,
      maxOutputChars: params.maxOutputChars,
      pendingMaxOutputChars: params.pendingMaxOutputChars,
      backgrounded: params.backgrounded,
    });
  }

  beforeEach(() => {
    randomMocks.generateSecureInt.mockReset();
    randomMocks.generateSecureInt.mockReturnValue(0);
    resetProcessRegistryForTests();
  });

  it("captures output and truncates", () => {
    const session = createRegistrySession({
      maxOutputChars: 10,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    appendOutput(session, "stdout", "0123456789");
    appendOutput(session, "stdout", "abcdef");

    expect(session.aggregated).toBe("6789abcdef");
    expect(session.truncated).toBe(true);
  });

  it("caps pending output to avoid runaway polls", () => {
    const session = createRegistrySession({
      maxOutputChars: 100_000,
      pendingMaxOutputChars: 20_000,
      backgrounded: true,
    });

    addSession(session);
    const payload = `${"a".repeat(70_000)}${"b".repeat(20_000)}`;
    appendOutput(session, "stdout", payload);

    const drained = drainSession(session);
    expect(drained.stdout).toBe("b".repeat(20_000));
    expect(session.pendingStdout).toHaveLength(0);
    expect(session.pendingStdoutChars).toBe(0);
    expect(session.truncated).toBe(true);
  });

  it("respects max output cap when pending cap is larger", () => {
    const session = createRegistrySession({
      maxOutputChars: 5_000,
      pendingMaxOutputChars: 30_000,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "x".repeat(10_000));

    const drained = drainSession(session);
    expect(drained.stdout.length).toBe(5_000);
    expect(session.truncated).toBe(true);
  });

  it("caps stdout and stderr independently", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 10,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "a".repeat(6));
    appendOutput(session, "stdout", "b".repeat(6));
    appendOutput(session, "stderr", "c".repeat(12));

    const drained = drainSession(session);
    expect(drained.stdout).toBe("a".repeat(4) + "b".repeat(6));
    expect(drained.stderr).toBe("c".repeat(10));
    expect(session.truncated).toBe(true);
  });

  it("keeps aggregate, pending, and tail suffix cuts on UTF-16 boundaries", () => {
    const session = createRegistrySession({
      maxOutputChars: 3,
      pendingMaxOutputChars: 3,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "a🎉bc");

    expect(session.aggregated).toBe("bc");
    expect(session.pendingStdoutChars).toBe(2);
    expect(drainSession(session).stdout).toBe("bc");
    expect(tail("a🎉bc", 3)).toBe("bc");
  });

  it("keeps multi-chunk pending output on a UTF-16 boundary", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 3,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "a🎉");
    appendOutput(session, "stdout", "bc");

    expect(session.pendingStdoutChars).toBe(2);
    expect(drainSession(session).stdout).toBe("bc");
  });

  it("only persists finished sessions when backgrounded", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    markExited(session, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(0);

    markBackgrounded(session);
    markExited(session, 0, null, "completed");
    const finishedSessions = listFinishedSessions();
    const endedAt = finishedSessions[0]?.endedAt;
    expect(endedAt).toEqual(expect.any(Number));
    expect(finishedSessions).toStrictEqual([
      {
        id: "sess",
        command: "echo test",
        scopeKey: undefined,
        startedAt: session.startedAt,
        endedAt,
        cwd: "/tmp",
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        exitReason: undefined,
        aggregated: "",
        tail: "",
        truncated: false,
        totalOutputChars: 0,
      },
    ]);
  });

  it("tracks only live backgrounded sessions", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    expect(getActiveBackgroundExecSessionCount()).toBe(0);

    markBackgrounded(session);
    markBackgrounded(session);
    expect(getActiveBackgroundExecSessionCount()).toBe(1);

    markExited(session, 0, null, "completed");
    expect(getActiveBackgroundExecSessionCount()).toBe(0);

    markBackgrounded(session);
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
  });

  it("keeps a hidden background session active until its process exits", () => {
    const session = createRegistrySession({
      id: "hidden-until-exit",
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    markBackgrounded(session);
    deleteSession(session.id);

    expect(listRunningSessions()).toHaveLength(0);
    expect(getActiveBackgroundExecSessionCount()).toBe(1);

    markExited(session, null, "SIGTERM", "killed");
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
  });

  it("keeps a hidden active session id reserved until exit", () => {
    const session = createRegistrySession({
      id: "amber-atlas",
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    markBackgrounded(session);
    deleteSession(session.id);
    expect(createSessionSlug()).toBe("amber-atlas-2");

    session.backgrounded = false;
    markExited(session, 0, null, "completed");
    expect(createSessionSlug()).toBe("amber-atlas");
  });

  it("clears background activity in the test reset", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    markBackgrounded(session);
    expect(getActiveBackgroundExecSessionCount()).toBe(1);

    resetProcessRegistryForTests();
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
  });

  it("clamps a zero retention TTL to one minute", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-09T00:00:00Z"));
      setJobTtlMs(0);

      const session = createRegistrySession({
        id: "zero-ttl",
        maxOutputChars: 100,
        pendingMaxOutputChars: 30_000,
        backgrounded: true,
      });
      addSession(session);
      markExited(session, 0, null, "completed");

      vi.advanceTimersByTime(30_000);
      expect(listFinishedSessions()).toHaveLength(1);

      vi.advanceTimersByTime(60_000);
      expect(listFinishedSessions()).toHaveLength(0);
    } finally {
      resetProcessRegistryForTests();
      setJobTtlMs(30 * 60 * 1000);
      resetProcessRegistryForTests();
      vi.useRealTimers();
    }
  });
});

describe("cursorKeyMode", () => {
  function createRegistrySession(params: {
    id?: string;
    maxOutputChars: number;
    pendingMaxOutputChars: number;
    backgrounded: boolean;
    cursorKeyMode?: ProcessSession["cursorKeyMode"];
  }): ProcessSession {
    return createProcessSessionFixture({
      id: params.id ?? "sess",
      command: "echo test",
      child: { pid: 123, removeAllListeners: vi.fn() } as unknown as ChildProcessWithoutNullStreams,
      maxOutputChars: params.maxOutputChars,
      pendingMaxOutputChars: params.pendingMaxOutputChars,
      backgrounded: params.backgrounded,
      cursorKeyMode: params.cursorKeyMode,
    });
  }

  it("session cursorKeyMode can start unknown", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
      cursorKeyMode: "unknown",
    });
    expect(session.cursorKeyMode).toBe("unknown");
  });

  it("session cursorKeyMode can be set to application", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });
    session.cursorKeyMode = "application";
    expect(session.cursorKeyMode).toBe("application");
  });

  it("session cursorKeyMode can be toggled between normal and application", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
      cursorKeyMode: "unknown",
    });
    expect(session.cursorKeyMode).toBe("unknown");

    session.cursorKeyMode = "application";
    expect(session.cursorKeyMode).toBe("application");

    session.cursorKeyMode = "normal";
    expect(session.cursorKeyMode).toBe("normal");
  });
});
