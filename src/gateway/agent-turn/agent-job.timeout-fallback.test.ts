// Focused wait-layer coverage for the outer-timer race behind #89095.
// Parent announce delivery is a separate contract and remains outside this test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../../agents/run-termination.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { waitForAgentJob } from "./agent-job.js";

const HARD_TIMEOUT_PHASES = ["preflight", "provider", "post_turn"] as const;
const NON_HARD_TIMEOUTS = [
  {
    label: "soft queue timeout",
    data: { timeoutPhase: "queue" },
  },
] as const;

let runSequence = 0;

async function resolveOuterTimeoutRace(
  data: Readonly<Record<string, unknown>>,
  options?: { ignoreCachedSnapshot?: boolean },
) {
  const runId = `run-timeout-fallback-${runSequence++}`;
  const waitPromise = waitForAgentJob({
    runId,
    timeoutMs: 5_000,
    ignoreCachedSnapshot: options?.ignoreCachedSnapshot,
  });

  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt: 1_000 },
  });
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: {
      phase: "end",
      startedAt: 1_000,
      endedAt: 1_100,
      aborted: true,
      ...data,
    },
  });

  // Fire the outer wait before the 15-second terminal retry grace publishes.
  await vi.advanceTimersByTimeAsync(6_000);
  return await waitPromise;
}

