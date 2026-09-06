/**
 * Regression coverage for process input-wait hints.
 * Idle writable sessions should surface actionable metadata and user-facing hints.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import {
  addSession,
  appendOutput,
  markExited,
  type ProcessSession,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
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
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
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
    write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => cb?.(null)),
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
  it("does not close stdin when requester authority is revoked during a pending write", async () => {
    let current = true;
    const controller = new AbortController();
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      isCurrent: () => current,
    });
    const session = createProcessSessionFixture({
      id: "sess-revoked-input",
      command: "cat",
      backgrounded: true,
    });
    const write = vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, done) => {
      current = false;
      done?.(null);
    });
    const end = vi.fn();
    session.stdin = { write, end, destroyed: false };
    addSession(session);
    await expect(
      budget.run(() =>
        runProcessAction(createProcessTool(), {
          action: "write",
          sessionId: session.id,
          data: "allowed input",
          eof: true,
        }),
      ),
    ).rejects.toThrow("execution scope is no longer active");
    expect(write).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });

  it("reports the UTF-8 byte count for process writes", async () => {
    const processTool = createProcessTool();
    const session = createProcessSessionFixture({
      id: "sess-write-bytes",
      command: "cat",
      backgrounded: true,
    });
    installWritableStdin(session);
    addSession(session);
    const result = await runProcessAction(processTool, {
      action: "write",
      sessionId: "sess-write-bytes",
      data: "你好😀",
    });
    expect(textOf(result)).toContain("Wrote 10 bytes to session sess-write-bytes");
  });

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

describe("process session list chronology", () => {
  async function expectProcessListOrder(processTool: ProcessTool, expectedIds: string[]) {
    const result = await runProcessAction(processTool, { action: "list" });
    const records = (result.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(records.map(({ sessionId }) => sessionId)).toEqual(expectedIds);
    expect(
      textOf(result)
        .split("\n")
        .map((line) => line.split(" ")[0]),
    ).toEqual(expectedIds);
    for (const record of records) {
      expect(record).not.toHaveProperty("startOrder");
    }
  }

  it("keeps equal-timestamp text and details newest-first across terminal transitions", async () => {
    const sessions = ["z-oldest", "a-middle", "m-newest"].map((id) => {
      const session = createProcessSessionFixture({
        id,
        startedAt: 1_000,
        backgrounded: true,
      });
      addSession(session);
      return session;
    });
    const processTool = createProcessTool();
    const expectedIds = ["m-newest", "a-middle", "z-oldest"];

    await expectProcessListOrder(processTool, expectedIds);
    markExited(sessions[0]!, 0, null, "completed");
    await expectProcessListOrder(processTool, expectedIds);
    markExited(sessions[2]!, 0, null, "completed");
    await expectProcessListOrder(processTool, expectedIds);
    markExited(sessions[1]!, 0, null, "completed");
    await expectProcessListOrder(processTool, expectedIds);
  });

  it("keeps actual start timestamps ahead of registration chronology", async () => {
    for (const [id, startedAt] of [
      ["middle-clock", 2_000],
      ["later-clock", 3_000],
      ["earlier-clock", 1_000],
    ] as const) {
      addSession(createProcessSessionFixture({ id, startedAt, backgrounded: true }));
    }

    await expectProcessListOrder(createProcessTool(), [
      "later-clock",
      "middle-clock",
      "earlier-clock",
    ]);
  });
});
