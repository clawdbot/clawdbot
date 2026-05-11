import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSession,
  appendOutput,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

type ProcessTool = ReturnType<typeof createProcessTool>;
type ProcessToolResult = Awaited<ReturnType<ProcessTool["execute"]>>;

afterEach(() => {
  resetProcessRegistryForTests();
  vi.useRealTimers();
});

async function runProcessAction(
  processTool: ProcessTool,
  args: Record<string, unknown>,
): Promise<ProcessToolResult> {
  return processTool.execute("toolcall", args as Parameters<ProcessTool["execute"]>[1], undefined);
}

function textOf(result: ProcessToolResult): string {
  const item = result.content[0];
  return item?.type === "text" ? item.text : "";
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toBeDefined();
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

function installWritableStdin(
  session: ReturnType<typeof createProcessSessionFixture>,
  state?: { writableEnded?: boolean; writableFinished?: boolean; destroyed?: boolean },
) {
  session.stdin = {
    write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => cb?.(null)),
    end: vi.fn(),
    destroyed: state?.destroyed ?? false,
    writableEnded: state?.writableEnded,
    writableFinished: state?.writableFinished,
  } as NonNullable<typeof session.stdin> & {
    writableEnded?: boolean;
    writableFinished?: boolean;
  };
}

describe("process input-wait hints", () => {
  it("adds output and input-wait metadata to log for an idle writable session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:20.000Z"));
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-log-hint",
      command: "node cli.js",
      backgrounded: true,
      startedAt: Date.now() - 20_000,
    });
    installWritableStdin(session);
    appendOutput(session, "stdout", "Name? ");
    addSession(session);

    const result = await runProcessAction(processTool, {
      action: "log",
      sessionId: "sess-log-hint",
    });

    const text = textOf(result);
    expect(text).toContain("Name? ");
    expect(text).toContain("No new output for 20s");
    expect(text).toContain("Use process write, send-keys, submit, or paste to provide input.");
    expectRecordFields(result.details, {
      status: "running",
      sessionId: "sess-log-hint",
      stdinWritable: true,
      waitingForInput: true,
      idleMs: 20_000,
      lastOutputAt: Date.now() - 20_000,
    });
  });

  it("adds input-wait hints to poll when no new output arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:16.000Z"));
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-poll",
      command: "python prompt.py",
      backgrounded: true,
      startedAt: Date.now() - 16_000,
    });
    installWritableStdin(session);
    addSession(session);

    const result = await runProcessAction(processTool, {
      action: "poll",
      sessionId: "sess-poll",
    });

    expect(textOf(result)).toContain("(no new output)");
    expect(textOf(result)).toContain("may be waiting for input");
    expectRecordFields(result.details, {
      status: "running",
      sessionId: "sess-poll",
      stdinWritable: true,
      waitingForInput: true,
      idleMs: 16_000,
      lastOutputAt: Date.now() - 16_000,
    });
  });

  it("marks idle writable sessions in process list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-list",
      command: "npm run interactive",
      backgrounded: true,
      startedAt: Date.now() - 30_000,
    });
    installWritableStdin(session);
    addSession(session);

    const result = await runProcessAction(processTool, { action: "list" });

    expect(textOf(result)).toContain("sess-list");
    expect(textOf(result)).toContain("[input-wait]");
    const sessions = (result.details as { sessions?: Array<Record<string, unknown>> }).sessions;
    expectRecordFields(sessions?.[0], {
      sessionId: "sess-list",
      stdinWritable: true,
      waitingForInput: true,
      idleMs: 30_000,
    });
  });

  it("adds input-wait metadata and hint text to log", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:25.000Z"));
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-log",
      command: "node prompt.js",
      backgrounded: true,
      startedAt: Date.now() - 25_000,
    });
    installWritableStdin(session);
    appendOutput(session, "stdout", "Password: ");
    addSession(session);

    const result = await runProcessAction(processTool, {
      action: "log",
      sessionId: "sess-log",
    });

    expect(textOf(result)).toContain("Password: ");
    expect(textOf(result)).toContain("No new output for 25s");
    expect(textOf(result)).toContain("Use process write, send-keys, submit, or paste");
    expectRecordFields(result.details, {
      status: "running",
      sessionId: "sess-log",
      stdinWritable: true,
      waitingForInput: true,
      idleMs: 25_000,
    });
  });

  it("does not treat ended stdin as writable input-wait state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-ended",
      command: "node closed-stdin.js",
      backgrounded: true,
      startedAt: Date.now() - 60_000,
    });
    installWritableStdin(session, { writableEnded: true });
    addSession(session);

    const log = await runProcessAction(processTool, {
      action: "log",
      sessionId: "sess-ended",
    });
    expect(textOf(log)).not.toContain("provide input");
    expectRecordFields(log.details, {
      status: "running",
      stdinWritable: false,
      waitingForInput: false,
    });

    const write = await runProcessAction(processTool, {
      action: "write",
      sessionId: "sess-ended",
      data: "answer\n",
    });
    expect(textOf(write)).toContain("stdin is not writable");
    expectRecordFields(write.details, { status: "failed" });
  });

  it("can read finished session logs without exposing input controls", async () => {
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-finished",
      command: "echo done",
      backgrounded: true,
    });
    appendOutput(session, "stdout", "done\n");
    addSession(session);
    markExited(session, 0, null, "completed");

    const result = await runProcessAction(processTool, {
      action: "log",
      sessionId: "sess-finished",
    });

    expect(textOf(result)).toContain("done");
    expect(textOf(result)).not.toContain("provide input");
    expectRecordFields(result.details, {
      status: "completed",
      sessionId: "sess-finished",
      exitCode: 0,
    });
  });
});
