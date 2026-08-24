// Descendant-wake ownership tests: an accepted wake run that cannot be proven
// stopped must never be reported as a clean no-op.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";
import type {
  SubagentAcceptedSteerDispatch,
  SubagentRunRecord,
} from "./subagents/registry/subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryByKey: vi.fn(),
}));

vi.mock("./subagents/announce/subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: mocks.loadSessionEntryByKey,
  resolveSubagentAnnounceTimeoutMs: () => 1_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

const { wakeSubagentRunAfterDescendants } =
  await import("./subagents/announce/subagent-announce-descendant-wake.js");

function createWakeHarness(params: {
  callGateway: ReturnType<typeof vi.fn>;
  replaced: boolean;
  dispatchGatewayMethodInProcess?: ReturnType<typeof vi.fn>;
}) {
  const sourceEntry = createSubagentRunRecord({
    runId: "run-wake-source",
    childSessionKey: "agent:main:subagent:wake",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "wake after descendants",
    cleanup: "delete",
    createdAt: Date.now() - 1_000,
    startedAt: Date.now() - 500,
    endedAt: Date.now(),
  });
  const dispatchGatewayMethodInProcess =
    params.dispatchGatewayMethodInProcess ??
    vi.fn(async (_method: string, request: { idempotencyKey: string }) => ({
      runId: request.idempotencyKey,
    }));
  const recordAcceptedSubagentSteerDispatch = vi.fn(
    async (recordParams: {
      gatewayRunId: string;
      phase?: SubagentAcceptedSteerDispatch["phase"];
      lifecycleGeneration?: string;
      expectedSessionId?: string;
      expectedLifecycleRevision?: string;
    }) => {
      const dispatch = {
        gatewayRunId: recordParams.gatewayRunId,
        phase: recordParams.phase,
        lifecycleGeneration: recordParams.lifecycleGeneration,
        expectedSessionId: recordParams.expectedSessionId,
        expectedLifecycleRevision: recordParams.expectedLifecycleRevision,
      };
      sourceEntry.acceptedSteerDispatch = dispatch;
      return {
        status: "persisted" as const,
        ownerRunId: sourceEntry.runId,
        owner: sourceEntry,
        dispatch,
      };
    },
  );
  const clearSubagentRunSteerRestart = vi.fn(
    async (
      _runId: string,
      expected: SubagentRunRecord,
      dispatch: SubagentAcceptedSteerDispatch,
    ) => {
      if (expected.acceptedSteerDispatch !== dispatch) {
        return false;
      }
      expected.acceptedSteerDispatch = undefined;
      return true;
    },
  );
  const replaceSubagentRunAfterSteer = vi.fn(async () => {
    if (params.replaced) {
      sourceEntry.acceptedSteerDispatch = undefined;
    }
    return params.replaced;
  });
  const deps = {
    callGateway: params.callGateway,
    dispatchGatewayMethodInProcess,
    getRuntimeConfig: () => ({}) as OpenClawConfig,
    loadSubagentRegistryRuntime: async () => ({
      clearSubagentRunSteerRestart,
      getSubagentRunByRunId: vi.fn(async () => sourceEntry),
      recordAcceptedSubagentSteerDispatch,
      replaceSubagentRunAfterSteer,
    }),
  } as unknown as Parameters<typeof wakeSubagentRunAfterDescendants>[1];
  return {
    clearSubagentRunSteerRestart,
    deps,
    dispatchGatewayMethodInProcess,
    recordAcceptedSubagentSteerDispatch,
    replaceSubagentRunAfterSteer,
    sourceEntry,
  };
}

const wakeParams = {
  runId: "run-wake-source",
  childSessionKey: "agent:main:subagent:wake",
  taskLabel: "task",
  findings: "descendants settled",
  announceId: "announce-1",
  isChildSessionEffectsAllowed: () => true,
};
const wakeDispatchId = buildAnnounceIdempotencyKey(`${wakeParams.announceId}:wake`);

describe("wakeSubagentRunAfterDescendants", () => {
  beforeEach(() => {
    mocks.loadSessionEntryByKey.mockReset();
  });

  it("reports an unconfirmed termination when a failed wake cannot be proven stopped", async () => {
    // No frozen lifecycle revision, so guarded deletion cannot confirm the run.
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const callGateway = vi.fn(async () => ({ aborted: true, runIds: ["a-different-run"] }));
    const harness = createWakeHarness({ callGateway, replaced: false });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe(
      "termination-unconfirmed",
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: wakeParams.childSessionKey, runId: wakeDispatchId },
      }),
    );
    expect(harness.sourceEntry.acceptedSteerDispatch).toMatchObject({
      gatewayRunId: wakeDispatchId,
      phase: "accepted",
    });
  });

  it("reports a plain no-wake when the accepted run is confirmed stopped", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const callGateway = vi.fn(async () => ({ aborted: true, runIds: [wakeDispatchId] }));
    const harness = createWakeHarness({ callGateway, replaced: false });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe(
      "not-woken",
    );
    expect(harness.clearSubagentRunSteerRestart).toHaveBeenCalledOnce();
    expect(harness.sourceEntry.acceptedSteerDispatch).toBeUndefined();
  });

  it("reports a successful wake without terminating the accepted run", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const callGateway = vi.fn(async () => ({}));
    const harness = createWakeHarness({ callGateway, replaced: true });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe("woke");
    expect(callGateway).not.toHaveBeenCalled();
    expect(harness.recordAcceptedSubagentSteerDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayRunId: wakeDispatchId,
        phase: "dispatching",
      }),
    );
    expect(harness.recordAcceptedSubagentSteerDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      harness.dispatchGatewayMethodInProcess.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(harness.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({ operatorRoleActor: { kind: "system" } }),
    );
    expect(harness.replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: wakeParams.runId,
        nextRunId: wakeDispatchId,
        expected: harness.sourceEntry,
      }),
    );
  });

  it("retains ownership when the wake response is lost after dispatch", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const dispatchGatewayMethodInProcess = vi.fn(async (_method: string, _params: unknown) => {
      throw new Error("wake response lost");
    });
    const callGateway = vi.fn(async () => ({ aborted: true, runIds: ["a-different-run"] }));
    const harness = createWakeHarness({
      callGateway,
      replaced: false,
      dispatchGatewayMethodInProcess,
    });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe(
      "termination-unconfirmed",
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: wakeParams.childSessionKey, runId: wakeDispatchId },
      }),
    );
    expect(harness.sourceEntry.acceptedSteerDispatch).toMatchObject({
      gatewayRunId: wakeDispatchId,
      phase: "accepted",
    });
  });

  it("rejects a mismatched response run id without replacing deterministic ownership", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const dispatchGatewayMethodInProcess = vi.fn(async () => ({
      runId: "mismatched-wake-run",
    }));
    const callGateway = vi.fn(async () => ({ aborted: true, runIds: [wakeDispatchId] }));
    const harness = createWakeHarness({
      callGateway,
      replaced: true,
      dispatchGatewayMethodInProcess,
    });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe(
      "not-woken",
    );

    expect(harness.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: wakeParams.childSessionKey, runId: wakeDispatchId },
      }),
    );
  });
});
