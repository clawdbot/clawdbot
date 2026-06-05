/**
 * Test fixtures for bash process registry state.
 * Provides complete session objects so tests can focus on the field under
 * inspection without repeating registry defaults.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessSession } from "./bash-process-registry.js";

/** Build a process-session fixture with safe defaults for registry tests. */
export function createProcessSessionFixture(params: {
  id: string;
  command?: string;
  startedAt?: number;
  cwd?: string;
  maxOutputChars?: number;
  pendingMaxOutputChars?: number;
  backgrounded?: boolean;
  pid?: number;
  child?: ChildProcessWithoutNullStreams;
  cursorKeyMode?: ProcessSession["cursorKeyMode"];
}): ProcessSession {
  const session: ProcessSession = {
    id: params.id,
    command: params.command ?? "test",
    startedAt: params.startedAt ?? Date.now(),
    cwd: params.cwd ?? "/tmp",
    maxOutputChars: params.maxOutputChars ?? 10_000,
    pendingMaxOutputChars: params.pendingMaxOutputChars ?? 30_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
    truncated: false,
    backgrounded: params.backgrounded ?? false,
    cursorKeyMode: params.cursorKeyMode ?? "normal",
  };
  if (params.pid !== undefined) {
    session.pid = params.pid;
  }
  if (params.child) {
    session.child = params.child;
  }
  return session;
}
