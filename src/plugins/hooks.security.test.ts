import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookBeforeToolCallResult, PluginHookMessageSendingResult } from "./types.js";

const toolEvent = { toolName: "bash", params: { command: "echo hello" } };
const toolCtx = { toolName: "bash" };
const messageEvent = { to: "user-1", content: "hello" };
const messageCtx = { channelId: "forum" };

async function runBeforeToolCallWithHooks(
  registry: PluginRegistry,
  hooks: ReadonlyArray<{
    pluginId: string;
    result: PluginHookBeforeToolCallResult;
    priority?: number;
    handler?: () => PluginHookBeforeToolCallResult | Promise<PluginHookBeforeToolCallResult>;
  }>,
  catchErrors = true,
) {
  addStaticTestHooks(registry, {
    hookName: "before_tool_call",
    hooks,
  });
  const runner = createHookRunner(registry, { catchErrors });
  return await runner.runBeforeToolCall(toolEvent, toolCtx);
}

async function runMessageSendingWithHooks(
  registry: PluginRegistry,
  hooks: ReadonlyArray<{
    pluginId: string;
    result: PluginHookMessageSendingResult;
    priority?: number;
    handler?: () => PluginHookMessageSendingResult | Promise<PluginHookMessageSendingResult>;
  }>,
  catchErrors = true,
) {
  addStaticTestHooks(registry, {
    hookName: "message_sending",
    hooks,
  });
  const runner = createHookRunner(registry, { catchErrors });
  return await runner.runMessageSending(messageEvent, messageCtx);
}

function expectTerminalHookState<
  TResult extends { block?: boolean; blockReason?: string; cancel?: boolean; content?: string },
>(result: TResult | undefined, expected: Partial<TResult>) {
  if ("block" in expected) {
    expect(result?.block).toBe(expected.block);
  }
  if ("blockReason" in expected) {
    expect(result?.blockReason).toBe(expected.blockReason);
  }
  if ("cancel" in expected) {
    expect(result?.cancel).toBe(expected.cancel);
  }
  if ("content" in expected) {
    expect(result?.content).toBe(expected.content);
  }
}

describe("before_tool_call terminal block semantics", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      name: "keeps block=true when a lower-priority hook returns block=false",
      hooks: [
        { pluginId: "high", result: { block: true, blockReason: "dangerous" }, priority: 100 },
        { pluginId: "low", result: { block: false }, priority: 10 },
      ],
      expected: { block: true, blockReason: "dangerous" },
    },
    {
      name: "treats explicit block=false as no-op when no prior hook blocked",
      hooks: [{ pluginId: "single", result: { block: false }, priority: 10 }],
      expected: { block: undefined },
    },
    {
      name: "treats passive handler output as no-op for prior block",
      hooks: [
        { pluginId: "high", result: { block: true, blockReason: "blocked" }, priority: 100 },
        { pluginId: "passive", result: {}, priority: 10 },
      ],
      expected: { block: true, blockReason: "blocked" },
    },
    {
      name: "respects block from a middle hook in a multi-handler chain",
      hooks: [
        { pluginId: "high-passive", result: {}, priority: 100 },
        { pluginId: "middle-block", result: { block: true, blockReason: "mid" }, priority: 50 },
        { pluginId: "low-false", result: { block: false }, priority: 0 },
      ],
      expected: { block: true, blockReason: "mid" },
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectTerminalHookState(result, expected);
  });

  it("short-circuits lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockReturnValue({ block: true, blockReason: "stop" });
    const low = vi.fn().mockReturnValue({ params: { injected: true } });
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        pluginId: "high",
        result: { block: true, blockReason: "stop" },
        priority: 100,
        handler: high,
      },
      { pluginId: "low", result: { params: { injected: true } }, priority: 10, handler: low },
    ]);

    expect(result?.block).toBe(true);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it("preserves deterministic same-priority registration order when terminal hook runs first", async () => {
    const first = vi.fn().mockReturnValue({ block: true, blockReason: "first" });
    const second = vi.fn().mockReturnValue({ block: true, blockReason: "second" });
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        pluginId: "first",
        result: { block: true, blockReason: "first" },
        priority: 50,
        handler: first,
      },
      {
        pluginId: "second",
        result: { block: true, blockReason: "second" },
        priority: 50,
        handler: second,
      },
    ]);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("first");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops before lower-priority throwing hooks when catchErrors is false", async () => {
    const low = vi.fn().mockImplementation(() => {
      throw new Error("should not run");
    });
    const result = await runBeforeToolCallWithHooks(
      registry,
      [
        { pluginId: "high", result: { block: true, blockReason: "guard" }, priority: 100 },
        { pluginId: "low", result: {}, priority: 10, handler: low },
      ],
      false,
    );

    expect(result?.block).toBe(true);
    expect(low).not.toHaveBeenCalled();
  });

  it("throws for before_tool_call when configured as fail-closed", async () => {
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [
        {
          pluginId: "failing",
          result: {},
          priority: 100,
          handler: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const runner = createHookRunner(registry, {
      catchErrors: true,
      failurePolicyByHook: {
        before_tool_call: "fail-closed",
      },
    });

    await expect(runner.runBeforeToolCall(toolEvent, toolCtx)).rejects.toThrow(
      "before_tool_call handler from failing failed: Error: boom",
    );
  });
});

