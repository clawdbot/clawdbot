import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { setSubagentSpawnDepsForTest } from "./subagent-spawn-deps.js";
import { callNativeSubagentGateway } from "./subagent-spawn-gateway.js";

vi.mock("./subagent-spawn.runtime.js", async () => {
  const dispatch = await import("../../../gateway/server-plugin-in-process-dispatch.js");
  const scopes = await import("../../../gateway/method-scopes.js");
  return {
    ...scopes,
    dispatchGatewayMethodInProcess: dispatch.dispatchGatewayMethodInProcess,
    hasInProcessGatewayContext: () => Boolean(dispatch.getInProcessGatewayRequestContext()),
    callGateway: vi.fn(),
    ensureContextEnginesInitialized: vi.fn(),
    forkSessionEntryFromParent: vi.fn(),
    getGlobalHookRunner: vi.fn(),
    getRuntimeConfig: vi.fn(),
    loadPreparedModelCatalog: vi.fn(),
    resolveProviderRefOwnership: vi.fn(),
    resolveContextEngine: vi.fn(),
  };
});

vi.mock("../../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

afterEach(() => setSubagentSpawnDepsForTest());

describe("native subagent Gateway transport ownership", () => {
  it.each(["caller", "captured", "scoped"])(
    "rejects a retired %s binding without opening a socket",
    async (binding) => {
      const callGateway = vi.fn<() => void>();
      setSubagentSpawnDepsForTest({
        callGateway: async <T>() => {
          callGateway();
          return { runId: "wrong-gateway", status: "accepted" } as T;
        },
      });
      const resolver = () => undefined;
      const launch = () =>
        callNativeSubagentGateway(
          {
            method: "agent",
            params: { message: "must not launch", idempotencyKey: "closed-owner" },
          },
          undefined,
          binding === "captured" ? resolver : undefined,
        );
      const result =
        binding === "caller"
          ? withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey: "agent:main:main", gatewayContextResolver: resolver },
              launch,
            )
          : binding === "scoped"
            ? withPluginRuntimeGatewayRequestScope(
                { resolveGatewayContext: resolver, isWebchatConnect: () => false },
                launch,
              )
            : launch();

      await expect(result).rejects.toThrow("instance binding");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("keeps socket dispatch available when no Gateway owner was bound", async () => {
    const callGateway = vi.fn<() => void>();
    setSubagentSpawnDepsForTest({
      callGateway: async <T>() => {
        callGateway();
        return { runId: "remote-run", status: "accepted" } as T;
      },
    });

    await expect(
      callNativeSubagentGateway({
        method: "agent",
        params: { message: "standalone", idempotencyKey: "remote-run" },
      }),
    ).resolves.toEqual({
      response: { runId: "remote-run", status: "accepted" },
      taskRowOwnership: "gateway_best_effort",
    });
    expect(callGateway).toHaveBeenCalledOnce();
  });
});
