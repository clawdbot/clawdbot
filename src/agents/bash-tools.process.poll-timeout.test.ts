/**
 * Regression coverage for process poll timeout and retry hints.
 * Poll waits, aborts, and diagnostic retry suggestions must stay bounded.
 */
import { afterEach, expect, test, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  getFinishedSession,
  markExited,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { processSchema } from "./bash-tools.schemas.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
});

function createProcessSessionHarness(sessionId: string) {
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: "test",
    backgrounded: true,
  });
  addSession(session);
  return { processTool, session };
}

function appendOversizedPendingOutput(session: ReturnType<typeof createProcessSessionFixture>) {
  const earlierMarker = "[earlier-pending-output]";
  const latestMarker = "[latest-pending-output]";
  const pendingCap = session.pendingMaxOutputChars ?? 30_000;
  const aggregated = `${earlierMarker}${"x".repeat(pendingCap)}${latestMarker}`;
  session.maxOutputChars = aggregated.length;
  appendOutput(session, "stdout", aggregated);
  return { aggregated, earlierMarker, latestMarker };
}

async function pollSession(
  processTool: ReturnType<typeof createProcessTool>,
  callId: string,
  sessionId: string,
  timeout?: number | string,
  signal?: AbortSignal,
) {
  const args = {
    action: "poll",
    sessionId,
    ...(timeout === undefined ? {} : { timeout }),
  } as unknown as Parameters<ReturnType<typeof createProcessTool>["execute"]>[1];
  return processTool.execute(callId, args, signal);
}

function retryMs(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { retryInMs?: number }).retryInMs;
}

function pollStatus(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { status?: string }).status;
}

async function expectCompletedPollWithTimeout(params: {
  sessionId: string;
  callId: string;
  timeout: number | string;
  advanceMs: number;
  assertUnresolvedAtMs?: number;
}) {
  vi.useFakeTimers();
  try {
    const { processTool, session } = createProcessSessionHarness(params.sessionId);

    setTimeout(() => {
      appendOutput(session, "stdout", "done\n");
      markExited(session, 0, null, "completed");
    }, 10);

    const pollPromise = pollSession(processTool, params.callId, params.sessionId, params.timeout);
    if (params.assertUnresolvedAtMs !== undefined) {
      let resolved = false;
      void pollPromise.finally(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(params.assertUnresolvedAtMs);
      expect(resolved).toBe(false);
    }

    await vi.advanceTimersByTimeAsync(params.advanceMs);
    const poll = await pollPromise;
    const details = poll.details as { status?: string; aggregated?: string };
    expect(details.status).toBe("completed");
    expect(details.aggregated ?? "").toContain("done");
  } finally {
    vi.useRealTimers();
  }
}

test("process poll waits for completion when timeout is provided", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess",
    callId: "toolcall",
    timeout: 2000,
    assertUnresolvedAtMs: 200,
    advanceMs: 100,
  });
});

test("process poll accepts string timeout values", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess-2",
    callId: "toolcall",
    timeout: "2000",
    advanceMs: 350,
  });
});

