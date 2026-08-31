// Safe gateway restart tests cover operator-facing acknowledgement copy.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayCli = vi.hoisted(() => vi.fn());
const appendGatewayLifecycleAudit = vi.hoisted(() => vi.fn());
const runtimeLog = vi.hoisted(() => vi.fn());
const runtimeWriteJson = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGatewayCli,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeLog,
    writeJson: runtimeWriteJson,
  },
  writeRuntimeJson: (_runtime: unknown, payload: unknown) => runtimeWriteJson(payload),
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit,
}));

describe("runSafeGatewayRestart", () => {
  beforeEach(() => {
    callGatewayCli.mockReset();
    appendGatewayLifecycleAudit.mockReset();
    runtimeLog.mockReset();
    runtimeWriteJson.mockReset();
  });

  it("reports that skip-deferral still allows close-stage reply drain", async () => {
    const { runSafeGatewayRestart } = await import("./lifecycle-safe-restart.js");
    callGatewayCli.mockResolvedValueOnce({
      status: "scheduled",
      preflight: {
        safe: false,
        activeWork: {
          queueSize: 1,
          runningTasks: 0,
          activeRequests: 0,
          activeAgentRuns: 0,
          pendingReplies: 2,
          totalActive: 3,
        },
        blockers: [{ kind: "pending-replies", count: 2, message: "2 pending reply(ies)" }],
        summary: "restart deferred: 2 pending reply(ies)",
      },
      restart: { pid: 123 },
    });

    await expect(
      runSafeGatewayRestart({ json: true, safe: true, skipDeferral: true }),
    ).resolves.toBe(true);

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: { reason: "gateway.restart.safe", skipDeferral: true },
      timeoutMs: 10_000,
    });
    expect(runtimeWriteJson).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "safe restart requested; gateway bypassing active-work deferral; " +
          "shutdown may still wait for pending replies to drain",
        result: "scheduled",
      }),
    );
  });
});
