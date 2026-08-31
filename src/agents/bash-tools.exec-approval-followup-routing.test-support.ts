// Captured-route tests share the sender suite's external transport mocks.
import { describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { registerGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { buildExecApprovalFollowupTarget } from "./bash-tools.exec-host-shared.js";
import { callGatewayTool } from "./tools/gateway.js";

describe("exec approval followup routing", () => {
  it.each(["live", "missing", "throwing", "replaced"] as const)(
    "retains the captured Gateway route: %s",
    async (liveness) => {
      const dispatchA = vi.fn(async () => ({ status: "accepted", runId: "followup-a" }));
      const waitA = vi.fn(async () => ({ status: "ok", endedAt: 1 }));
      const dispatchB = vi.fn(async () => ({ status: "ok" }));
      const runtimeA = {
        dispatchAgent: dispatchA,
        waitForAgent: waitA,
      } as unknown as GatewayRecoveryRuntime;
      const runtimeB = {
        dispatchAgent: dispatchB,
        waitForAgent: vi.fn(),
      } as unknown as GatewayRecoveryRuntime;
      const contextA = { recoveryRuntime: runtimeA } as GatewayRequestContext;
      const contextB = { recoveryRuntime: runtimeB } as GatewayRequestContext;
      let context: GatewayRequestContext | undefined = contextA;
      let throws = false;
      const target = withPluginRuntimeGatewayContextResolver(
        () => {
          if (throws) {
            throw new Error("instance retired");
          }
          return context;
        },
        () =>
          buildExecApprovalFollowupTarget({ approvalId: "route-a", sessionKey: "agent:main:main" }),
      );
      const release = registerGatewayRecoveryRuntime(runtimeB);
      if (liveness === "missing") {
        context = undefined;
      }
      if (liveness === "replaced") {
        context = contextB;
      }
      throws = liveness === "throwing";
      try {
        const pending = sendExecApprovalFollowup({
          ...target,
          resultText: "Exec finished (code 0)\ndone",
        });
        if (liveness === "live") {
          await expect(pending).resolves.toBe(true);
          expect(dispatchA).toHaveBeenCalledOnce();
          expect(waitA).toHaveBeenCalledOnce();
        } else {
          await expect(pending).rejects.toThrow();
          expect(dispatchA).not.toHaveBeenCalled();
          expect(waitA).not.toHaveBeenCalled();
        }
        expect(dispatchB).not.toHaveBeenCalled();
        expect(callGatewayTool).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );

  it("keeps the socket route selected before an in-process Gateway appears", async () => {
    const target = buildExecApprovalFollowupTarget({
      approvalId: "socket-a",
      sessionKey: "agent:main:main",
    });
    const dispatch = vi.fn(async () => ({ status: "ok" }));
    const release = registerGatewayRecoveryRuntime({
      dispatchAgent: dispatch,
    } as unknown as GatewayRecoveryRuntime);
    vi.mocked(callGatewayTool).mockResolvedValue({ status: "ok" });
    try {
      await sendExecApprovalFollowup({ ...target, resultText: "Exec finished (code 0)\ndone" });
      expect(callGatewayTool).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
