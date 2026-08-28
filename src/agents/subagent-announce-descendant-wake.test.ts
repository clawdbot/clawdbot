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
  acceptedBindingStatus?: "persisted" | "pending-persistence";
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
      expectedDispatch?: SubagentAcceptedSteerDispatch;
      phase?: SubagentAcceptedSteerDispatch["phase"];
      lifecycleGeneration?: string;
      expectedSessionId?: string;
      expectedLifecycleRevision?: string;
    }) => {
      if (
        recordParams.expectedDispatch &&
        sourceEntry.acceptedSteerDispatch !== recordParams.expectedDispatch
      ) {
        return { status: "rejected" as const };
      }
      const status =
        recordParams.phase === "accepted"
          ? (params.acceptedBindingStatus ?? "persisted")
          : "persisted";
      const dispatch = {
        gatewayRunId: recordParams.gatewayRunId,
        phase: recordParams.phase,
        lifecycleGeneration: recordParams.lifecycleGeneration,
        expectedSessionId: recordParams.expectedSessionId,
        expectedLifecycleRevision: recordParams.expectedLifecycleRevision,
      };
      sourceEntry.acceptedSteerDispatch = dispatch;
      return {
        status,
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
      clearLazySubagentSteerRestart: clearSubagentRunSteerRestart,
      getLazySubagentRunByRunId: vi.fn(async () => sourceEntry),
      recordLazySubagentSteerDispatch: recordAcceptedSubagentSteerDispatch,
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

  it("binds a runtime-assigned accepted run id to the exact durable reservation", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const runtimeRunId = "runtime-assigned-wake-run";
    const dispatchGatewayMethodInProcess = vi.fn(async () => ({
      runId: runtimeRunId,
      status: "accepted",
    }));
    const callGateway = vi.fn(async () => ({}));
    const harness = createWakeHarness({
      callGateway,
      replaced: true,
      dispatchGatewayMethodInProcess,
    });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe("woke");

    expect(callGateway).not.toHaveBeenCalled();
    expect(harness.recordAcceptedSubagentSteerDispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        gatewayRunId: runtimeRunId,
        expectedDispatch: expect.objectContaining({
          gatewayRunId: wakeDispatchId,
          phase: "dispatching",
        }),
        phase: "accepted",
      }),
    );
    expect(harness.replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: wakeParams.runId,
        nextRunId: runtimeRunId,
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

  it("cleans the deterministic reservation when the wake response is empty", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const dispatchGatewayMethodInProcess = vi.fn(async () => ({}));
    const callGateway = vi.fn(async (request: { params?: { runId?: string } }) => ({
      aborted: true,
      runIds: [request.params?.runId],
    }));
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
    expect(harness.sourceEntry.acceptedSteerDispatch).toBeUndefined();
  });

  it("defers replacement when the accepted run binding is not durable", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const runtimeRunId = "runtime-wake-pending-persistence";
    const dispatchGatewayMethodInProcess = vi.fn(async () => ({
      runId: runtimeRunId,
      status: "accepted",
    }));
    const callGateway = vi.fn(async () => ({}));
    const harness = createWakeHarness({
      callGateway,
      replaced: true,
      acceptedBindingStatus: "pending-persistence",
      dispatchGatewayMethodInProcess,
    });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe(
      "termination-unconfirmed",
    );

    expect(harness.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(harness.sourceEntry.acceptedSteerDispatch).toMatchObject({
      gatewayRunId: runtimeRunId,
      phase: "accepted",
    });
  });

  it("terminates an accepted run when completion authority closes before replacement", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const runtimeRunId = "runtime-wake-after-closure";
    let effectsAllowed = true;
    const dispatchGatewayMethodInProcess = vi.fn(async () => {
      effectsAllowed = false;
      return { runId: runtimeRunId, status: "accepted" };
    });
    const callGateway = vi.fn(async (request: { params?: { runId?: string } }) => ({
      aborted: true,
      runIds: [request.params?.runId],
    }));
    const harness = createWakeHarness({
      callGateway,
      replaced: true,
      dispatchGatewayMethodInProcess,
    });

    await expect(
      wakeSubagentRunAfterDescendants(
        { ...wakeParams, isChildSessionEffectsAllowed: () => effectsAllowed },
        harness.deps,
      ),
    ).resolves.toBe("not-woken");

    expect(harness.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: wakeParams.childSessionKey, runId: runtimeRunId },
      }),
    );
    expect(harness.sourceEntry.acceptedSteerDispatch).toBeUndefined();
  });

  it("rejects a mismatched response run id without replacing deterministic ownership", async () => {
    mocks.loadSessionEntryByKey.mockReturnValue({ sessionId: "sess-wake" });
    const dispatchGatewayMethodInProcess = vi.fn(async () => ({
      runId: "mismatched-wake-run",
    }));
    const callGateway = vi.fn(async (request: { params?: { runId?: string } }) => ({
      aborted: true,
      runIds: [request.params?.runId],
    }));
    const harness = createWakeHarness({
      callGateway,
      replaced: true,
      dispatchGatewayMethodInProcess,
    });

    await expect(wakeSubagentRunAfterDescendants(wakeParams, harness.deps)).resolves.toBe(
      "not-woken",
    );

    expect(harness.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: wakeParams.childSessionKey, runId: "mismatched-wake-run" },
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: wakeParams.childSessionKey, runId: wakeDispatchId },
      }),
    );
    expect(harness.recordAcceptedSubagentSteerDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ gatewayRunId: "mismatched-wake-run" }),
    );
    expect(harness.sourceEntry.acceptedSteerDispatch).toBeUndefined();
  });
});
