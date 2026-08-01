import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const recoverRow = vi.hoisted(() => vi.fn());
vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return {
    ...actual,
    recoverInterruptedSubagentRow: recoverRow,
  };
});
vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext: () => undefined,
}));

function run(): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey: "agent:main:subagent:interrupted",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "recover after restart",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
}

function createHarness(runtime: { current?: GatewayRecoveryRuntime }) {
  const entry = run();
  const runs = new Map([[entry.runId, entry]]);
  const finalizeInterruptedSubagentRun = vi.fn(async () => 0);
  const warn = vi.fn();
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns: new Set(),
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery: vi.fn(),
    getGatewayRecoveryRuntime: () => runtime.current,
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    reserveSwarmCollectorLaunch: vi.fn(() => true),
    finalizeInterruptedSubagentRun,
    resumeRequesterSettleWake: vi.fn(),
    startSubagentAnnounceCleanupFlow: vi.fn(() => true),
    completeCleanupBookkeeping: vi.fn(),
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun: vi.fn(),
    callGateway: vi.fn(),
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded: vi.fn(),
    notifyContextEngineSubagentEnded: vi.fn(),
    retireSupersededRun: vi.fn(),
    getRunsForChildSession: () => [],
    getRunsForCollectorGroup: () => [],
    warn,
  });
  return { entry, finalizeInterruptedSubagentRun, sweeper, warn };
}

describe("subagent registry recovery scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    recoverRow.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("makes four dispatch attempts and three separate terminal attempts", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "retry", error: "gateway unavailable" });
    const { finalizeInterruptedSubagentRun, sweeper, warn } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(recoverRow).toHaveBeenCalledTimes(4);
    expect(finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      "subagent interrupted terminal projection remains incomplete",
      { runId: "interrupted-run" },
    );
    sweeper.reset();
  });

  it("re-resolves a missing runtime without consuming the dispatch budget", async () => {
    const runtime: { current?: GatewayRecoveryRuntime } = {};
    recoverRow.mockImplementation(async ({ gatewayRuntime }) =>
      gatewayRuntime ? { status: "handled" } : { status: "deferred" },
    );
    const { finalizeInterruptedSubagentRun, sweeper } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    runtime.current = {} as GatewayRecoveryRuntime;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recoverRow).toHaveBeenCalledTimes(3);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it("re-arms a sweep request that arrives while the owner pass is active", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    let release!: () => void;
    recoverRow
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ status: "handled" });
          }),
      )
      .mockResolvedValue({ status: "handled" });
    const { sweeper } = createHarness(runtime);

    const first = sweeper.runTick();
    await vi.waitFor(() => expect(recoverRow).toHaveBeenCalledOnce());
    await sweeper.runTick();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(0);

    expect(recoverRow).toHaveBeenCalledTimes(2);
    sweeper.reset();
  });
});
