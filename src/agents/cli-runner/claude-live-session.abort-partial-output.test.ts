/** Claude live session: aborted turns must surface already-streamed assistant text. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { buildClaudeLiveRunContext, mockClaudeLiveRun } from "../cli-runner.test-helpers.js";
import { supervisorSpawnMock } from "../cli-runner.test-support.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

beforeEach(() => {
  resetClaudeLiveSessionsForTest();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetClaudeLiveSessionsForTest();
});

function getProcessSupervisorForTest() {
  return {
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  };
}

function startLiveTurnWithAbortSignal(runId: string, signal: AbortSignal) {
  const context = buildClaudeLiveRunContext({ runId, timeoutMs: 60_000 });
  context.params.abortSignal = signal;
  return runClaudeTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume: false,
    noOutputTimeoutMs: 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    cleanup: async () => {},
  });
}

describe("claude live session aborted-turn partial output", () => {
  it.each([
    {
      name: "AbortError",
      reason: "aborted",
      abort: (controller: AbortController) => controller.abort(),
    },
    {
      name: "externally supplied TimeoutError",
      reason: "timeout",
      abort: (controller: AbortController) => {
        const error = new Error("caller deadline exceeded");
        error.name = "TimeoutError";
        controller.abort(error);
      },
    },
    {
      name: "AbortError wrapping a TimeoutError (an abort, not a deadline)",
      reason: "aborted",
      abort: (controller: AbortController) => {
        const timeout = new Error("caller deadline exceeded");
        timeout.name = "TimeoutError";
        const error = new Error("caller cancelled", { cause: timeout });
        error.name = "AbortError";
        controller.abort(error);
      },
    },
  ])("resolves streamed assistant text for $name", async ({ abort, reason }) => {
    const controller = new AbortController();
    let textEmitted = false;
    const fixture = mockClaudeLiveRun(supervisorSpawnMock, {
      cancelable: true,
      onWrite: ({ emit }) => {
        emit([
          { type: "system", subtype: "init", session_id: "live-abort-partial" },
          {
            type: "stream_event",
            session_id: "live-abort-partial",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Here is the answer so far" },
            },
          },
        ]);
        textEmitted = true;
      },
    });

    const turnPromise = startLiveTurnWithAbortSignal("run-abort-partial", controller.signal);
    await vi.waitFor(() => {
      expect(textEmitted).toBe(true);
    });
    abort(controller);

    await expect(turnPromise).resolves.toMatchObject({
      output: {
        text: expect.stringContaining("Here is the answer so far"),
        terminalInterruption: { reason },
      },
    });
    expect(fixture.lifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("still rejects genuine CLI failures after streamed text instead of masking them", async () => {
    const controller = new AbortController();
    mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ emit }) => {
        emit([
          { type: "system", subtype: "init", session_id: "live-abort-failover" },
          {
            type: "assistant",
            session_id: "live-abort-failover",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Partial answer before failure" }],
            },
          },
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            session_id: "live-abort-failover",
            result: "tool failed",
          },
        ]);
      },
    });

    const turnPromise = startLiveTurnWithAbortSignal("run-abort-failover", controller.signal);
    await expect(turnPromise).rejects.toMatchObject({ name: "FailoverError" });
    expect(controller.signal.aborted).toBe(false);
  });

  it("still rejects an abort when no assistant text was streamed yet", async () => {
    const controller = new AbortController();
    mockClaudeLiveRun(supervisorSpawnMock, {
      cancelable: true,
      onWrite: ({ emit }) => {
        emit([{ type: "system", subtype: "init", session_id: "live-abort-empty" }]);
      },
    });

    const turnPromise = startLiveTurnWithAbortSignal("run-abort-empty", controller.signal);
    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(turnPromise).rejects.toMatchObject({ name: "AbortError" });
  });
});
