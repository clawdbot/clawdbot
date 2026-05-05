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
  PluginHookCronChangedEvent,
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

  it("runCronChanged invokes registered cron_changed hooks", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "updated",
      jobId: "job-1",
      nextRunAtMs: 123,
      sessionTarget: "main",
      agentId: "main",
      job: {
        id: "job-1",
        agentId: "main",
        sessionTarget: "main",
        state: { nextRunAtMs: 123 },
      },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
  });

  it("runCronChanged passes finished events with delivery and error fields", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "finished",
      jobId: "job-2",
      sessionTarget: "session:ops",
      agentId: "reporter",
      status: "error",
      error: "timeout",
      summary: "Job timed out",
      delivered: false,
      deliveryStatus: "not-delivered",
      deliveryError: "channel unavailable",
      durationMs: 5000,
      runAtMs: 100,
      nextRunAtMs: 200,
      model: "gpt-5.4",
      provider: "openai",
      job: {
        id: "job-2",
        agentId: "reporter",
        sessionTarget: "session:ops",
        state: { lastRunStatus: "error", lastError: "timeout" },
      },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
  });

  it("runCronChanged handles removed events without job", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "removed",
      jobId: "job-3",
      sessionTarget: "isolated",
      job: { id: "job-3", name: "deleted-job", sessionTarget: "isolated" },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
    expect(handler.mock.calls[0][0].job).toEqual({
      id: "job-3",
      name: "deleted-job",
      sessionTarget: "isolated",
    });
  });

  it("hasHooks returns true for registered gateway hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "gateway_start", handler: vi.fn() },
      { hookName: "cron_changed", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("gateway_start")).toBe(true);
    expect(runner.hasHooks("cron_changed")).toBe(true);
    expect(runner.hasHooks("gateway_stop")).toBe(false);
  });
});
