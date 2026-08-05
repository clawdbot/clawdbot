import { describe, expect, it, vi } from "vitest";
import {
  cleanupFailedSpawnBeforeAgentStart,
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

  it("stops waiting when exact session deletion identity is unavailable", async () => {
    await expect(
      cleanupFailedSpawnBeforeAgentStart({
        childSessionKey: "agent:main:subagent:child",
        waitForSessionDeletion: true,
        expectedSessionId: "session-id",
      }),
    ).resolves.toEqual({
      attachmentsRemoved: true,
      sessionDeleted: false,
    });
  });

  it("treats an exact no-active-run abort response as settled", async () => {
    const callGateway = vi.fn().mockResolvedValueOnce({
      ok: true,
      aborted: false,
      runIds: [],
    });

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBe(true);

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("does not delete after chat.abort confirms the matching run", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBe(true);

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops after an inconclusive abort when exact deletion identity is unavailable", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["different-run"],
    }));

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        callGateway,
      }),
    ).resolves.toBe(false);

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
    ).resolves.toBe(true);

    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("bounds accepted termination to one abort and deletion attempt when requested", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["different-run"] })
      .mockRejectedValueOnce(new Error("delete unavailable"));

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
        retry: false,
      }),
    ).resolves.toBe(false);

    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
