/** Tests before-tool-call hook ordering, mutation, and cancellation behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-fixtures.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./types.js";

const stubCtx: PluginHookToolContext = {
  toolName: "bash",
  agentId: "main",
  sessionKey: "agent:main:main",
};

async function runBeforeToolCallWithHooks(
  registry: PluginRegistry,
  hooks: ReadonlyArray<{
    pluginId: string;
    result: PluginHookBeforeToolCallResult;
    priority?: number;
  }>,
) {
  addStaticTestHooks(registry, {
    hookName: "before_tool_call",
    hooks,
  });
  const runner = createHookRunner(registry);
  return await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
}

function expectRequireApprovalResult(
  result: PluginHookBeforeToolCallResult | undefined,
  expected: {
    block?: boolean;
    blockReason?: string;
    params?: Record<string, unknown>;
    requireApproval?: PluginHookBeforeToolCallResult["requireApproval"];
  },
) {
  expect(result?.block).toBe(expected.block);
  expect(result?.blockReason).toBe(expected.blockReason);
  expect(result?.params).toEqual(expected.params);
  expect(result?.requireApproval).toEqual(expected.requireApproval);
}

describe("before_tool_call hook merger — requireApproval", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it.each([
    {
      name: "propagates requireApproval from a single plugin",
      hooks: [
        {
          pluginId: "sage",
          result: {
            requireApproval: {
              id: "approval-1",
              title: "Sensitive tool",
              description: "This tool does something sensitive",
              severity: "warning",
            },
          },
        },
      ],
      expectedApproval: {
        id: "approval-1",
        title: "Sensitive tool",
        description: "This tool does something sensitive",
        severity: "warning",
        pluginId: "sage",
      },
    },
    {
      name: "stamps pluginId from the registration",
      hooks: [
        {
          pluginId: "my-plugin",
          result: {
            requireApproval: {
              id: "a1",
              title: "T",
              description: "D",
            },
          },
        },
      ],
      expectedApproval: {
        id: "a1",
        title: "T",
        description: "D",
        pluginId: "my-plugin",
      },
    },
    {
      name: "first hook with requireApproval wins when multiple plugins set it",
      hooks: [
        {
          pluginId: "plugin-a",
          result: {
            requireApproval: {
              title: "First",
              description: "First plugin",
            },
          },
          priority: 100,
        },
        {
          pluginId: "plugin-b",
          result: {
            requireApproval: {
              title: "Second",
              description: "Second plugin",
            },
          },
          priority: 50,
        },
      ],
      expectedApproval: {
        title: "First",
        description: "First plugin",
        pluginId: "plugin-a",
      },
    },
    {
      name: "does not overwrite pluginId if plugin sets it (stamped by merger)",
      hooks: [
        {
          pluginId: "actual-plugin",
          result: {
            requireApproval: {
              title: "T",
              description: "D",
              pluginId: "should-be-overwritten",
            },
          },
        },
      ],
      expectedApproval: {
        title: "T",
        description: "D",
        pluginId: "actual-plugin",
      },
    },
  ] as const)("$name", async ({ hooks, expectedApproval }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectRequireApprovalResult(result, { requireApproval: expectedApproval });
  });

  it("merges block and requireApproval from different plugins", async () => {
    const result = await runBeforeToolCallWithHooks(registry, [
      {
        pluginId: "approver",
        result: {
          requireApproval: {
            title: "Needs approval",
            description: "Approval needed",
          },
        },
        priority: 100,
      },
      {
        pluginId: "blocker",
        result: {
          block: true,
          blockReason: "blocked",
        },
        priority: 50,
      },
    ]);
    expect(result?.block).toBe(true);
    expect(result?.requireApproval?.title).toBe("Needs approval");
  });

  it("returns undefined requireApproval when no plugin sets it", async () => {
    const result = await runBeforeToolCallWithHooks(registry, [
      { pluginId: "plain", result: { params: { extra: true } } },
    ]);
    expect(result?.requireApproval).toBeUndefined();
  });

  it.each([
    {
      name: "freezes params after requireApproval when a lower-priority plugin tries to override them",
      hooks: [
        {
          pluginId: "approver",
          result: {
            params: { source: "approver", safe: true },
            requireApproval: {
              title: "Needs approval",
              description: "Approval needed",
            },
          },
          priority: 100,
        },
        {
          pluginId: "mutator",
          result: {
            params: { source: "mutator", safe: false },
          },
          priority: 50,
        },
      ],
      expected: {
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
          pluginId: "approver",
        },
        params: { source: "approver", safe: true },
      },
    },
    {
      name: "still allows block=true from a lower-priority plugin after requireApproval",
      hooks: [
        {
          pluginId: "approver",
          result: {
            params: { source: "approver", safe: true },
            requireApproval: {
              title: "Needs approval",
              description: "Approval needed",
            },
          },
          priority: 100,
        },
        {
          pluginId: "blocker",
          result: {
            block: true,
            blockReason: "blocked",
            params: { source: "blocker", safe: false },
          },
          priority: 50,
        },
      ],
      expected: {
        block: true,
        blockReason: "blocked",
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
          pluginId: "approver",
        },
        params: { source: "approver", safe: true },
      },
    },
  ] as const)("$name", async ({ hooks, expected }) => {
    const result = await runBeforeToolCallWithHooks(registry, hooks);
    expectRequireApprovalResult(result, expected);
  });

  it("isolates direct event mutation from the caller and later handlers", async () => {
    const event: PluginHookBeforeToolCallEvent = {
      toolName: "bash",
      params: { command: "safe" },
    };
    let observedParams: Record<string, unknown> | undefined;
    addTestHook({
      registry,
      pluginId: "approver",
      hookName: "before_tool_call",
      priority: 100,
      handler: () => ({
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
        },
      }),
    });
    addTestHook({
      registry,
      pluginId: "mutator",
      hookName: "before_tool_call",
      priority: 50,
      handler: (handlerEvent: PluginHookBeforeToolCallEvent) => {
        handlerEvent.params.cwd = "/unapproved";
        return {};
      },
    });
    addTestHook({
      registry,
      pluginId: "observer",
      hookName: "before_tool_call",
      handler: (handlerEvent: PluginHookBeforeToolCallEvent) => {
        observedParams = handlerEvent.params;
        return {};
      },
    });

    await createHookRunner(registry).runBeforeToolCall(event, stubCtx);

    expect(event.params).toEqual({ command: "safe" });
    expect(observedParams).toEqual({ command: "safe" });
  });

  it("snapshots params when approval is first requested", async () => {
    const approvedParams = { command: "safe" };
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      priority: 100,
      handler: () => ({
        params: approvedParams,
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
        },
      }),
    });
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      priority: 50,
      handler: () => {
        approvedParams.command = "mutated";
        return { params: { command: "late override" } };
      },
    });

    const result = await createHookRunner(registry).runBeforeToolCall(
      { toolName: "bash", params: { command: "original" } },
      stubCtx,
    );

    expect(result?.params).toEqual({ command: "safe" });
  });

  it("fails closed when a hook event cannot be isolated", async () => {
    const handler = vi.fn().mockReturnValue({ block: true });
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      handler,
    });

    const run = createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      { toolName: "bash", params: { callback: () => undefined } },
      stubCtx,
    );

    await expect(run).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when a hook event contains shared memory", async () => {
    const handler = vi.fn().mockReturnValue({});
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      handler,
    });
    const shared = new SharedArrayBuffer(4);

    const run = createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      { toolName: "bash", params: { shared: new Uint8Array(shared) } },
      stubCtx,
    );

    await expect(run).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when shared memory is hidden in Error.cause", async () => {
    const handler = vi.fn().mockReturnValue({});
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      handler,
    });
    const error = new Error("shared", {
      cause: new Uint8Array(new SharedArrayBuffer(4)),
    });

    const run = createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      { toolName: "bash", params: { error } },
      stubCtx,
    );

    await expect(run).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when a hook event contains shared WebAssembly memory", async () => {
    const handler = vi.fn().mockReturnValue({});
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      handler,
    });
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });

    const run = createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      { toolName: "bash", params: { memory } },
      stubCtx,
    );

    await expect(run).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke overridden collection iterators during isolation", async () => {
    class HostileMap extends Map {
      override [Symbol.iterator](): MapIterator<[unknown, unknown]> {
        throw new Error("must not call overridden map iterator");
      }
    }
    class HostileSet extends Set {
      override [Symbol.iterator](): SetIterator<unknown> {
        throw new Error("must not call overridden set iterator");
      }
    }
    const map = new HostileMap();
    const set = new HostileSet();
    Map.prototype.set.call(map, "key", "value");
    Set.prototype.add.call(set, "value");
    const handler = vi.fn().mockReturnValue({});
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      handler,
    });

    await createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      {
        toolName: "bash",
        params: {
          map,
          set,
        },
      },
      stubCtx,
    );

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]?.[0];
    expect(event.params.map).toEqual(new Map([["key", "value"]]));
    expect(event.params.set).toEqual(new Set(["value"]));
  });

  it("does not enumerate typed-array elements during isolation", async () => {
    const bytes = new Uint8Array(1024 * 1024);
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    const handler = vi.fn().mockReturnValue({});
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      handler,
    });

    await createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      { toolName: "bash", params: { bytes } },
      stubCtx,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(ownKeys.mock.calls.some(([value]) => ArrayBuffer.isView(value))).toBe(false);
  });

  it("fails closed when approved params cannot be snapshotted", async () => {
    const lowerPriorityHook = vi.fn().mockReturnValue({});
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "before_tool_call",
      priority: 100,
      handler: () => ({
        params: { callback: () => undefined },
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
        },
      }),
    });
    addTestHook({
      registry,
      pluginId: "observer",
      hookName: "before_tool_call",
      handler: lowerPriorityHook,
    });

    const run = createHookRunner(registry, { catchErrors: true }).runBeforeToolCall(
      { toolName: "bash", params: { command: "safe" } },
      stubCtx,
    );

    await expect(run).rejects.toThrow("before_tool_call mutable input isolation failed");
    expect(lowerPriorityHook).not.toHaveBeenCalled();
  });
});

describe("before_tool_call execution receipts", () => {
  it.each([
    {
      name: "records an allowing hook gate",
      result: { params: { approved: true } },
      expectedOutcome: "allowed",
      expectedReason: "plugin_hook_allowed",
    },
    {
      name: "records a blocking hook gate",
      result: { block: true, blockReason: "policy denied" },
      expectedOutcome: "denied",
      expectedReason: "plugin_hook_blocked",
    },
  ] as const)("$name", async ({ result, expectedOutcome, expectedReason }) => {
    const registry = createEmptyPluginRegistry();
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [{ pluginId: "secret-plugin-id", result }],
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await createHookRunner(registry).runBeforeToolCall(
        { toolName: "secret-tool-name", params: {} },
        { ...stubCtx, toolName: "secret-tool-name" },
        {
          token: createExecutionIdentityAdmissionToken("run-hook", {
            contextId: "context-hook",
            executionId: "execution-hook",
            now: 100,
          }),
          assertAuthority: () => true,
        },
      );
    } finally {
      clear();
    }
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      action: { family: "plugin", operation: "before_tool_call" },
      decision: { outcome: expectedOutcome, reasonCode: expectedReason },
      enforcement: { coverageState: "enforced" },
      source: { owner: "plugin-hook" },
    });
    expect(JSON.stringify(receipts)).not.toContain("secret-plugin-id");
    expect(JSON.stringify(receipts)).not.toContain("secret-tool-name");
  });

  it.each([
    {
      name: "records a caught hook failure as fail open",
      failurePolicy: undefined,
      sharedMemory: false,
      rejects: false,
      expectedOutcome: "unknown",
      expectedCoverage: "unknown",
      expectedReason: "plugin_hook_failed_open",
    },
    {
      name: "records a configured hook failure as fail closed",
      failurePolicy: "fail-closed",
      sharedMemory: false,
      rejects: true,
      expectedOutcome: "denied",
      expectedCoverage: "enforced",
      expectedReason: "plugin_hook_failed_closed",
    },
    {
      name: "records an isolation failure as fail closed",
      failurePolicy: undefined,
      sharedMemory: true,
      rejects: true,
      expectedOutcome: "denied",
      expectedCoverage: "enforced",
      expectedReason: "plugin_hook_failed_closed",
    },
  ] as const)(
    "$name",
    async ({
      failurePolicy,
      sharedMemory,
      rejects,
      expectedOutcome,
      expectedCoverage,
      expectedReason,
    }) => {
      const registry = createEmptyPluginRegistry();
      const handler = vi.fn(() => {
        if (sharedMemory) {
          return {};
        }
        throw new Error("credential=must-not-leak");
      });
      addTestHook({
        registry,
        pluginId: "failing-plugin",
        hookName: "before_tool_call",
        handler,
      });
      const receipts: DecisionReceiptV1[] = [];
      const clear = configureRuntimeActionDecisionSink((receipt) => {
        receipts.push(receipt);
        return true;
      });
      try {
        const run = createHookRunner(registry, {
          ...(failurePolicy
            ? { failurePolicyByHook: { before_tool_call: failurePolicy } }
            : undefined),
        }).runBeforeToolCall(
          {
            toolName: "bash",
            params: sharedMemory ? { shared: new Uint8Array(new SharedArrayBuffer(4)) } : {},
          },
          stubCtx,
          {
            token: createExecutionIdentityAdmissionToken("run-hook-failure", {
              contextId: "context-hook-failure",
              executionId: "execution-hook-failure",
              now: 100,
            }),
            assertAuthority: () => true,
          },
        );
        if (rejects) {
          await expect(run).rejects.toThrow(
            sharedMemory
              ? "before_tool_call mutable input isolation failed"
              : "before_tool_call handler from failing-plugin failed",
          );
        } else {
          await expect(run).resolves.toBeUndefined();
        }
      } finally {
        clear();
      }
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        decision: { outcome: expectedOutcome, reasonCode: expectedReason },
        enforcement: { coverageState: expectedCoverage },
      });
      expect(JSON.stringify(receipts)).not.toContain("must-not-leak");
      expect(handler).toHaveBeenCalledTimes(sharedMemory ? 0 : 1);
    },
  );

  it.each([
    { settlement: "resolve", authority: "reports stale" },
    { settlement: "resolve", authority: "throws" },
    { settlement: "reject", authority: "reports stale" },
    { settlement: "reject", authority: "throws" },
  ] as const)(
    "suppresses a deferred $settlement receipt when authority $authority",
    async ({ settlement, authority }) => {
      const registry = createEmptyPluginRegistry();
      let settle: ((value: PluginHookBeforeToolCallResult) => void) | undefined;
      let reject: ((error: Error) => void) | undefined;
      const pending = new Promise<PluginHookBeforeToolCallResult>((resolve, rejectPromise) => {
        settle = resolve;
        reject = rejectPromise;
      });
      addTestHook({
        registry,
        pluginId: "deferred-plugin",
        hookName: "before_tool_call",
        handler: () => pending,
      });
      const receipts: DecisionReceiptV1[] = [];
      const clear = configureRuntimeActionDecisionSink((receipt) => {
        receipts.push(receipt);
        return true;
      });
      try {
        const run = createHookRunner(registry, {
          failurePolicyByHook: { before_tool_call: "fail-closed" },
        }).runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx, {
          token: createExecutionIdentityAdmissionToken("run-hook-stale"),
          assertAuthority: () => {
            if (authority === "throws") {
              throw new Error("stale receipt authority");
            }
            return false;
          },
        });
        if (settlement === "resolve") {
          settle?.({});
          await expect(run).resolves.toEqual({});
        } else {
          reject?.(new Error("deferred hook failure"));
          await expect(run).rejects.toThrow("deferred-plugin failed");
        }
      } finally {
        clear();
      }
      expect(receipts).toEqual([]);
    },
  );
});

describe("before_tool_call matcher scoping", () => {
  it("skips uncovered tools and executes a canonical matcher once", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(() => ({ block: true, blockReason: "covered" }));
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [
        {
          pluginId: "shell-policy",
          matcher: ["exec"],
          result: { block: true, blockReason: "covered" },
          handler,
        },
      ],
    });
    const runner = createHookRunner(registry);

    await expect(
      runner.runBeforeToolCall(
        { toolName: "web_search", params: {} },
        { ...stubCtx, toolName: "web_search" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      runner.runBeforeToolCall({ toolName: "exec", params: {} }, { ...stubCtx, toolName: "exec" }),
    ).resolves.toMatchObject({ block: true, blockReason: "covered" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects Codex matcher aliases instead of making them globally special", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(() => ({ block: true }));
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [{ pluginId: "codex-spelling", matcher: ["Agent"], result: { block: true }, handler }],
    });

    await expect(
      createHookRunner(registry).runBeforeToolCall(
        { toolName: "spawn_agent", params: {} },
        { ...stubCtx, toolName: "spawn_agent" },
      ),
    ).rejects.toThrow("tool hook matcher entries must use canonical OpenClaw tool ids");
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps an omitted matcher as match-all", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(() => ({ block: true }));
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [{ pluginId: "legacy-policy", result: { block: true }, handler }],
    });

    await createHookRunner(registry).runBeforeToolCall(
      { toolName: "web_search", params: {} },
      { ...stubCtx, toolName: "web_search" },
    );
    expect(handler).toHaveBeenCalledOnce();
  });
});
