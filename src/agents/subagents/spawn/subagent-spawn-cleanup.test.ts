import { describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkHolders,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

describe("subagent spawn cleanup identity", () => {
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

  it("guards session deletion after chat.abort confirms the matching run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["gateway-run"] })
      .mockResolvedValueOnce({ deleted: true });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      releaseSessionAfterAbort: true,
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

  it("transfers guarded deletion after a matching abort already stopped the run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["gateway-run"] })
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(sessionChangedError());

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        releaseSessionAfterAbort: true,
        callGateway,
      }),
    ).resolves.toBe("released");

    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(3));
    expect(callGateway).toHaveBeenNthCalledWith(3, {
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

  it("releases transferred cleanup root work when the Gateway starts draining", async () => {
    let finishDelete: (value: unknown) => void = () => {};
    const stalledDelete = new Promise<unknown>((resolve) => {
      finishDelete = resolve;
    });
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["gateway-run"] })
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockReturnValueOnce(stalledDelete);
    const root = tryBeginGatewayRootWorkAdmission("test:accepted-run");

    try {
      await root?.run(async () => {
        await terminateAcceptedCollectorRun({
          childSessionKey: "agent:main:subagent:child",
          gatewayRunId: "gateway-run",
          expectedSessionId: "session-id",
          expectedLifecycleRevision: "session-revision",
          releaseSessionAfterAbort: true,
          callGateway,
        });
      });
      root?.release();
      expect(getActiveGatewayRootWorkHolders()).toEqual(["subagents:accepted-run-cleanup"]);

      markGatewayRestartDraining();

      await vi.waitFor(() => expect(getActiveGatewayRootWorkHolders()).toEqual([]));
    } finally {
      finishDelete({ deleted: true });
      root?.release();
      resetGatewayWorkAdmission();
    }
  });

  it("bounds transferred cleanup after persistent guarded deletion failure", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["gateway-run"] })
      .mockRejectedValue(new Error("gateway unavailable"));
    const root = tryBeginGatewayRootWorkAdmission("test:accepted-run");

    try {
      await root?.run(async () => {
        await terminateAcceptedCollectorRun({
          childSessionKey: "agent:main:subagent:child",
          gatewayRunId: "gateway-run",
          expectedSessionId: "session-id",
          expectedLifecycleRevision: "session-revision",
          releaseSessionAfterAbort: true,
          callGateway,
          timeoutMs: 20,
        });
      });
      root?.release();
      expect(getActiveGatewayRootWorkHolders()).toEqual(["subagents:accepted-run-cleanup"]);

      await vi.waitFor(() => expect(getActiveGatewayRootWorkHolders()).toEqual([]));
      expect(callGateway.mock.calls.length).toBeGreaterThan(2);
    } finally {
      root?.release();
      resetGatewayWorkAdmission();
    }
  });

  it("stops cleanup when guarded deletion observes a successor lifecycle", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["gateway-run"] })
      .mockRejectedValueOnce(sessionChangedError());

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        releaseSessionAfterAbort: true,
        callGateway,
      }),
    ).resolves.toBe("changed");

    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
