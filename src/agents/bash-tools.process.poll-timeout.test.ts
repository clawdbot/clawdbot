/**
 * Regression coverage for process poll timeout and retry hints.
 * Poll waits, aborts, and diagnostic retry suggestions must stay bounded.
 */
import { afterEach, expect, test, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  getFinishedSession,
  markExited,
  recordNotifyOnExitRemoval,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { processSchema } from "./bash-tools.schemas.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";

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

test.each([
  { name: "buffered stdout", stream: "stdout", arrivesDuringWait: false, dropped: false },
  { name: "buffered stderr", stream: "stderr", arrivesDuringWait: false, dropped: false },
  { name: "new stdout", stream: "stdout", arrivesDuringWait: true, dropped: false },
  { name: "new stderr", stream: "stderr", arrivesDuringWait: true, dropped: false },
  { name: "buffered capped output", stream: "stdout", arrivesDuringWait: false, dropped: true },
] as const)(
  "process poll returns $name before the requested wait expires",
  async ({ name, stream, arrivesDuringWait, dropped }) => {
    vi.useFakeTimers();
    const sessionId = `sess-prompt-${name.replaceAll(" ", "-")}`;
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const controller = new AbortController();
    const appendPendingOutput = () => {
      if (dropped) {
        appendOversizedPendingOutput(session);
      } else {
        appendOutput(session, stream, "interactive prompt\n");
      }
    };
    if (arrivesDuringWait) {
      setTimeout(appendPendingOutput, 10);
    } else {
      appendPendingOutput();
    }

    let settled = false;
    const observedPoll = pollSession(
      processTool,
      "toolcall-prompt",
      sessionId,
      30_000,
      controller.signal,
    ).then(
      (result) => {
        settled = true;
        return result;
      },
      () => undefined,
    );

    try {
      await vi.advanceTimersByTimeAsync(arrivesDuringWait ? 250 : 0);
      expect(settled).toBe(true);

      const poll = await observedPoll;
      expect(poll?.details).toMatchObject({ status: "running", sessionId });
      expect(poll?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(
          dropped ? "earlier output is omitted from this poll" : "interactive prompt",
        ),
      });
      expect(session.pendingOutput).toHaveLength(0);
    } finally {
      controller.abort();
      await observedPoll;
      vi.useRealTimers();
    }
  },
);

test("process poll rejects an already-aborted signal without consuming buffered output", async () => {
  const sessionId = "sess-prompt-already-aborted";
  const { processTool, session } = createProcessSessionHarness(sessionId);
  appendOutput(session, "stdout", "interactive prompt\n");
  const controller = new AbortController();
  controller.abort();

  await expect(
    pollSession(processTool, "toolcall-prompt-aborted", sessionId, 30_000, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(session.pendingOutput).toEqual([{ stream: "stdout", text: "interactive prompt\n" }]);
});

test("waiting poll returns only output appended since the previous poll", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-incremental-terminal-output";
    const { processTool, session } = createProcessSessionHarness(sessionId);

    appendOutput(session, "stdout", "already-observed\n");
    const firstPoll = await pollSession(processTool, "toolcall-first", sessionId);
    expect(firstPoll.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("already-observed"),
    });

    const pollPromise = pollSession(processTool, "toolcall-terminal", sessionId, 2_000);
    setTimeout(() => {
      appendOutput(session, "stdout", "new-terminal-output\n");
      markExited(session, 0, null, "completed");
    }, 10);

    await vi.advanceTimersByTimeAsync(250);
    const terminalPoll = await pollPromise;
    const terminalText =
      terminalPoll.content[0]?.type === "text" ? terminalPoll.content[0].text : "";
    const details = terminalPoll.details as { status?: string; aggregated?: string };

    expect(details.status).toBe("completed");
    expect(details.aggregated).toContain("already-observed");
    expect(details.aggregated).toContain("new-terminal-output");
    expect(terminalText).toContain("new-terminal-output");
    expect(terminalText).not.toContain("already-observed");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll preserves callback chronology across running and terminal drains", async () => {
  const sessionId = "sess-interleaved-stream-order";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  appendOutput(session, "stderr", "ERR-before\n");
  appendOutput(session, "stdout", "OUT-after\n");

  const runningPoll = await pollSession(processTool, "toolcall-interleaved-running", sessionId);
  const runningText = runningPoll.content[0]?.type === "text" ? runningPoll.content[0].text : "";
  expect(runningText).toContain("ERR-before\nOUT-after");
  expect(runningText.indexOf("ERR-before")).toBeLessThan(runningText.indexOf("OUT-after"));
  expect(runningPoll.details).toMatchObject({
    status: "running",
    aggregated: "ERR-before\nOUT-after\n",
  });

  appendOutput(session, "stderr", "ERR-last\n");
  markExited(session, 0, null, "completed");

  const terminalPoll = await pollSession(processTool, "toolcall-interleaved-terminal", sessionId);
  const terminalText = terminalPoll.content[0]?.type === "text" ? terminalPoll.content[0].text : "";
  expect(terminalText).toContain("ERR-last");
  expect(terminalText).not.toContain("ERR-before");
  expect(terminalText).not.toContain("OUT-after");
  expect(terminalPoll.details).toMatchObject({
    status: "completed",
    aggregated: "ERR-before\nOUT-after\nERR-last\n",
  });
});

