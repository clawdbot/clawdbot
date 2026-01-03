import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  appendOutput,
  listFinishedSessions,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";

describe("bash process registry", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it("captures output and truncates", () => {
    const session: ProcessSession = {
      id: "sess",
      command: "echo test",
      child: { pid: 123 } as ChildProcessWithoutNullStreams,
      startedAt: Date.now(),
      cwd: "/tmp",
      maxOutputChars: 10,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      aggregated: "",
      tail: "",
      exited: false,
      exitCode: undefined,
      exitSignal: undefined,
      truncated: false,
      backgrounded: false,
    };

    addSession(session);
    appendOutput(session, "stdout", "0123456789");
    appendOutput(session, "stdout", "abcdef");

    expect(session.aggregated).toBe("6789abcdef");
    expect(session.truncated).toBe(true);
  });

  it("only persists finished sessions when backgrounded", () => {
    const session: ProcessSession = {
      id: "sess",
      command: "echo test",
      child: { pid: 123 } as ChildProcessWithoutNullStreams,
      startedAt: Date.now(),
      cwd: "/tmp",
      maxOutputChars: 100,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      aggregated: "",
      tail: "",
      exited: false,
      exitCode: undefined,
      exitSignal: undefined,
      truncated: false,
      backgrounded: false,
    };

    addSession(session);
    markExited(session, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(0);

    markBackgrounded(session);
    markExited(session, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(1);
  });
});
