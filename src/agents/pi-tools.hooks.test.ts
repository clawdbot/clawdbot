import { beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithHooks, type ToolHookContext } from "./pi-tools.hooks.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

// Mock the global hook runner
const mockRunBeforeToolCall = vi.fn();
const mockRunAfterToolCall = vi.fn();
const mockHasHooks = vi.fn();

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: mockHasHooks,
    runBeforeToolCall: mockRunBeforeToolCall,
    runAfterToolCall: mockRunAfterToolCall,
  }),
}));

function createMockTool(name: string, executeFn?: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    description: `Mock ${name} tool`,
    schema: {} as AnyAgentTool["schema"],
    execute:
      executeFn ??
      (async (_id: string, _params: unknown) => {
        return `result from ${name}`;
      }),
  };
}

const ctx: ToolHookContext = { agentId: "test-agent", sessionKey: "test-session" };

describe("wrapToolWithHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasHooks.mockReturnValue(false);
    mockRunBeforeToolCall.mockResolvedValue(undefined);
    mockRunAfterToolCall.mockResolvedValue(undefined);
  });

  it("should preserve tool name, description, and schema", () => {
    const tool = createMockTool("read");
    const wrapped = wrapToolWithHooks(tool, ctx);
    expect(wrapped.name).toBe("read");
    expect(wrapped.description).toBe("Mock read tool");
    expect(wrapped.schema).toBe(tool.schema);
  });

  it("should return tool unchanged if it has no execute", () => {
    const tool = { name: "noop", description: "no-op", schema: {} } as unknown as AnyAgentTool;
    const wrapped = wrapToolWithHooks(tool, ctx);
    expect(wrapped).toBe(tool);
  });

  it("should call original execute when no hooks are registered", async () => {
    const executeFn = vi.fn().mockResolvedValue("ok");
    const tool = createMockTool("read", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);

    const result = await wrapped.execute!(
      "call-1",
      { path: "/foo" },
      undefined as any,
      undefined as any,
    );
    expect(result).toBe("ok");
    expect(executeFn).toHaveBeenCalledWith("call-1", { path: "/foo" }, undefined, undefined);
  });

  it("should call before_tool_call hook before execution", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "before_tool_call");
    const callOrder: string[] = [];
    mockRunBeforeToolCall.mockImplementation(async () => {
      callOrder.push("before");
      return undefined;
    });
    const executeFn = vi.fn().mockImplementation(async () => {
      callOrder.push("execute");
      return "ok";
    });

    const tool = createMockTool("exec", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);
    await wrapped.execute!("call-1", {}, undefined as any, undefined as any);

    expect(callOrder).toEqual(["before", "execute"]);
    expect(mockRunBeforeToolCall).toHaveBeenCalledWith(
      { toolName: "exec", params: {} },
      { agentId: "test-agent", sessionKey: "test-session", toolName: "exec" },
    );
  });

  it("should block execution when before_tool_call returns block: true", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "before_tool_call");
    mockRunBeforeToolCall.mockResolvedValue({ block: true, blockReason: "Not allowed" });
    const executeFn = vi.fn();

    const tool = createMockTool("exec", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);
    const result = await wrapped.execute!("call-1", {}, undefined as any, undefined as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "[blocked] Not allowed" }],
      details: undefined,
    });
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("should use default block reason when none provided", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "before_tool_call");
    mockRunBeforeToolCall.mockResolvedValue({ block: true });

    const tool = createMockTool("exec", vi.fn());
    const wrapped = wrapToolWithHooks(tool, ctx);
    const result = await wrapped.execute!("call-1", {}, undefined as any, undefined as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "[blocked] Blocked by plugin hook" }],
      details: undefined,
    });
  });

  it("should pass modified params from before_tool_call to execute", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "before_tool_call");
    mockRunBeforeToolCall.mockResolvedValue({ params: { path: "/modified" } });
    const executeFn = vi.fn().mockResolvedValue("ok");

    const tool = createMockTool("read", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);
    await wrapped.execute!("call-1", { path: "/original" }, undefined as any, undefined as any);

    expect(executeFn).toHaveBeenCalledWith("call-1", { path: "/modified" }, undefined, undefined);
  });

  it("should call after_tool_call hook after successful execution", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "after_tool_call");
    const executeFn = vi.fn().mockResolvedValue("tool output");

    const tool = createMockTool("read", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);
    await wrapped.execute!("call-1", { path: "/foo" }, undefined as any, undefined as any);

    // Allow microtask for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRunAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        params: { path: "/foo" },
        result: "tool output",
        error: undefined,
        durationMs: expect.any(Number),
      }),
      { agentId: "test-agent", sessionKey: "test-session", toolName: "read" },
    );
  });

  it("should call after_tool_call with error when execution fails", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "after_tool_call");
    const executeFn = vi.fn().mockRejectedValue(new Error("boom"));

    const tool = createMockTool("exec", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);

    await expect(
      wrapped.execute!("call-1", {}, undefined as any, undefined as any),
    ).rejects.toThrow("boom");

    // Allow microtask for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRunAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        params: {},
        result: undefined,
        error: "boom",
        durationMs: expect.any(Number),
      }),
      { agentId: "test-agent", sessionKey: "test-session", toolName: "exec" },
    );
  });

  it("should call both before and after hooks in correct order", async () => {
    mockHasHooks.mockReturnValue(true);
    const callOrder: string[] = [];
    mockRunBeforeToolCall.mockImplementation(async () => {
      callOrder.push("before");
      return undefined;
    });
    mockRunAfterToolCall.mockImplementation(async () => {
      callOrder.push("after");
    });
    const executeFn = vi.fn().mockImplementation(async () => {
      callOrder.push("execute");
      return "ok";
    });

    const tool = createMockTool("write", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);
    await wrapped.execute!("call-1", {}, undefined as any, undefined as any);

    // Allow microtask for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));

    expect(callOrder).toEqual(["before", "execute", "after"]);
  });

  it("should not break when after_tool_call hook throws", async () => {
    mockHasHooks.mockImplementation((name: string) => name === "after_tool_call");
    mockRunAfterToolCall.mockRejectedValue(new Error("hook error"));
    const executeFn = vi.fn().mockResolvedValue("ok");

    const tool = createMockTool("read", executeFn);
    const wrapped = wrapToolWithHooks(tool, ctx);

    // Should not throw despite hook error
    const result = await wrapped.execute!("call-1", {}, undefined as any, undefined as any);
    expect(result).toBe("ok");
  });

  it("should work with empty context", async () => {
    mockHasHooks.mockReturnValue(true);
    mockRunBeforeToolCall.mockResolvedValue(undefined);
    const executeFn = vi.fn().mockResolvedValue("ok");

    const tool = createMockTool("read", executeFn);
    const wrapped = wrapToolWithHooks(tool, {});
    await wrapped.execute!("call-1", {}, undefined as any, undefined as any);

    expect(mockRunBeforeToolCall).toHaveBeenCalledWith(
      { toolName: "read", params: {} },
      { agentId: undefined, sessionKey: undefined, toolName: "read" },
    );
  });
});