test("process poll warns when the session times out while poll is waiting", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-timeout-while-polling";
    const { processTool, session } = createProcessSessionHarness(sessionId);

    setTimeout(() => {
      markExited(session, null, "SIGKILL", "failed", "overall-timeout", false);
    }, 10);

    const pollPromise = pollSession(processTool, "toolcall", sessionId, 2000);
    await vi.advanceTimersByTimeAsync(250);
    const poll = await pollPromise;

    expect(pollStatus(poll)).toBe("failed");
    expect(poll.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Verify the resulting state before retrying"),
    });
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  {
    name: "successful zero exit",
    exitCode: 0,
    exitSignal: null,
    ownerStatus: "completed",
    exitReason: undefined,
    expectedExit: "code 0",
  },
  {
    name: "successful nonzero exit",
    exitCode: 7,
    exitSignal: null,
    ownerStatus: "completed",
    exitReason: undefined,
    expectedExit: "code 7",
  },
  {
    name: "runtime failure without an exit code",
    exitCode: null,
    exitSignal: null,
    ownerStatus: "failed",
    exitReason: undefined,
    expectedExit: "unknown exit code",
  },
  {
    name: "timeout after a clean child exit",
    exitCode: 0,
    exitSignal: null,
    ownerStatus: "failed",
    exitReason: "overall-timeout",
    expectedExit: "code 0",
  },
  {
    name: "signal failure without an exit code",
    exitCode: null,
    exitSignal: "SIGKILL",
    ownerStatus: "failed",
    exitReason: "manual-cancel",
    expectedExit: "signal SIGKILL",
  },
] as const)(
  "preserves the lifecycle owner's $name when completion races a process poll",
  async ({ name, exitCode, exitSignal, ownerStatus, exitReason, expectedExit }) => {
    vi.useFakeTimers();
    try {
      const sessionId = `sess-terminal-${name.replaceAll(" ", "-")}`;
      const { processTool, session } = createProcessSessionHarness(sessionId);

      setTimeout(() => {
        markExited(session, exitCode, exitSignal, ownerStatus, exitReason);
      }, 10);

      const pendingPoll = pollSession(processTool, "toolcall-terminal-race", sessionId, 1_000);
      await vi.advanceTimersByTimeAsync(250);
      const racedPoll = await pendingPoll;
      const racedDetails = racedPoll.details as { status?: string; exitCode?: number };

      expect(racedDetails.status).toBe(ownerStatus);
      expect(racedDetails.exitCode).toBe(exitCode ?? undefined);
      expect(racedPoll.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(`Process exited with ${expectedExit}.`),
      });
      expect(getFinishedSession(sessionId)?.status).toBe(ownerStatus);

      const retainedPoll = await pollSession(processTool, "toolcall-terminal-retained", sessionId);
      expect(retainedPoll.details).toMatchObject({ status: ownerStatus });
      expect(retainedPoll.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(`Process exited with ${expectedExit}.`),
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

test("process poll clamps long waits to 30 seconds", async () => {
  vi.useFakeTimers();
  try {
    const { processTool } = createProcessSessionHarness("sess-clamp");

    const pollPromise = pollSession(processTool, "toolcall", "sess-clamp", 120_000);
    let resolved = false;
    void pollPromise.finally(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const poll = await pollPromise;
    expect(pollStatus(poll)).toBe("running");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll schema advertises the 30 second wait cap", () => {
  const timeoutSchema = processSchema.properties.timeout;
  expect((timeoutSchema as { description?: string }).description).toContain("max 30000 ms");
});

test("process poll aborts while waiting for completion", async () => {
  vi.useFakeTimers();
  try {
    const { processTool } = createProcessSessionHarness("sess-abort");
    const controller = new AbortController();

    const pollPromise = pollSession(
      processTool,
      "toolcall",
      "sess-abort",
      30_000,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();

    let err: unknown;
    try {
      await pollPromise;
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll exposes adaptive retryInMs for repeated no-output polls", async () => {
  const sessionId = "sess-retry";
  const { processTool } = createProcessSessionHarness(sessionId);

  const polls = await Promise.all([
    pollSession(processTool, "toolcall-1", sessionId),
    pollSession(processTool, "toolcall-2", sessionId),
    pollSession(processTool, "toolcall-3", sessionId),
    pollSession(processTool, "toolcall-4", sessionId),
    pollSession(processTool, "toolcall-5", sessionId),
  ]);

  expect(polls.map((poll) => retryMs(poll))).toEqual([5000, 10000, 30000, 60000, 60000]);
});

test("process poll resets retryInMs when output appears and clears on completion", async () => {
  const sessionId = "sess-reset";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  const poll1 = await pollSession(processTool, "toolcall-1", sessionId);
  const poll2 = await pollSession(processTool, "toolcall-2", sessionId);
  expect(retryMs(poll1)).toBe(5000);
  expect(retryMs(poll2)).toBe(10000);

  appendOutput(session, "stdout", "step complete\n");
  const pollWithOutput = await pollSession(processTool, "toolcall-output", sessionId);
  expect(retryMs(pollWithOutput)).toBe(5000);

  markExited(session, 0, null, "completed");
  const pollCompleted = await pollSession(processTool, "toolcall-completed", sessionId);
  expect(pollStatus(pollCompleted)).toBe("completed");
  expect(retryMs(pollCompleted)).toBeUndefined();

  const pollFinished = await pollSession(processTool, "toolcall-finished", sessionId);
  expect(pollStatus(pollFinished)).toBe("completed");
  expect(retryMs(pollFinished)).toBeUndefined();
});

test.each([
  { name: "below the retained tail", outputLength: 1_999, expectsOmissionNote: false },
  { name: "at the retained tail", outputLength: 2_000, expectsOmissionNote: false },
  { name: "above the retained tail", outputLength: 2_001, expectsOmissionNote: true },
])(
  "process poll discloses omitted finished output $name",
  async ({ outputLength, expectsOmissionNote }) => {
    const sessionId = `sess-finished-tail-${outputLength}`;
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const earlierMarker = "[earlier-output]";
    const latestMarker = "[latest-output]";
    const fillerLength = outputLength - earlierMarker.length - latestMarker.length;
    const aggregated = `${earlierMarker}${"x".repeat(fillerLength)}${latestMarker}`;

    appendOutput(session, "stdout", aggregated);
    markExited(session, 0, null, "completed");

    const poll = await pollSession(processTool, "toolcall-finished-tail", sessionId);
    const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";
    const details = poll.details as { aggregated?: string };

    expect(aggregated).toHaveLength(outputLength);
    expect(details.aggregated).toBe(aggregated);
    expect(text).toContain(latestMarker);
    if (expectsOmissionNote) {
      expect(text).not.toContain(earlierMarker);
      expect(text).toContain("earlier retained output is omitted");
      expect(text).toContain("action=log with offset and limit");
    } else {
      expect(text).toContain(earlierMarker);
      expect(text).not.toContain("earlier retained output is omitted");
    }
    expect(text).not.toContain("discarded at the retention cap");
  },
);

test.each([
  { name: "below the retained tail", outputLength: 1_500, aggregateCap: 1_000 },
  { name: "above the retained tail", outputLength: 3_500, aggregateCap: 3_000 },
])(
  "process poll distinguishes discarded aggregate output $name",
  async ({ outputLength, aggregateCap }) => {
    const sessionId = `sess-aggregate-cap-${aggregateCap}`;
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const earlierMarker = "[discarded-output]";
    const latestMarker = "[latest-retained-output]";
    const output = `${earlierMarker}${"x".repeat(
      outputLength - earlierMarker.length - latestMarker.length,
    )}${latestMarker}`;
    session.maxOutputChars = aggregateCap;

    appendOutput(session, "stdout", output);
    const runningLog = await processTool.execute("toolcall-running-aggregate-cap", {
      action: "log",
      sessionId,
    });
    const runningPoll = await pollSession(processTool, "toolcall-running-aggregate-cap", sessionId);
    markExited(session, 0, null, "completed");

    const poll = await pollSession(processTool, "toolcall-aggregate-cap", sessionId);
    const finishedLog = await processTool.execute("toolcall-finished-aggregate-cap", {
      action: "log",
      sessionId,
    });
    const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";
    const runningLogText = runningLog.content[0]?.type === "text" ? runningLog.content[0].text : "";
    const runningPollText =
      runningPoll.content[0]?.type === "text" ? runningPoll.content[0].text : "";
    const finishedLogText =
      finishedLog.content[0]?.type === "text" ? finishedLog.content[0].text : "";
    const details = poll.details as { aggregated?: string };

    expect(details.aggregated).toHaveLength(aggregateCap);
    expect(text).not.toContain(earlierMarker);
    expect(text).toContain(latestMarker);
    expect(text).toContain("discarded at the retention cap and cannot be recovered");
    expect(runningLogText).toContain("discarded at the retention cap and cannot be recovered");
    expect(runningPollText).toContain("discarded at the retention cap and cannot be recovered");
    expect(finishedLogText).toContain("discarded at the retention cap and cannot be recovered");
    if (aggregateCap > 2_000) {
      expect(text).toContain("earlier retained output is omitted");
      expect(text).toContain("action=log with offset and limit");
    } else {
      expect(text).not.toContain("action=log with offset and limit");
    }
  },
);

test.each([
  { name: "while running", exitsDuringPoll: false },
  { name: "when the process exits during the poll", exitsDuringPoll: true },
])("process poll discloses omitted pending output $name", async ({ exitsDuringPoll }) => {
  vi.useFakeTimers();
  try {
    const sessionId = `sess-pending-cap-${exitsDuringPoll ? "exit" : "running"}`;
    const { processTool, session } = createProcessSessionHarness(sessionId);
    let expected: ReturnType<typeof appendOversizedPendingOutput> | undefined;
    let pollPromise: ReturnType<typeof pollSession>;

    if (exitsDuringPoll) {
      setTimeout(() => {
        expected = appendOversizedPendingOutput(session);
        markExited(session, 0, null, "completed");
      }, 10);
      pollPromise = pollSession(processTool, "toolcall-pending-cap", sessionId, 1_000);
      await vi.advanceTimersByTimeAsync(250);
    } else {
      expected = appendOversizedPendingOutput(session);
      pollPromise = pollSession(processTool, "toolcall-pending-cap", sessionId);
    }

    const poll = await pollPromise;
    if (!expected) {
      throw new Error("expected pending output to be appended");
    }
    const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";
    const details = poll.details as { aggregated?: string; status?: string };

    expect(details.status).toBe(exitsDuringPoll ? "completed" : "running");
    expect(details.aggregated).toBe(expected.aggregated);
    expect(text).not.toContain(expected.earlierMarker);
    expect(text).toContain(expected.latestMarker);
    expect(text).toContain("earlier output is omitted from this poll");
    expect(text).toContain("action=log with offset and limit");

    if (!exitsDuringPoll) {
      const nextPoll = await pollSession(processTool, "toolcall-after-pending-cap", sessionId);
      const nextText = nextPoll.content[0]?.type === "text" ? nextPoll.content[0].text : "";
      expect(nextText).not.toContain("earlier output is omitted from this poll");
    }
  } finally {
    vi.useRealTimers();
  }
});

test("process poll exposes finished-session termination metadata", async () => {
  const sessionId = "sess-signal";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  appendOutput(session, "stderr", "terminated\n");
  markExited(session, null, "SIGKILL", "failed", "no-output-timeout", true);

  const poll = await pollSession(processTool, "toolcall-signal", sessionId);
  const details = poll.details as {
    status?: string;
    exitCode?: number | null;
    exitSignal?: NodeJS.Signals | number | null;
    exitReason?: string;
    timedOut?: boolean;
    noOutputTimedOut?: boolean;
    aggregated?: string;
  };

  expect(details.status).toBe("failed");
  expect(details.exitCode).toBeUndefined();
  expect(details.exitSignal).toBe("SIGKILL");
  expect(details.exitReason).toBe("no-output-timeout");
  expect(details.timedOut).toBe(true);
  expect(details.noOutputTimedOut).toBe(true);
  expect(details.aggregated).toContain("terminated");
  expect(poll.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("external side effects may already have completed"),
  });
  expect(poll.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Verify the resulting state before retrying"),
  });
  expect(poll.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Do not automatically rerun non-idempotent commands"),
  });
});
