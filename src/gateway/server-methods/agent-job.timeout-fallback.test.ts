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
