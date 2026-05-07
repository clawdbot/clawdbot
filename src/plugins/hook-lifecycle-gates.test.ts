import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookRegistration, PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";

function makeRegistry(hooks: PluginHookRegistration[] = []): GlobalHookRunnerRegistry {
  return {
    hooks: [],
    typedHooks: hooks,
    plugins: [],
  };
}

const ctx: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "sid-1",
};

describe("before_agent_run hook", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry());
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result).toBeUndefined();
  });

  it("returns pass when handler returns pass", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async () => ({ outcome: "pass" as const }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result?.decision).toEqual({ outcome: "pass" });
    expect(result?.pluginId).toBe("test");
  });

  it("returns block when handler returns block (with `message`)", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async () => ({
          outcome: "block" as const,
          reason: "unsafe content",
          message: "I can't process that.",
          category: "violence",
        }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "bad stuff", messages: [] }, ctx);
    expect(result?.decision.outcome).toBe("block");
    if (result?.decision.outcome === "block") {
      expect(result.decision.reason).toBe("unsafe content");
      expect(result.decision.message).toBe("I can't process that.");
    }
  });

  it("blocks when one of multiple handlers passes and a later handler blocks", async () => {
    const calls: string[] = [];
    const passHandler = vi.fn(async () => {
      calls.push("pass-plugin");
      return { outcome: "pass" as const };
    });
    const blockHandler = vi.fn(async () => {
      calls.push("block-plugin");
      return {
        outcome: "block" as const,
        reason: "blocked",
      };
    });
    const registry = makeRegistry([
      {
        pluginId: "pass-plugin",
        hookName: "before_agent_run",
        handler: passHandler,
        source: "test",
        priority: 10,
      },
      {
        pluginId: "block-plugin",
        hookName: "before_agent_run",
        handler: blockHandler,
        source: "test",
        priority: 5,
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);

    expect(result?.decision.outcome).toBe("block");
    expect(result?.pluginId).toBe("block-plugin");
    expect(passHandler).toHaveBeenCalledTimes(1);
    expect(blockHandler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["pass-plugin", "block-plugin"]);
  });

  it("short-circuits when the first of multiple handlers blocks", async () => {
    const blockHandler = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "blocked",
    }));
    const passHandler = vi.fn(async () => ({ outcome: "pass" as const }));
    const registry = makeRegistry([
      {
        pluginId: "block-plugin",
        hookName: "before_agent_run",
        handler: blockHandler,
        source: "test",
        priority: 10,
      },
      {
        pluginId: "pass-plugin",
        hookName: "before_agent_run",
        handler: passHandler,
        source: "test",
        priority: 5,
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);

    expect(result?.decision.outcome).toBe("block");
    expect(result?.pluginId).toBe("block-plugin");
    expect(blockHandler).toHaveBeenCalledTimes(1);
    expect(passHandler).not.toHaveBeenCalled();
  });

  it("treats void handler returns as pass (no effect)", async () => {
    const registry = makeRegistry([
      {
        pluginId: "void-plugin",
        hookName: "before_agent_run",
        handler: async () => undefined,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    // void => undefined result (no decision)
    expect(result).toBeUndefined();
  });

  it("fails closed on invalid handler results", async () => {
    const registry = makeRegistry([
      {
        pluginId: "invalid-plugin",
        hookName: "before_agent_run",
        handler: async () => ({ block: true }) as never,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result).toEqual({
      decision: {
        outcome: "block",
        reason: "before_agent_run returned an invalid decision",
      },
      pluginId: "invalid-plugin",
    });
  });

  it("fails closed on null handler results", async () => {
    const registry = makeRegistry([
      {
        pluginId: "null-plugin",
        hookName: "before_agent_run",
        handler: async () => null as never,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result).toEqual({
      decision: {
        outcome: "block",
        reason: "before_agent_run returned an invalid decision",
      },
      pluginId: "null-plugin",
    });
  });

  it("fails closed on malformed block decisions", async () => {
    const registry = makeRegistry([
      {
        pluginId: "malformed-block-plugin",
        hookName: "before_agent_run",
        handler: async () => ({ outcome: "block" }) as never,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result).toEqual({
      decision: {
        outcome: "block",
        reason: "before_agent_run returned an invalid decision",
      },
      pluginId: "malformed-block-plugin",
    });
  });

  it("fails closed when handlers throw", async () => {
    const registry = makeRegistry([
      {
        pluginId: "throwing-plugin",
        hookName: "before_agent_run",
        handler: async () => {
          throw new Error("policy unavailable");
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await expect(runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx)).rejects.toThrow(
      "before_agent_run handler from throwing-plugin failed: policy unavailable",
    );
  });

  it("fails closed when handlers exceed the default timeout", async () => {
    vi.useFakeTimers();
    const registry = makeRegistry([
      {
        pluginId: "hanging-plugin",
        hookName: "before_agent_run",
        handler: async () => await new Promise<never>(() => {}),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const resultPromise = runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    const rejection = expect(resultPromise).rejects.toThrow(
      "before_agent_run handler from hanging-plugin failed: timed out after 15000ms",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it("receives the correct event payload", async () => {
    let receivedEvent: unknown;
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async (event: unknown) => {
          receivedEvent = event;
          return { outcome: "pass" as const };
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await runner.runBeforeAgentRun(
      {
        prompt: "hello world",
        messages: [{ role: "user", content: "hello" }],
        channelId: "discord",
        senderId: "user-123",
        senderIsOwner: true,
      },
      ctx,
    );
    const event = receivedEvent as Record<string, unknown>;
    expect(event.prompt).toBe("hello world");
    expect(event.channelId).toBe("discord");
    expect(event.senderId).toBe("user-123");
    expect(event.senderIsOwner).toBe(true);
  });
});

describe("before_agent_run invalid ask outcome", () => {
  it("fails closed when handler returns ask", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_agent_run",
        handler: async () =>
          ({
            outcome: "ask",
            reason: "needs approval",
            title: "Review Required",
            description: "This prompt requires human review.",
          }) as never,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result?.decision).toEqual({
      outcome: "block",
      reason: "before_agent_run returned an invalid decision",
    });
    expect(result?.pluginId).toBe("test");
  });

  it("short-circuits unsupported ask decisions", async () => {
    let secondHandlerCalled = false;
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        hookName: "before_agent_run",
        handler: async () =>
          ({
            outcome: "ask" as const,
            reason: "check",
            title: "Check",
            description: "Check this.",
          }) as never,
        source: "test",
        priority: 10,
      },
      {
        pluginId: "plugin-b",
        hookName: "before_agent_run",
        handler: async () => {
          secondHandlerCalled = true;
          return { outcome: "pass" as const };
        },
        source: "test",
        priority: 5,
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result?.decision.outcome).toBe("block");
    expect(result?.pluginId).toBe("plugin-a");
    expect(secondHandlerCalled).toBe(false);
  });
});

describe("before_tool_call channelId forwarding", () => {
  it("passes channelId through to before_tool_call handlers", async () => {
    let receivedCtx: unknown;
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_tool_call",
        handler: async (_event: unknown, ctx: unknown) => {
          receivedCtx = ctx;
          return undefined;
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await runner.runBeforeToolCall(
      { toolName: "exec", params: {} },
      { toolName: "exec", channelId: "discord", sessionKey: "s1" },
    );
    expect((receivedCtx as { channelId?: string }).channelId).toBe("discord");
  });
});
