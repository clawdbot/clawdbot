/**
 * Bash process registry tests.
 * Covers output caps, finished-session retention, cleanup, and PTY cursor mode
 * state for background exec sessions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  acknowledgeNotifyOnExit,
  addSession,
  appendOutput,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  isProcessSessionIdTaken,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
  prepareSessionPoll,
  recordNotifyOnExitRemoval,
  setJobTtlMs,
  tail,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createSessionSlug } from "./session-slug.js";

const drainSession = (session: ProcessSession) => prepareSessionPoll(session, undefined);

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

  it("suppresses a notify-on-exit event when terminal poll acknowledgement wins the race", () => {
    const session = createRegistrySession({
      id: "poll-first",
      maxOutputChars: 10_000,
      pendingMaxOutputChars: 30_000,
      backgrounded: true,
    });
    addSession(session);
    markExited(session, 0, null, "completed");
    acknowledgeNotifyOnExit(session);

    const remove = vi.fn(() => true);
    recordNotifyOnExitRemoval(session, remove);

    expect(remove).toHaveBeenCalledOnce();
    expect(getFinishedSession("poll-first")?.terminalPollObserved).toBe(true);
    acknowledgeNotifyOnExit(getFinishedSession("poll-first") ?? {});
    expect(remove).toHaveBeenCalledOnce();
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
    expect(drained.output).toBe("b".repeat(20_000));
    expect(drained.outputDropped).toBe(true);
    expect(session.pendingOutput).toHaveLength(0);
    expect(session.pendingStdoutChars).toBe(0);
    expect(drainSession(session).outputDropped).toBe(false);
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
    expect(drained.output.length).toBe(5_000);
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
    expect(drained.output).toBe("a".repeat(4) + "b".repeat(6) + "c".repeat(10));
    expect(session.truncated).toBe(true);
  });

  it("keeps independently capped stream chunks in callback order", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 10,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "a".repeat(6));
    appendOutput(session, "stderr", "ERR-safe\n");
    appendOutput(session, "stdout", "b".repeat(6));

    expect(session.pendingStdoutChars).toBe(10);
    expect(session.pendingStderrChars).toBe(9);
    const drained = drainSession(session);
    expect(drained.output).toBe(`${"a".repeat(4)}ERR-safe\n${"b".repeat(6)}`);
    expect(drained.outputDropped).toBe(true);
    expect(session.pendingStdoutChars).toBe(0);
    expect(session.pendingStderrChars).toBe(0);
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
    expect(drainSession(session).output).toBe("bc");
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
    expect(drainSession(session).output).toBe("bc");
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
    expect(session.endedAt).toBeUndefined();

    markBackgrounded(session);
    markExited(session, 0, null, "completed");
    const finishedSessions = listFinishedSessions();
    const endedAt = finishedSessions[0]?.endedAt;
    expect(endedAt).toEqual(expect.any(Number));
    expect(finishedSessions).toEqual([session]);
    expect(session.terminalStatus).toBe("completed");
    deleteSession(session.id);
    expect(session.endedAt).toBe(endedAt);
    expect(listFinishedSessions()).toHaveLength(0);
  });

  it("retains unread output on its exact process and consumes it once", () => {
    const session = createRegistrySession({
      id: "exact-finished-output",
      maxOutputChars: 100,
      pendingMaxOutputChars: 100,
      backgrounded: true,
    });
    addSession(session);
    appendOutput(session, "stdout", "terminal output\n");
    markExited(session, 0, null, "completed");

    const finished = getFinishedSession(session.id);
    expect(finished).toBe(session);
    expect(finished && drainSession(finished).output).toBe("terminal output\n");
    expect(drainSession(session).output).toBe("");
  });

  it("evicts the oldest finished sessions when their count exceeds the retention limit", () => {
    for (let index = 0; index < 53; index += 1) {
      const session = createRegistrySession({
        id: `finished-${index}`,
        maxOutputChars: 100,
        pendingMaxOutputChars: 100,
        backgrounded: true,
      });
      addSession(session);
      appendOutput(session, "stdout", `output-${index}`);
      markExited(session, 0, null, "completed");
    }

    expect(listFinishedSessions()).toHaveLength(50);
    expect(getFinishedSession("finished-0")).toBeUndefined();
    expect(getFinishedSession("finished-2")).toBeUndefined();
    expect(getFinishedSession("finished-3")?.aggregated).toBe("output-3");
    expect(getFinishedSession("finished-52")?.aggregated).toBe("output-52");
  });

  it("bounds aggregate finished-session output without truncating retained logs", () => {
    for (let index = 0; index < 11; index += 1) {
      const session = createRegistrySession({
        id: `large-finished-${index}`,
        maxOutputChars: 250_000,
        pendingMaxOutputChars: 250_000,
        backgrounded: true,
      });
      addSession(session);
      appendOutput(session, "stdout", String(index).repeat(250_000));
      markExited(session, 0, null, "completed");
    }

    expect(listFinishedSessions()).toHaveLength(8);
    expect(getFinishedSession("large-finished-2")).toBeUndefined();
    expect(getFinishedSession("large-finished-3")?.aggregated).toBe("3".repeat(250_000));
    expect(getFinishedSession("large-finished-10")?.aggregated).toBe("10".repeat(125_000));
  });

  it("releases the aggregate budget when a completed session is explicitly cleared", () => {
    for (let index = 0; index < 8; index += 1) {
      const session = createRegistrySession({
        id: `clear-budget-${index}`,
        maxOutputChars: 250_000,
        pendingMaxOutputChars: 250_000,
        backgrounded: true,
      });
      addSession(session);
      appendOutput(session, "stdout", String(index).repeat(250_000));
      markExited(session, 0, null, "completed");
    }

    deleteSession("clear-budget-3");

    const replacement = createRegistrySession({
      id: "clear-budget-replacement",
      maxOutputChars: 250_000,
      pendingMaxOutputChars: 250_000,
      backgrounded: true,
    });
    addSession(replacement);
    appendOutput(replacement, "stdout", "r".repeat(250_000));
    markExited(replacement, 0, null, "completed");

    expect(listFinishedSessions()).toHaveLength(8);
    expect(getFinishedSession("clear-budget-0")?.aggregated).toBe("0".repeat(250_000));
    expect(getFinishedSession("clear-budget-3")).toBeUndefined();
    expect(getFinishedSession("clear-budget-replacement")?.aggregated).toBe("r".repeat(250_000));
  });

  it("retains the complete newest log when it alone exceeds the aggregate budget", () => {
    const session = createRegistrySession({
      id: "oversized-finished",
      maxOutputChars: 2_000_001,
      pendingMaxOutputChars: 2_000_001,
      backgrounded: true,
    });
    addSession(session);
    appendOutput(session, "stdout", "x".repeat(2_000_001));
    markExited(session, 0, null, "completed");

    expect(listFinishedSessions()).toHaveLength(1);
    expect(getFinishedSession("oversized-finished")?.aggregated).toHaveLength(2_000_001);
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
    session.backgrounded = false;
    deleteSession(session.id);

    expect(listRunningSessions()).toHaveLength(0);
    expect(getActiveBackgroundExecSessionCount()).toBe(1);

    markExited(session, null, "SIGTERM", "killed");
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
  });

  it.each([false, true])(
    "keeps a hidden active session id reserved until exit (backgrounded=%s)",
    (backgrounded) => {
      const session = createRegistrySession({
        id: "amber-atlas",
        maxOutputChars: 100,
        pendingMaxOutputChars: 30_000,
        backgrounded: false,
      });

      addSession(session);
      if (backgrounded) {
        markBackgrounded(session);
      }
      deleteSession(session.id);
      expect(createSessionSlug(isProcessSessionIdTaken)).toBe("amber-atlas-2");

      session.backgrounded = false;
      markExited(session, 0, null, "completed");
      expect(createSessionSlug(isProcessSessionIdTaken)).toBe("amber-atlas");
    },
  );

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

  it("resets its own registry after another module instance replaces the global test API", async () => {
    const testApiKey = Symbol.for("openclaw.bashProcessRegistryTestApi");
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const originalTestApi = globalStore[testApiKey];
    const session = createRegistrySession({
      id: "original-registry-session",
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: true,
    });
    addSession(session);

    try {
      const registrySpecifier = "./bash-process-registry.js?reset-owner-regression";
      const reloadedRegistry = (await import(
        registrySpecifier
      )) as typeof import("./bash-process-registry.js");
      expect(globalStore[testApiKey]).not.toBe(originalTestApi);
      expect(reloadedRegistry.listRunningSessions()).toEqual([]);

      resetProcessRegistryForTests();
      expect(listRunningSessions()).toEqual([]);
    } finally {
      globalStore[testApiKey] = originalTestApi;
      resetProcessRegistryForTests();
    }
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
