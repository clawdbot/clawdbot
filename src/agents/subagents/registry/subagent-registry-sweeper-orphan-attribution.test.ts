import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBootLifecycleSegment } from "../../../infra/gateway-boot-lifecycle.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const RUN_STARTED_AT = Date.parse("2026-08-26T22:49:16.000Z");
const RUN_DIED_AT = Date.parse("2026-08-26T22:54:52.000Z");
const GATEWAY_RESTARTED_AT = Date.parse("2026-08-26T23:28:30.000Z");
const RUN_REAPED_AT = Date.parse("2026-08-26T23:29:51.000Z");

const bootSegments = vi.hoisted(() => ({
  current: [] as GatewayBootLifecycleSegment[],
}));
const orphanReason = vi.hoisted(() => ({
  current: undefined as string | undefined,
}));

vi.mock("./subagent-orphan-attribution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-orphan-attribution.js")>();
  return {
    ...actual,
    loadGatewayBootSegmentsForAttribution: () => bootSegments.current,
  };
});
vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-session-reconciliation.js")>();
  return {
    ...actual,
    resolveSubagentRunOrphanReason: () => orphanReason.current ?? null,
    loadSubagentSessionEntry: () => undefined,
  };
});
// Partial mock: agent-events registers a reset handler against this module at
// import time, so replacing it wholesale breaks any project that loads both.
vi.mock("../../../infra/agent-run-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/agent-run-registry.js")>();
  return {
    ...actual,
    getAgentRunContext: () => undefined,
  };
});
// Restart recovery is offered the row first; "ignored" is its decline, which is
// what lets the orphan-attribution path under test run.
vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return {
    ...actual,
    recoverInterruptedSubagentRow: async () => ({ status: "ignored" as const }),
  };
});

function segment(overrides: Partial<GatewayBootLifecycleSegment>): GatewayBootLifecycleSegment {
  return {
    bootId: "boot",
    pid: 1234,
    startedAtMs: 0,
    completedAtMs: null,
    outcome: null,
    hostBootId: "kernel:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...overrides,
  };
}

const childRuns = (runs: Map<string, SubagentRunRecord>) => (childSessionKey: string) =>
  [...runs.values()].filter((entry) => entry.childSessionKey === childSessionKey);

function createHarness(entryOverrides?: Partial<SubagentRunRecord>) {
  const entry = {
    ...createSubagentRunRecord({
      runId: "orphaned-run",
      childSessionKey: "agent:main:subagent:orphaned",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "long running work",
      cleanup: "keep",
      createdAt: RUN_STARTED_AT,
      startedAt: RUN_STARTED_AT,
    }),
    ...entryOverrides,
  } as SubagentRunRecord;
  const runs = new Map([[entry.runId, entry]]);
  const completeSubagentRunWithRecovery = vi.fn<
    (completion: SubagentCompletionRequest, source: string) => Promise<void>
  >(async () => {});
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns: new Set(),
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery,
    getGatewayRecoveryRuntime: () => undefined,
    abandonSubagentRestartRecoveryLaunch: vi.fn(() => true),
    clearAcceptedSubagentRestartRecovery: vi.fn(() => true),
    resumeSettledSubagentRestartRecovery: vi.fn(() => true),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    markSubagentRestartRecoveryLaunchAttempted: vi.fn(() => undefined),
    markSubagentRestartRecoveryLaunchAccepted: vi.fn(() => undefined),
    markSubagentRestartRecoveryLaunchConsumed: vi.fn(() => undefined),
    reserveSubagentRestartRecoveryLaunch: vi.fn(
      (params: { idempotencyKey: string }) => params.idempotencyKey,
    ),
    resetSubagentRestartRecoveryLaunchAttempt: vi.fn(() => true),
    finalizeInterruptedSubagentRun: vi.fn(async () => 0),
    resumeRequesterSettleWake: vi.fn(),
    startSubagentAnnounceCleanupFlow: vi.fn(() => true),
    completeCleanupBookkeeping: vi.fn(),
    discardTerminalDelivery: vi.fn(),
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun: vi.fn(),
    callGateway: vi.fn(),
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded: vi.fn(),
    notifyContextEngineSubagentEnded: vi.fn(),
    retireSupersededRun: vi.fn(),
    getRunsForChildSession: childRuns(runs),
    getRunsForCollectorGroup: () => [],
    warn: vi.fn(),
  } as unknown as Parameters<typeof createSubagentRegistrySweeper>[0]);
  return { entry, runs, completeSubagentRunWithRecovery, sweeper };
}

