/**
 * Test: subagent_spawning, subagent_delivery_target, subagent_spawned & subagent_ended hook wiring
 */
import { describe, expect, it, vi } from "vitest";
import { addStaticTestHooks, createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

describe("subagent hook runner methods", () => {
  const baseRequester = {
    channel: "discord",
    accountId: "work",
    to: "channel:123",
    threadId: "456",
  };

  const baseSubagentCtx = {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
  };

  async function invokeSubagentHook(params: {
    hookName:
      | "subagent_spawning"
      | "subagent_spawned"
      | "subagent_delivery_target"
      | "subagent_ended";
    event: Record<string, unknown>;
    ctx: Record<string, unknown>;
    handlerResult?: unknown;
  }) {
    const handler = vi.fn(async () => ({ status: "ok", threadBindingReady: true as const }));
    if (params.handlerResult !== undefined) {
      handler.mockResolvedValue(params.handlerResult as never);
    }
    const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);
    const result =
      params.hookName === "subagent_spawning"
        ? await runner.runSubagentSpawning(params.event as never, params.ctx as never)
        : params.hookName === "subagent_spawned"
          ? await runner.runSubagentSpawned(params.event as never, params.ctx as never)
          : params.hookName === "subagent_delivery_target"
            ? await runner.runSubagentDeliveryTarget(params.event as never, params.ctx as never)
            : await runner.runSubagentEnded(params.event as never, params.ctx as never);

    expect(handler).toHaveBeenCalledWith(params.event, params.ctx);
    return result;
  }

  it.each([
    {
      name: "runSubagentSpawning invokes registered subagent_spawning hooks",
      hookName: "subagent_spawning" as const,
      methodName: "runSubagentSpawning" as const,
      event: {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        mode: "session" as const,
        requester: baseRequester,
        threadRequested: true,
      },
      ctx: {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
      handlerResult: { status: "ok", threadBindingReady: true as const },
      expectedResult: { status: "ok", threadBindingReady: true },
    },
    {
      name: "runSubagentSpawned invokes registered subagent_spawned hooks",
      hookName: "subagent_spawned" as const,
      methodName: "runSubagentSpawned" as const,
      event: {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "research",
        mode: "run" as const,
        requester: baseRequester,
        threadRequested: true,
      },
      ctx: baseSubagentCtx,
    },
    {
      name: "runSubagentDeliveryTarget invokes registered subagent_delivery_target hooks",
      hookName: "subagent_delivery_target" as const,
      methodName: "runSubagentDeliveryTarget" as const,
      event: {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: baseRequester,
        childRunId: "run-1",
        spawnMode: "session" as const,
        expectsCompletionMessage: true,
      },
      ctx: baseSubagentCtx,
      handlerResult: {
        origin: {
          channel: "discord" as const,
          accountId: "work",
          to: "channel:777",
          threadId: "777",
        },
      },
      expectedResult: {
        origin: {
          channel: "discord",
          accountId: "work",
          to: "channel:777",
          threadId: "777",
        },
      },
    },
    {
      name: "runSubagentEnded invokes registered subagent_ended hooks",
      hookName: "subagent_ended" as const,
      methodName: "runSubagentEnded" as const,
      event: {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent" as const,
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
        runId: "run-1",
        outcome: "ok" as const,
      },
      ctx: baseSubagentCtx,
    },
  ] as const)("$name", async ({ hookName, event, ctx, handlerResult, expectedResult }) => {
    const result = await invokeSubagentHook({ hookName, event, ctx, handlerResult });
    if (expectedResult !== undefined) {
      expect(result).toEqual(expectedResult);
      return;
    }
    expect(result).toBeUndefined();
  });

  it("runSubagentDeliveryTarget returns undefined when no matching hooks are registered", async () => {
    const { runner } = createHookRunnerWithRegistry([]);
    const result = await runner.runSubagentDeliveryTarget(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: baseRequester,
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      baseSubagentCtx,
    );
    expect(result).toBeUndefined();
  });

  it("hasHooks returns true for registered subagent hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "subagent_spawning", handler: vi.fn() },
      { hookName: "subagent_delivery_target", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("subagent_spawning")).toBe(true);
    expect(runner.hasHooks("subagent_delivery_target")).toBe(true);
    expect(runner.hasHooks("subagent_spawned")).toBe(false);
    expect(runner.hasHooks("subagent_ended")).toBe(false);
  });

  it("runSubagentSpawning preserves higher-priority delivery origins", async () => {
    const { registry, runner } = createHookRunnerWithRegistry([]);
    addStaticTestHooks(registry, {
      hookName: "subagent_spawning",
      hooks: [
        {
          pluginId: "high",
          priority: 100,
          result: {
            status: "ok",
            threadBindingReady: true,
            deliveryOrigin: {
              channel: "matrix",
              accountId: "ops",
              to: "room:!high:example",
              threadId: "$high",
            },
          },
        },
        {
          pluginId: "low",
          priority: 10,
          result: {
            status: "ok",
            threadBindingReady: true,
            deliveryOrigin: {
              channel: "matrix",
              accountId: "ops",
              to: "room:!low:example",
              threadId: "$low",
            },
          },
        },
      ],
    });

    const result = await runner.runSubagentSpawning(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        mode: "session",
        requester: baseRequester,
        threadRequested: true,
      },
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
      },
    );

    expect(result).toEqual({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "matrix",
        accountId: "ops",
        to: "room:!high:example",
        threadId: "$high",
      },
    });
  });
});
