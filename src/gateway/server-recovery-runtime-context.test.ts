import { describe, expect, it, vi } from "vitest";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayRecoveryRuntime,
} from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  dispatchGatewayLifecycleMethod,
  registerGatewayRecoveryRuntime,
} from "./server-recovery-runtime-context.js";

function createRecoveryRuntime(result: string) {
  const dispatchAgent = vi.fn(
    async (
      _params: AgentRunRequest,
      _timeoutMs?: number,
      _options?: GatewayInstanceAgentDispatchOptions,
    ) => result,
  );
  const runtime: GatewayRecoveryRuntime = {
    abortAgent: vi.fn(),
    dispatchAgent: async <T = unknown>(
      params: AgentRunRequest,
      timeoutMs?: number,
      options?: GatewayInstanceAgentDispatchOptions,
    ) => (await dispatchAgent(params, timeoutMs, options)) as T,
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  return { dispatchAgent, runtime };
}

describe("dispatchGatewayLifecycleMethod", () => {
  it("uses the exact resolved Gateway recovery runtime instead of the active global runtime", async () => {
    const active = createRecoveryRuntime("active");
    const exact = createRecoveryRuntime("exact");
    const releaseActive = registerGatewayRecoveryRuntime(active.runtime);

    try {
      const result = await dispatchGatewayLifecycleMethod(
        "agent",
        { message: "completion", idempotencyKey: "completion-1" },
        {
          expectFinal: true,
          timeoutMs: 1_000,
          resolveGatewayContext: () =>
            ({ recoveryRuntime: exact.runtime }) as GatewayRequestContext,
        },
      );

      expect(result).toBe("exact");
      expect(active.dispatchAgent).not.toHaveBeenCalled();
      expect(exact.dispatchAgent).toHaveBeenCalledWith(
        { message: "completion", idempotencyKey: "completion-1" },
        1_000,
        { expectFinal: true },
      );
    } finally {
      releaseActive();
    }
  });

  it("fails closed when an explicit Gateway context resolver is stale", async () => {
    const active = createRecoveryRuntime("active");
    const releaseActive = registerGatewayRecoveryRuntime(active.runtime);

    try {
      await expect(
        dispatchGatewayLifecycleMethod(
          "agent",
          { message: "completion", idempotencyKey: "completion-2" },
          { resolveGatewayContext: () => undefined },
        ),
      ).rejects.toThrow("Gateway instance lifecycle dispatch unavailable for agent");
      expect(active.dispatchAgent).not.toHaveBeenCalled();
    } finally {
      releaseActive();
    }
  });
});
