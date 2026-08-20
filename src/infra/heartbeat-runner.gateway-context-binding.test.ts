// A heartbeat wake is a timer callback, not an inbound gateway request, so no
// ambient request scope exists for the runs it admits. Without an instance
// binding the subagents those runs spawn register unbound, and their detached
// completion announce fails with "In-process gateway dispatch requires a
// gateway request scope or instance binding (method: agent)" — the child ran
// and finished, but the requester never learns it.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

describe("startHeartbeatRunner gateway instance binding", () => {
  const TEST_SCHEDULER_SEED = "heartbeat-gateway-binding-test-seed";

  function heartbeatConfig(): OpenClawConfig {
    return {
      agents: { defaults: { heartbeat: { every: "30m" } } },
    } as OpenClawConfig;
  }

  function useFakeHeartbeatTime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  }

  async function wakeOnce() {
    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
  }

  it("exposes the owning gateway context resolver to the wake", async () => {
    useFakeHeartbeatTime();
    const gatewayContext = { owner: "gateway-a" } as unknown as GatewayRequestContext;
    let observed: GatewayRequestContext | undefined;
    let observedAfterAwait: GatewayRequestContext | undefined;
    const runOnce = vi.fn(async () => {
      observed = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
      // The completion announce that needs this binding runs long after the
      // first await, so the scope must survive the wake's continuations.
      await Promise.resolve();
      observedAfterAwait = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
      resolveGatewayContext: () => gatewayContext,
    });

    await wakeOnce();

    expect(runOnce).toHaveBeenCalledOnce();
    expect(observed).toBe(gatewayContext);
    expect(observedAfterAwait).toBe(gatewayContext);
    runner.stop();
  });

  it("stops reporting a binding once the owning gateway instance retires", async () => {
    useFakeHeartbeatTime();
    const gatewayContext = { owner: "gateway-a" } as unknown as GatewayRequestContext;
    let available = true;
    let observed: GatewayRequestContext | undefined;
    const runOnce = vi.fn(async () => {
      observed = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
      resolveGatewayContext: () => (available ? gatewayContext : undefined),
    });

    await wakeOnce();
    expect(observed).toBe(gatewayContext);

    // Lifecycle fencing stays with the resolver: a retired instance must not be
    // handed to work that outlived it.
    available = false;
    await wakeOnce();
    expect(observed).toBeUndefined();
    runner.stop();
  });

  it("does not fabricate a scope when no gateway owns the runner", async () => {
    useFakeHeartbeatTime();
    let sawScope = true;
    const runOnce = vi.fn(async () => {
      sawScope = getPluginRuntimeGatewayRequestScope() !== undefined;
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await wakeOnce();

    expect(runOnce).toHaveBeenCalledOnce();
    expect(sawScope).toBe(false);
    runner.stop();
  });
});
