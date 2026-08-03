// Copilot tests cover native SDK hook compatibility.
import { describe, expect, it, vi } from "vitest";
import { createHooksBridge, type CopilotHooksConfig } from "./hooks-bridge.js";

describe("createHooksBridge", () => {
  const hookBase = {
    sessionId: "runtime-session",
    timestamp: new Date(0),
    cwd: "/",
    workingDirectory: "/",
  };

  it("returns undefined when no handlers are configured", () => {
    expect(createHooksBridge()).toBeUndefined();
    expect(createHooksBridge({})).toBeUndefined();
    expect(createHooksBridge({ onHookError: () => undefined })).toBeUndefined();
  });

  it("includes only configured native handlers", () => {
    const hooks = createHooksBridge({
      onPreToolUse: vi.fn(),
      onSessionStart: vi.fn(),
    })!;

    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(hooks.onPreMcpToolCall).toBeUndefined();
    expect(hooks.onPostToolUse).toBeUndefined();
    expect(hooks.onPostToolUseFailure).toBeUndefined();
    expect(hooks.onUserPromptSubmitted).toBeUndefined();
    expect(hooks.onSessionEnd).toBeUndefined();
    expect(hooks.onErrorOccurred).toBeUndefined();
  });

  it("forwards arguments and return values from a successful handler", async () => {
    const onPreToolUse = vi
      .fn()
      .mockResolvedValue({ permissionDecision: "allow" as const, additionalContext: "ok" });
    const hooks = createHooksBridge({ onPreToolUse })!;
    const input = {
      ...hookBase,
      cwd: "/tmp",
      workingDirectory: "/tmp",
      toolName: "bash",
      toolArgs: { cmd: "ls" },
    };

    await expect(hooks.onPreToolUse!(input, { sessionId: "sess-1" })).resolves.toEqual({
      permissionDecision: "allow",
      additionalContext: "ok",
    });
    expect(onPreToolUse).toHaveBeenCalledWith(input, { sessionId: "sess-1" });
  });

  it("reports the effective prompt after a native prompt hook completes", async () => {
    const onUserPromptSubmitted = vi.fn().mockResolvedValue({
      additionalContext: "Use the approved repository.",
      modifiedPrompt: "Review the authentication change.",
    });
    const observedPrompt = vi.fn();
    const hooks = createHooksBridge(
      { onUserPromptSubmitted },
      { onUserPromptSubmitted: observedPrompt },
    )!;

    await expect(
      hooks.onUserPromptSubmitted!({ ...hookBase, prompt: "hello" }, { sessionId: "s" }),
    ).resolves.toEqual({
      additionalContext: "Use the approved repository.",
      modifiedPrompt: "Review the authentication change.",
    });
    expect(observedPrompt).toHaveBeenCalledWith({
      additionalContext: "Use the approved repository.",
      prompt: "Review the authentication change.",
    });
  });

  it("reports the original prompt when a native prompt hook fails", async () => {
    const observedPrompt = vi.fn();
    const hooks = createHooksBridge(
      {
        onUserPromptSubmitted: async () => {
          throw new Error("prompt hook failed");
        },
        onHookError: () => undefined,
      },
      { onUserPromptSubmitted: observedPrompt },
    )!;

    await expect(
      hooks.onUserPromptSubmitted!({ ...hookBase, prompt: "hello" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
    expect(observedPrompt).toHaveBeenCalledWith({ prompt: "hello" });
  });

  it("isolates synchronous and asynchronous handler failures", async () => {
    const onHookError = vi.fn();
    const hooks = createHooksBridge({
      onPostToolUse: () => {
        throw new Error("post boom");
      },
      onUserPromptSubmitted: async () => {
        throw new Error("prompt boom");
      },
      onHookError,
    })!;

    await expect(
      hooks.onPostToolUse!(
        { ...hookBase, toolName: "x", toolArgs: {}, toolResult: {} as never },
        { sessionId: "s" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks.onUserPromptSubmitted!({ ...hookBase, prompt: "hi" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
    expect(onHookError).toHaveBeenCalledTimes(2);
  });

  it("never lets the error notifier throw into the SDK", async () => {
    const hooks = createHooksBridge({
      onSessionEnd: () => {
        throw new Error("hook boom");
      },
      onHookError: () => {
        throw new Error("notifier boom");
      },
    })!;

    await expect(
      hooks.onSessionEnd!({ ...hookBase, reason: "complete" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
  });

  it("preserves native MCP and failed-tool callbacks", async () => {
    const onPreMcpToolCall = vi.fn();
    const onPostToolUseFailure = vi.fn();
    const hooks = createHooksBridge({
      onPreMcpToolCall,
      onPostToolUseFailure,
    })!;

    await hooks.onPreMcpToolCall!({} as never, { sessionId: "s" });
    await hooks.onPostToolUseFailure!({} as never, { sessionId: "s" });

    expect(onPreMcpToolCall).toHaveBeenCalledTimes(1);
    expect(onPostToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("preserves all supported SDK hook handlers", () => {
    const config: CopilotHooksConfig = {
      onPreToolUse: vi.fn().mockResolvedValue({ suppressOutput: true }),
      onPreMcpToolCall: vi.fn(),
      onPostToolUse: vi.fn().mockResolvedValue({ suppressOutput: false }),
      onPostToolUseFailure: vi.fn(),
      onUserPromptSubmitted: vi.fn().mockResolvedValue({ modifiedPrompt: "trimmed" }),
      onSessionStart: vi.fn().mockResolvedValue({ additionalContext: "context" }),
      onSessionEnd: vi.fn().mockResolvedValue({ sessionSummary: "done" }),
      onErrorOccurred: vi.fn().mockResolvedValue({ errorHandling: "retry" as const }),
    };
    const hooks = createHooksBridge(config)!;

    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onPreMcpToolCall).toBe("function");
    expect(typeof hooks.onPostToolUse).toBe("function");
    expect(typeof hooks.onPostToolUseFailure).toBe("function");
    expect(typeof hooks.onUserPromptSubmitted).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(typeof hooks.onSessionEnd).toBe("function");
    expect(typeof hooks.onErrorOccurred).toBe("function");
  });
});