describe("sweeper attribution for runs orphaned by a gateway death", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    // Reap long after the death, exactly as the real 34-minute outage did.
    vi.useFakeTimers({ now: RUN_REAPED_AT });
    orphanReason.current = "missing-session-entry";
    bootSegments.current = [
      segment({ bootId: "boot-minus-5", startedAtMs: RUN_STARTED_AT - 60_000 }),
      segment({
        bootId: "boot-minus-4",
        startedAtMs: GATEWAY_RESTARTED_AT,
        hostBootId: "kernel:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ];
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("notifies the spawning session instead of silently pruning a run that said nothing", async () => {
    const { completeSubagentRunWithRecovery, runs, sweeper } = createHarness();

    await sweeper.sweepOnce();
    sweeper.reset();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledTimes(1);
    const [completion, source] = completeSubagentRunWithRecovery.mock.calls[0]!;
    expect(source).toBe("sweeper-orphaned-by-gateway-death");
    // sendFarewell is what carries the outcome back to the requester session.
    expect(completion.sendFarewell).toBe(true);
    expect(completion.outcome.status).toBe("error");
    expect(completion.outcome.error).toContain("host rebooted under the gateway");
    expect(completion.outcome.error).toContain("boot-minus-5 ended without a clean stop");
    expect(completion.outcome.error).toContain("0 assistant messages recorded");
    expect(completion.outcome.error).not.toContain("lost active execution context");
    // The row is completed rather than deleted out from under the requester.
    expect(runs.has("orphaned-run")).toBe(true);
  });

  it("ends the run at its death, not at the reap that found it", async () => {
    const { completeSubagentRunWithRecovery, sweeper } = createHarness();

    await sweeper.sweepOnce();
    sweeper.reset();

    const [completion] = completeSubagentRunWithRecovery.mock.calls[0]!;
    // No last-activity evidence beyond the start, so the death is bounded by
    // the restart. It must never be the reap timestamp.
    expect(completion.endedAt).toBe(GATEWAY_RESTARTED_AT);
    expect(completion.endedAt).not.toBe(RUN_REAPED_AT);
  });

  it("uses the run's own last activity as the death when it recorded one", async () => {
    const { completeSubagentRunWithRecovery, sweeper } = createHarness({
      completion: { required: true, capturedAt: RUN_DIED_AT },
    });

    await sweeper.sweepOnce();
    sweeper.reset();

    const [completion] = completeSubagentRunWithRecovery.mock.calls[0]!;
    expect(completion.endedAt).toBe(RUN_DIED_AT);
    expect(completion.outcome.error).toContain("at least 5m36s");
    expect(completion.outcome.error).not.toContain("40m");
  });

  it("leaves the silent prune in place when the boot stopped cleanly", async () => {
    bootSegments.current = [
      segment({
        bootId: "boot-clean",
        startedAtMs: RUN_STARTED_AT - 60_000,
        completedAtMs: RUN_DIED_AT,
        outcome: "clean_stop",
      }),
      segment({ bootId: "boot-next", startedAtMs: GATEWAY_RESTARTED_AT }),
    ];
    const { completeSubagentRunWithRecovery, runs, sweeper } = createHarness();

    await sweeper.sweepOnce();
    sweeper.reset();

    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    expect(runs.has("orphaned-run")).toBe(false);
  });

  it("keeps the generic wording when no boot history explains the orphan", async () => {
    bootSegments.current = [];
    const { completeSubagentRunWithRecovery, runs, sweeper } = createHarness();

    await sweeper.sweepOnce();
    sweeper.reset();

    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    expect(runs.has("orphaned-run")).toBe(false);
  });

  it("does not hijack a run that recorded assistant output", async () => {
    const { completeSubagentRunWithRecovery, sweeper } = createHarness({
      completion: { required: true, resultText: "here is what I found" },
    });

    await sweeper.sweepOnce();
    sweeper.reset();

    // Output-bearing runs keep the existing prune path; the loud notification
    // is reserved for the case the requester cannot recover from on its own.
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
  });
});