test("waiting poll retains terminal state and its receipt after indexed cleanup", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-cleared-while-waiting";
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const remove = vi.fn(() => true);

    setTimeout(() => {
      appendOutput(session, "stdout", "done after cleanup\n");
      markExited(session, 0, null, "completed");
      recordNotifyOnExitRemoval(session, remove);
      deleteSession(sessionId);
    }, 10);

    const pollPromise = pollSession(processTool, "toolcall-cleanup", sessionId, 2_000);
    await vi.advanceTimersByTimeAsync(250);
    const poll = await pollPromise;

    expect(poll.details).toMatchObject({
      status: "completed",
      aggregated: expect.stringContaining("done after cleanup"),
    });
    expect(poll.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("done after cleanup"),
    });
    expect(remove).not.toHaveBeenCalled();
    acknowledgeInternalToolResult(poll);
    expect(remove).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("waiting poll does not adopt a same-id successor after removal", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-reused-while-waiting";
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const successorRemove = vi.fn(() => true);

    setTimeout(() => {
      session.backgrounded = false;
      deleteSession(sessionId);
      markExited(session, 0, null, "completed");

      const successor = createProcessSessionFixture({
        id: sessionId,
        command: "successor",
        backgrounded: true,
      });
      addSession(successor);
      appendOutput(successor, "stdout", "successor output\n");
      markExited(successor, 0, null, "completed");
      recordNotifyOnExitRemoval(successor, successorRemove);
    }, 10);

    const originalPoll = pollSession(processTool, "toolcall-original", sessionId, 2_000);
    await vi.advanceTimersByTimeAsync(250);
    const removed = await originalPoll;

    expect(removed.details).toMatchObject({ status: "failed" });
    expect(removed.content[0]).toMatchObject({
      type: "text",
      text: `No session found for ${sessionId}`,
    });
    expect(successorRemove).not.toHaveBeenCalled();

    const successorPoll = await pollSession(processTool, "toolcall-successor", sessionId);
    expect(successorPoll.details).toMatchObject({
      status: "completed",
      aggregated: expect.stringContaining("successor output"),
    });
    expect(successorRemove).not.toHaveBeenCalled();
    acknowledgeInternalToolResult(successorPoll);
    expect(successorRemove).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("waiting poll never recommends successor logs for omitted original output", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = "sess-reused-after-omitted-output";
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const originalRemove = vi.fn(() => true);
    const successorRemove = vi.fn(() => true);
    let expected: ReturnType<typeof appendOversizedPendingOutput> | undefined;

    setTimeout(() => {
      expected = appendOversizedPendingOutput(session);
      markExited(session, 0, null, "completed");
      recordNotifyOnExitRemoval(session, originalRemove);
      deleteSession(sessionId);

      const successor = createProcessSessionFixture({
        id: sessionId,
        command: "successor",
        backgrounded: true,
      });
      addSession(successor);
      appendOutput(successor, "stdout", "successor output\n");
      markExited(successor, 7, null, "completed");
      recordNotifyOnExitRemoval(successor, successorRemove);
    }, 10);

    const originalPoll = pollSession(processTool, "toolcall-original-omitted", sessionId, 2_000);
    await vi.advanceTimersByTimeAsync(250);
    const original = await originalPoll;
    if (!expected) {
      throw new Error("expected pending output to be appended");
    }
    const originalText = original.content[0]?.type === "text" ? original.content[0].text : "";

    expect(original.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: expected.aggregated,
    });
    expect(originalText).not.toContain(expected.earlierMarker);
    expect(originalText).toContain(expected.latestMarker);
    expect(originalText).not.toContain("successor output");
    expect(originalText).not.toContain("use action=log");
    expect(originalText).toContain("omitted output is no longer available through action=log");
    expect(originalRemove).not.toHaveBeenCalled();
    acknowledgeInternalToolResult(original);
    expect(originalRemove).toHaveBeenCalledOnce();
    expect(successorRemove).not.toHaveBeenCalled();

    const successorLog = await processTool.execute("toolcall-successor-log", {
      action: "log",
      sessionId,
    });
    expect(successorLog.details).toMatchObject({ status: "completed", exitCode: 7 });
    expect(successorLog.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("successor output"),
    });
    expect(successorRemove).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  { name: "waiting", exitBeforePoll: false },
  { name: "already-finished", exitBeforePoll: true },
])("$name terminal polls do not replay drained output", async ({ exitBeforePoll }) => {
  vi.useFakeTimers();
  try {
    const sessionId = `sess-no-replay-${exitBeforePoll ? "finished" : "waiting"}`;
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const finish = () => {
      appendOutput(session, "stdout", "only once\n");
      markExited(session, 0, null, "completed");
    };
    if (exitBeforePoll) {
      finish();
    } else {
      setTimeout(finish, 10);
    }

    const firstPromise = pollSession(
      processTool,
      "toolcall-first-terminal",
      sessionId,
      exitBeforePoll ? undefined : 2_000,
    );
    await vi.advanceTimersByTimeAsync(250);
    const first = await firstPromise;
    const second = await pollSession(processTool, "toolcall-second-terminal", sessionId);
    const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
    const secondText = second.content[0]?.type === "text" ? second.content[0].text : "";

    expect(firstText).toContain("only once");
    expect(secondText).not.toContain("only once");
    expect(secondText).toContain("no new output");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll accepts string timeout values", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess-2",
    callId: "toolcall",
    timeout: "2000",
    advanceMs: 350,
  });
});

