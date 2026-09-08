import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { waitForAgentJob } from "./agent-job.js";

let runSequence = 0;

describe("waitForAgentJob settled execution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    {
      label: "preflight failure",
      phase: "error",
      result: new AgentHarnessPreflightError("execution preparation failed"),
      termination: {},
      expected: { status: "error", error: "execution preparation failed" },
    },
    {
      label: "explicit cancellation",
      phase: "error",
      result: new Error("execution cancelled"),
      termination: { aborted: true, stopReason: "rpc" },
      expected: { status: "error", stopReason: "rpc" },
    },
    {
      label: "bare abort from a settled backend",
      phase: "end",
      result: { meta: { aborted: true } },
      termination: {},
      expected: { status: "error", stopReason: "aborted" },
    },
    {
      label: "provider timeout",
      phase: "end",
      result: {
        meta: {
          aborted: true,
          stopReason: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      },
      termination: {},
      expected: { status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
    },
    {
      label: "yielded execution",
      phase: "end",
      result: { meta: { yielded: true } },
      termination: {},
      expected: { status: "ok", yielded: true },
    },
  ] as const)(
    "publishes $label without retry grace",
    async ({ phase, result, termination, expected }) => {
      const runId = `settled-execution-${runSequence++}`;
      const waiter = waitForAgentJob({ runId, timeoutMs: 60_000 });
      const lifecycle = createAgentLifecycleTerminalBackstop({
        runId,
        startedAt: 1_000,
        getLifecycleGeneration: getAgentEventLifecycleGeneration,
        resolveTerminationFields: () => termination,
      });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1_000 } });
      try {
        lifecycle.capture(phase, result);
        await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
        lifecycle.emit(phase, result);
        // Assert before advancing clocks: an active waiter and a new reader must
        // observe the producer's final result, not its eventual deadline fallback.
        await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(expected);
        await expect(waiter).resolves.toMatchObject(expected);
      } finally {
        await vi.advanceTimersByTimeAsync(60_000);
        await waiter;
      }
    },
  );
});
