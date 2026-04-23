/**
 * Test: gateway_start & gateway_stop hook wiring (server.impl.ts)
 *
 * Since startGatewayServer is heavily integrated, we test the hook runner
 * calls at the unit level by verifying the hook runner functions exist
 * and validating the integration pattern.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
} from "./types.js";

async function expectGatewayHookCall(params: {
  hookName: "gateway_start" | "gateway_stop";
  event: PluginHookGatewayStartEvent | PluginHookGatewayStopEvent;
  gatewayCtx: PluginHookGatewayContext;
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "gateway_start") {
    await runner.runGatewayStart(params.event as PluginHookGatewayStartEvent, params.gatewayCtx);
  } else {
    await runner.runGatewayStop(params.event as PluginHookGatewayStopEvent, params.gatewayCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.gatewayCtx);
}

describe("gateway hook runner methods", () => {
  const gatewayCtx = {
    port: 18789,
    config: {} as never,
    workspaceDir: "/tmp/openclaw-workspace",
    getCron: () => undefined,
  };

  it.each([
    {
      name: "runGatewayStart invokes registered gateway_start hooks",
      hookName: "gateway_start" as const,
      event: { port: 18789 },
    },
    {
      name: "runGatewayStop invokes registered gateway_stop hooks",
      hookName: "gateway_stop" as const,
      event: { reason: "test shutdown" },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectGatewayHookCall({ hookName, event, gatewayCtx });
  });

  it("hasHooks returns true for registered gateway hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "gateway_start", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("gateway_start")).toBe(true);
    expect(runner.hasHooks("gateway_stop")).toBe(false);
  });
});