test("terminal polls compact tiny stream chunks and never reopen frozen output", async () => {
  const sessionId = "sess-compact-terminal";
  const { processTool, session } = createProcessSessionHarness(sessionId);
  session.maxOutputChars = 3_000;
  session.pendingMaxOutputChars = 1_000;
  for (let index = 0; index < 2_000; index += 1) {
    appendOutput(session, "stdout", "o");
    appendOutput(session, "stderr", "e");
  }
  markExited(session, 0, null, "completed");

  // Retention must release thousands of chunk objects, not just cap their text.
  expect(session.pendingOutput).toBe("oe".repeat(1_000));
  expect(session.pendingStdoutChars).toBe(0);
  expect(session.pendingStderrChars).toBe(0);
  const terminal = await pollSession(processTool, "compact-first", sessionId);
  expect(terminal.content[0]).toMatchObject({
    text:
      "[earlier output was discarded at the retention cap and cannot be recovered]\n\n" +
      "[earlier output is omitted from this poll; use action=log with offset and limit to inspect retained output]\n\n" +
      "oe".repeat(1_000) +
      "\n\nProcess exited with code 0.",
  });
  appendOutput(session, "stderr", "late".repeat(1_000));
  const repeated = await pollSession(processTool, "compact-second", sessionId);
  expect(repeated.content[0]).toMatchObject({
    text: "[earlier output was discarded at the retention cap and cannot be recovered]\n\n(no new output)\n\nProcess exited with code 0.",
  });
  expect(session.totalOutputChars).toBe(4_000);
  expect(session.pendingOutput).toBe("");
  expect(session.pendingOutputDropped).toBe(false);
  const log = await processTool.execute("compact-log", { action: "log", sessionId });
  expect(log.content[0]).toMatchObject({
    text:
      "[earlier output was discarded at the retention cap and cannot be recovered]\n\n" +
      "oe".repeat(1_500),
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
      expect(getFinishedSession(sessionId)?.terminalStatus).toBe(ownerStatus);

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
  { name: "above the retained tail", outputLength: 2_001, expectsOmissionNote: false },
])(
  "process poll returns unread finished output $name",
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
    expect(text).not.toContain(latestMarker);
    expect(text).toContain("no new output");
    expect(text).toContain("discarded at the retention cap and cannot be recovered");
    expect(runningLogText).toContain("discarded at the retention cap and cannot be recovered");
    expect(runningPollText).toContain("discarded at the retention cap and cannot be recovered");
    expect(finishedLogText).toContain("discarded at the retention cap and cannot be recovered");
    for (const resultText of [text, runningLogText, runningPollText, finishedLogText]) {
      expect(resultText).toMatch(
        /^\[earlier output was discarded at the retention cap and cannot be recovered\]/,
      );
    }
    expect(text).not.toContain("action=log with offset and limit");
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

test.each([
  {
    name: "overall timeout after a zero exit",
    exitCode: 0,
    exitSignal: null,
    status: "failed",
    exitReason: "overall-timeout",
    noOutputTimedOut: false,
    timedOut: true,
  },
  {
    name: "no-output timeout",
    exitCode: null,
    exitSignal: "SIGKILL",
    status: "failed",
    exitReason: "no-output-timeout",
    noOutputTimedOut: true,
    timedOut: true,
  },
  {
    name: "nonzero exit",
    exitCode: 7,
    exitSignal: null,
    status: "completed",
    exitReason: "exit",
    timedOut: false,
  },
  {
    name: "successful exit",
    exitCode: 0,
    exitSignal: null,
    status: "completed",
    exitReason: "exit",
    timedOut: false,
  },
  {
    name: "manual cancellation",
    exitCode: null,
    exitSignal: "SIGTERM",
    status: "failed",
    exitReason: "manual-cancel",
    timedOut: false,
  },
] as const)(
  "process list, log, and poll preserve authoritative $name without consuming the completion",
  async ({ name, exitCode, exitSignal, status, exitReason, timedOut, ...optional }) => {
    const sessionId = `sess-terminal-${name.replaceAll(" ", "-")}`;
    const { processTool, session } = createProcessSessionHarness(sessionId);
    const remove = vi.fn(() => true);

    appendOutput(session, "stderr", "terminal output\n");
    markExited(session, exitCode, exitSignal, status, exitReason, optional.noOutputTimedOut);
    recordNotifyOnExitRemoval(session, remove);

    const list = await processTool.execute("toolcall-terminal-list", { action: "list" });
    const listedSessions = (list.details as { sessions?: Array<{ sessionId?: string }> }).sessions;
    const listed = listedSessions?.find((candidate) => candidate.sessionId === sessionId);
    expect(listed).toMatchObject({
      status,
      sessionId,
      exitCode: exitCode ?? undefined,
      exitReason,
      timedOut,
      ...optional,
    });
    const listText = list.content[0]?.type === "text" ? list.content[0].text : "";
    expect(listText).toContain(sessionId);
    expect(listText.includes(`[${exitReason}]`)).toBe(timedOut);
    expect(remove).not.toHaveBeenCalled();

    const log = await processTool.execute("toolcall-terminal-log", {
      action: "log",
      sessionId,
    });
    expect(log.details).toMatchObject({
      status,
      sessionId,
      exitCode: exitCode ?? undefined,
      exitReason,
      timedOut,
      ...optional,
    });
    const logText = log.content[0]?.type === "text" ? log.content[0].text : "";
    expect(logText).toContain("terminal output");
    expect(logText.includes("Verify the resulting state before retrying")).toBe(timedOut);
    expect(remove).not.toHaveBeenCalled();

    const poll = await pollSession(processTool, "toolcall-terminal-poll", sessionId);
    expect(poll.details).toMatchObject({
      status,
      sessionId,
      exitCode: exitCode ?? undefined,
      exitReason,
      timedOut,
      aggregated: "terminal output\n",
      ...optional,
    });
    const pollText = poll.content[0]?.type === "text" ? poll.content[0].text : "";
    expect(pollText).toContain("terminal output");
    expect(pollText.includes("Verify the resulting state before retrying")).toBe(timedOut);
    expect(remove).not.toHaveBeenCalled();
    acknowledgeInternalToolResult(poll);
    expect(remove).toHaveBeenCalledOnce();
  },
);