describe("waitForAgentJob timeout fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  for (const phase of HARD_TIMEOUT_PHASES) {
    it(`forwards a pending ${phase} hard timeout`, async () => {
      await expect(resolveOuterTimeoutRace({ timeoutPhase: phase })).resolves.toMatchObject({
        status: "timeout",
        timeoutPhase: phase,
        startedAt: 1_000,
        endedAt: 1_100,
      });
    });
  }

  for (const scenario of NON_HARD_TIMEOUTS) {
    it(`does not forward a ${scenario.label}`, async () => {
      await expect(resolveOuterTimeoutRace(scenario.data)).resolves.toBeNull();
    });
  }

  it("keeps restart cancellation as an error instead of a hard timeout", async () => {
    await expect(
      resolveOuterTimeoutRace({
        providerStarted: true,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
      }),
    ).resolves.toMatchObject({
      status: "error",
      stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
      startedAt: 1_000,
      endedAt: 1_100,
    });
  });

  it("publishes exhausted fallback failures without waiting for retry grace", async () => {
    const runId = `run-timeout-fallback-exhausted-${runSequence++}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_100,
        error: "All model fallback candidates failed",
        fallbackExhaustedFailure: true,
      },
    });

    const terminalFailure = {
      status: "error",
      startedAt: 1_000,
      endedAt: 1_100,
      error: "All model fallback candidates failed",
    };
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(terminalFailure);
    await expect(waitPromise).resolves.toMatchObject(terminalFailure);
  });

  it("publishes exhausted fallback provider timeouts without waiting for retry grace", async () => {
    const runId = `run-timeout-fallback-exhausted-provider-${runSequence++}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_100,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "All model fallback candidates failed",
        fallbackExhaustedFailure: true,
      },
    });

    const terminalTimeout = {
      status: "timeout",
      startedAt: 1_000,
      endedAt: 1_100,
      stopReason: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      error: "All model fallback candidates failed",
    };
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(terminalTimeout);
    await expect(waitPromise).resolves.toMatchObject(terminalTimeout);
  });

  it("keeps retryable lifecycle failures pending for the full retry grace", async () => {
    const runId = `run-timeout-fallback-retryable-${runSequence++}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 5_000 });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_100,
        error: "Retryable provider failure",
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waitPromise).resolves.toMatchObject({
      status: "timeout",
      error: "Retryable provider failure",
      pendingError: true,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      endedAt: 1_100,
      error: "Retryable provider failure",
    });
  });

  it.each([
    { label: "failure", metadata: {} },
    {
      label: "provider timeout",
      metadata: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    },
  ])("preserves pending hard timeouts over an exhausted fallback $label", async ({ metadata }) => {
    const runId = `run-timeout-fallback-exhausted-hard-timeout-${runSequence++}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 5_000 });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 1_100,
        aborted: true,
        timeoutPhase: "provider",
      },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_200,
        error: "All model fallback candidates failed",
        ...metadata,
        fallbackExhaustedFailure: true,
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waitPromise).resolves.toMatchObject({
      status: "timeout",
      startedAt: 1_000,
      endedAt: 1_100,
      timeoutPhase: "provider",
    });
  });

  it.each([
    {
      label: "restart cancellation before a provider timeout",
      initial: {
        aborted: true,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
      final: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expected: {
        status: "error",
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
    },
    {
      label: "restart cancellation before an exhausted failure",
      initial: {
        aborted: true,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
      final: {},
      expected: {
        status: "error",
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
    },
    {
      label: "provider timeout before an exhausted failure",
      initial: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "Provider timed out",
      },
      final: {},
      expected: {
        status: "timeout",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "Provider timed out",
      },
    },
  ])("preserves pending error-phase $label", async ({ initial, final, expected }) => {
    const runId = `run-timeout-fallback-pending-error-${runSequence++}`;

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_100,
        ...initial,
      },
    });

    const waitPromise = waitForAgentJob({
      runId,
      timeoutMs: 1_000,
      ignoreCachedSnapshot: true,
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_200,
        error: "All model fallback candidates failed",
        ...final,
        fallbackExhaustedFailure: true,
      },
    });

    const terminalOutcome = { ...expected, startedAt: 1_000, endedAt: 1_100 };
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(terminalOutcome);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waitPromise).resolves.toMatchObject(terminalOutcome);
  });

  it.each([
    {
      label: "restart error before a later provider end",
      first: {
        phase: "error",
        endedAt: 1_100,
        aborted: true,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
      second: {
        phase: "end",
        endedAt: 1_200,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expected: {
        status: "error",
        endedAt: 1_100,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
    },
    {
      label: "RPC cancellation error before a later provider end",
      first: {
        phase: "error",
        endedAt: 1_100,
        aborted: true,
        stopReason: "rpc",
        error: "RPC cancelled the run",
      },
      second: {
        phase: "end",
        endedAt: 1_200,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expected: {
        status: "error",
        endedAt: 1_100,
        stopReason: "rpc",
        error: "RPC cancelled the run",
      },
    },
    {
      label: "provider timeout error before a later provider end",
      first: {
        phase: "error",
        endedAt: 1_100,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "Provider timed out",
      },
      second: {
        phase: "end",
        endedAt: 1_200,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expected: {
        status: "timeout",
        endedAt: 1_100,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "Provider timed out",
      },
    },
    {
      label: "restart error after an earlier provider end",
      first: {
        phase: "error",
        endedAt: 1_200,
        aborted: true,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
      second: {
        phase: "end",
        endedAt: 1_100,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expected: {
        status: "timeout",
        endedAt: 1_100,
        stopReason: "timeout",
        timeoutPhase: "provider",
      },
    },
    {
      label: "provider end before a later restart error",
      first: {
        phase: "end",
        endedAt: 1_100,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      second: {
        phase: "error",
        endedAt: 1_200,
        aborted: true,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        error: "Restart interrupted the run",
      },
      expected: {
        status: "timeout",
        endedAt: 1_100,
        stopReason: "timeout",
        timeoutPhase: "provider",
      },
    },
    {
      label: "provider end after an earlier RPC cancellation error",
      first: {
        phase: "end",
        endedAt: 1_200,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      second: {
        phase: "error",
        endedAt: 1_100,
        aborted: true,
        stopReason: "rpc",
        error: "RPC cancelled the run",
      },
      expected: {
        status: "error",
        endedAt: 1_100,
        stopReason: "rpc",
        error: "RPC cancelled the run",
      },
    },
  ])("preserves canonical terminal precedence for $label", async ({ first, second, expected }) => {
    const runId = `run-timeout-fallback-cross-phase-${runSequence++}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 5_000 });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { startedAt: 1_000, ...first },
    });
    const freshWaitPromise = waitForAgentJob({
      runId,
      timeoutMs: 5_000,
      ignoreCachedSnapshot: true,
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { startedAt: 1_000, ...second },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const terminalOutcome = { startedAt: 1_000, pendingError: undefined, ...expected };
    await expect(waitPromise).resolves.toMatchObject(terminalOutcome);
    await expect(freshWaitPromise).resolves.toMatchObject(terminalOutcome);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(expected);
  });

  it("preserves earlier cancellation over an exhausted fallback provider timeout", async () => {
    const runId = `run-timeout-fallback-exhausted-cancelled-${runSequence++}`;

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 1_050,
        aborted: true,
        stopReason: "rpc",
      },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 1_100,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "All model fallback candidates failed",
        fallbackExhaustedFailure: true,
      },
    });

    await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
      status: "error",
      endedAt: 1_050,
      stopReason: "rpc",
    });
  });

  it("ignores a hard timeout that predates a fresh wait", async () => {
    const runId = `run-timeout-fallback-${runSequence++}`;
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 1_100,
        aborted: true,
        timeoutPhase: "provider",
      },
    });

    const waitPromise = waitForAgentJob({
      runId,
      timeoutMs: 5_000,
      ignoreCachedSnapshot: true,
    });
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(waitPromise).resolves.toBeNull();
  });

  it("lets a fresh wait consume a hard timeout it observes", async () => {
    await expect(
      resolveOuterTimeoutRace({ timeoutPhase: "provider" }, { ignoreCachedSnapshot: true }),
    ).resolves.toMatchObject({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 1_100,
    });
  });
});