describe("message_sending terminal cancel semantics", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      name: "keeps cancel=true when a lower-priority hook returns cancel=false",
      hooks: [
        { pluginId: "high", result: { cancel: true, content: "guarded" }, priority: 100 },
        { pluginId: "low", result: { cancel: false, content: "override" }, priority: 10 },
      ],
      expected: { cancel: true, content: "guarded" },
    },
    {
      name: "treats explicit cancel=false as no-op when no prior hook canceled",
      hooks: [{ pluginId: "single", result: { cancel: false }, priority: 10 }],
      expected: { cancel: undefined },
    },
    {
      name: "treats passive handler output as no-op for prior cancel",
      hooks: [
        { pluginId: "high", result: { cancel: true }, priority: 100 },
        { pluginId: "passive", result: {}, priority: 10 },
      ],
      expected: { cancel: true },
    },
    {
      name: "allows lower-priority cancel when higher-priority hooks are non-terminal",
      hooks: [
        { pluginId: "high-passive", result: { content: "rewritten" }, priority: 100 },
        { pluginId: "low-cancel", result: { cancel: true }, priority: 10 },
      ],
      expected: { cancel: true },
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runMessageSendingWithHooks(registry, hooks);
    expectTerminalHookState(result, expected);
  });

  it("short-circuits lower-priority hooks after cancel=true", async () => {
    const high = vi.fn().mockReturnValue({ cancel: true, content: "guarded" });
    const low = vi.fn().mockReturnValue({ cancel: false, content: "mutated" });
    const result = await runMessageSendingWithHooks(registry, [
      {
        pluginId: "high",
        result: { cancel: true, content: "guarded" },
        priority: 100,
        handler: high,
      },
      {
        pluginId: "low",
        result: { cancel: false, content: "mutated" },
        priority: 10,
        handler: low,
      },
    ]);

    expect(result?.cancel).toBe(true);
    expect(result?.content).toBe("guarded");
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it("preserves deterministic same-priority registration order for non-terminal merges", async () => {
    const result = await runMessageSendingWithHooks(registry, [
      { pluginId: "first", result: { content: "first" }, priority: 50 },
      { pluginId: "second", result: { content: "second" }, priority: 50 },
    ]);

    expect(result?.content).toBe("second");
  });

  it("stops before lower-priority throwing hooks when catchErrors is false", async () => {
    const low = vi.fn().mockImplementation(() => {
      throw new Error("should not run");
    });
    const result = await runMessageSendingWithHooks(
      registry,
      [
        { pluginId: "high", result: { cancel: true }, priority: 100 },
        { pluginId: "low", result: {}, priority: 10, handler: low },
      ],
      false,
    );

    expect(result?.cancel).toBe(true);
    expect(low).not.toHaveBeenCalled();
  });
});
