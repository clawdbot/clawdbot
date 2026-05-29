import { describe, expect, it, vi } from "vitest";
import { createHooksBridge, type CopilotHooksConfig } from "./hooks-bridge.js";

describe("createHooksBridge", () => {
  it("returns undefined when no config is provided", () => {
    expect(createHooksBridge()).toBeUndefined();
  });

  it("returns undefined when config has no handlers", () => {
    expect(createHooksBridge({})).toBeUndefined();
  });

  it("returns undefined when only onHookError is supplied (no real handlers)", () => {
    expect(createHooksBridge({ onHookError: () => undefined })).toBeUndefined();
  });

  it("includes only the handlers that were configured", () => {
    const onPreToolUse = vi.fn();
    const onSessionStart = vi.fn();
    const hooks = createHooksBridge({ onPreToolUse, onSessionStart })!;
    expect(hooks).toBeDefined();
    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(hooks.onPostToolUse).toBeUndefined();
    expect(hooks.onUserPromptSubmitted).toBeUndefined();
    expect(hooks.onSessionEnd).toBeUndefined();
    expect(hooks.onErrorOccurred).toBeUndefined();
  });

  it("forwards arguments and return values from a successful handler", async () => {
    const onPreToolUse = vi
      .fn()
      .mockResolvedValue({ permissionDecision: "allow" as const, additionalContext: "ok" });
    const hooks = createHooksBridge({ onPreToolUse })!;
    const input = { timestamp: 1, cwd: "/tmp", toolName: "bash", toolArgs: { cmd: "ls" } };
    const result = await hooks.onPreToolUse!(input, { sessionId: "sess-1" });
    expect(result).toEqual({ permissionDecision: "allow", additionalContext: "ok" });
    expect(onPreToolUse).toHaveBeenCalledTimes(1);
    expect(onPreToolUse).toHaveBeenCalledWith(input, { sessionId: "sess-1" });
  });

  it("isolates synchronous throws: returns undefined and notifies onHookError", async () => {
    const onHookError = vi.fn();
    const hooks = createHooksBridge({
      onPostToolUse: () => {
        throw new Error("post boom");
      },
      onHookError,
    })!;
    const result = await hooks.onPostToolUse!(
      { timestamp: 1, cwd: "/", toolName: "x", toolArgs: {}, toolResult: {} as never },
      { sessionId: "s" },
    );
    expect(result).toBeUndefined();
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]?.[0]).toEqual({
      hookName: "onPostToolUse",
      error: expect.any(Error),
    });
    expect((onHookError.mock.calls[0]?.[0]?.error as Error).message).toBe("post boom");
  });

  it("isolates async rejections: returns undefined and notifies onHookError", async () => {
    const onHookError = vi.fn();
    const hooks = createHooksBridge({
      onUserPromptSubmitted: async () => {
        throw new Error("async boom");
      },
      onHookError,
    })!;
    const result = await hooks.onUserPromptSubmitted!(
      { timestamp: 1, cwd: "/", prompt: "hi" },
      { sessionId: "s" },
    );
    expect(result).toBeUndefined();
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]?.[0]?.hookName).toBe("onUserPromptSubmitted");
  });

  it("uses console.warn as the default onHookError", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const hooks = createHooksBridge({
        onErrorOccurred: () => {
          throw new Error("default-error-handler");
        },
      })!;
      const result = await hooks.onErrorOccurred!(
        { timestamp: 1, cwd: "/", error: "x", errorContext: "system", recoverable: true },
        { sessionId: "s" },
      );
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("onErrorOccurred");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never throws when onHookError itself throws", async () => {
    const hooks = createHooksBridge({
      onSessionEnd: () => {
        throw new Error("hook boom");
      },
      onHookError: () => {
        throw new Error("notifier boom");
      },
    })!;
    await expect(
      hooks.onSessionEnd!({ timestamp: 1, cwd: "/", reason: "complete" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
  });

  it("preserves all six SDK hook handlers when supplied", async () => {
    const config: CopilotHooksConfig = {
      onPreToolUse: vi.fn().mockResolvedValue({ suppressOutput: true }),
      onPostToolUse: vi.fn().mockResolvedValue({ suppressOutput: false }),
      onUserPromptSubmitted: vi.fn().mockResolvedValue({ modifiedPrompt: "trimmed" }),
      onSessionStart: vi.fn().mockResolvedValue({ additionalContext: "context" }),
      onSessionEnd: vi.fn().mockResolvedValue({ sessionSummary: "done" }),
      onErrorOccurred: vi.fn().mockResolvedValue({ errorHandling: "retry" as const }),
    };
    const hooks = createHooksBridge(config)!;
    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onPostToolUse).toBe("function");
    expect(typeof hooks.onUserPromptSubmitted).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(typeof hooks.onSessionEnd).toBe("function");
    expect(typeof hooks.onErrorOccurred).toBe("function");
  });

  it("forwards void returns transparently", async () => {
    const hooks = createHooksBridge({
      onSessionStart: () => undefined,
    })!;
    const result = await hooks.onSessionStart!(
      { timestamp: 1, cwd: "/", source: "new" },
      { sessionId: "s" },
    );
    expect(result).toBeUndefined();
  });

  it("does not invoke unconfigured handlers' isolators", () => {
    const hooks = createHooksBridge({ onPreToolUse: () => undefined })!;
    // ensure the missing handlers are literally absent, not just nullable
    expect("onPostToolUse" in hooks).toBe(false);
    expect("onUserPromptSubmitted" in hooks).toBe(false);
  });
});
