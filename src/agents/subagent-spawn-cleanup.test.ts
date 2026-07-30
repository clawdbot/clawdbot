import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFailedSpawnBeforeAgentStart } from "./subagent-spawn-cleanup.js";
import { setSubagentSpawnDepsForTest } from "./subagent-spawn-deps.js";

describe("cleanupFailedSpawnBeforeAgentStart reserved session deletion", () => {
  afterEach(() => {
    setSubagentSpawnDepsForTest();
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
      waitForSessionDeletion: { maxAttempts: 3, retryDelayMs: 0 },
    });

    expect(result).toMatchObject({
      attachmentsRemoved: true,
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
      waitForSessionDeletion: { maxAttempts: 3, retryDelayMs: 0 },
    });

    expect(result).toMatchObject({
      attachmentsRemoved: true,
      sessionDeleted: true,
      sessionDeletion: "deleted",
    });
    expect(callGateway).toHaveBeenCalledTimes(3);
  });
});
