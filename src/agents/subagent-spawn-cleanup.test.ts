import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupFailedSpawnBeforeAgentStart,
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";
import { setSubagentSpawnDepsForTest } from "./subagent-spawn-deps.js";

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

describe("subagent spawn cleanup identity", () => {
  afterEach(() => {
    setSubagentSpawnDepsForTest();
  });

  it("requires both frozen session identities before deletion", async () => {
    const callGateway = vi.fn();

    await expect(
      cleanupProvisionalSession("agent:main:subagent:child", {
        expectedSessionId: "session-id",
        callGateway,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("returns indeterminate after persistent deletion failure", async () => {
    const callGateway = vi.fn().mockRejectedValue(new Error("session store unavailable"));
    setSubagentSpawnDepsForTest({
      callGateway,
      hasInProcessGatewayContext: () => false,
    });

    const result = await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey: "agent:worker:subagent:persistent-delete-failure",
      deleteTranscript: true,
      expectedIdentity: {
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      waitForSessionDeletion: { maxAttempts: 3, retryDelayMs: 0 },
    });

    expect(result).toMatchObject({
      attachmentsRemoved: false,
      sessionDeleted: false,
      sessionDeletion: "indeterminate",
    });
    expect(callGateway).toHaveBeenCalledTimes(3);
  });

  it("honors the timeout boundary without consuming the remaining attempt budget", async () => {
    const callGateway = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    setSubagentSpawnDepsForTest({
      callGateway,
      hasInProcessGatewayContext: () => false,
    });

    const result = await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey: "agent:worker:subagent:delete-timeout-boundary",
      deleteTranscript: true,
      expectedIdentity: {
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      waitForSessionDeletion: { maxAttempts: 10, maxElapsedMs: 0, retryDelayMs: 0 },
    });

    expect(result.sessionDeletion).toBe("indeterminate");
    expect(result.sessionDeleted).toBe(false);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 1 });
  });

  it("reports deleted when a bounded retry eventually succeeds", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary store outage"))
      .mockRejectedValueOnce(new Error("temporary gateway outage"))
      .mockResolvedValueOnce({ ok: true });
    setSubagentSpawnDepsForTest({
      callGateway,
      hasInProcessGatewayContext: () => false,
    });

    const result = await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey: "agent:worker:subagent:eventual-delete-success",
      deleteTranscript: true,
      expectedIdentity: {
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      waitForSessionDeletion: { maxAttempts: 3, retryDelayMs: 0 },
    });

    expect(result).toMatchObject({
      attachmentsRemoved: true,
      sessionDeleted: true,
      sessionDeletion: "deleted",
    });
    expect(callGateway).toHaveBeenCalledTimes(3);
  });

  it("accepts chat.abort only when it confirms the exact run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
      .mockResolvedValueOnce({ deleted: true });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        emitLifecycleHooks: false,
        deleteTranscript: true,
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      timeoutMs: 60_000,
    });
  });

  it("does not delete after chat.abort confirms the matching run", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops cleanup when guarded deletion observes a successor lifecycle", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["different-run"] })
      .mockRejectedValueOnce(sessionChangedError());

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
