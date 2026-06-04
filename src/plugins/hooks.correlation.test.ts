// Verifies correlation metadata for plugin hook execution.
import { spawnSync } from "node:child_process";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

describe("hook correlation fields", () => {
  let registry: PluginRegistry;
  let oneShotAgentEndProbe: {
    status: number | null;
    stderr: string;
    stdout: string;
  };

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("adds runId to legacy before_agent_start events from hook context", async () => {
    const handler = vi.fn(() => undefined);
    addTestHook({
      registry,
      pluginId: "plugin-a",
      hookName: "before_agent_start",
      handler: handler as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry);
    await runner.runBeforeAgentStart({ prompt: "hello" }, TEST_PLUGIN_AGENT_CTX);

    expect(handler).toHaveBeenCalledWith(
      { prompt: "hello", runId: "test-run-id" },
      TEST_PLUGIN_AGENT_CTX,
    );
  });

  it("adds runId to agent_end events from hook context", async () => {
    const handler = vi.fn(() => undefined);
    addTestHook({
      registry,
      pluginId: "plugin-a",
      hookName: "agent_end",
      handler: handler as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry);
    await runner.runAgentEnd(
      {
        messages: [],
        success: true,
      },
      TEST_PLUGIN_AGENT_CTX,
    );

    expect(handler).toHaveBeenCalledWith(
      { messages: [], success: true, runId: "test-run-id" },
      TEST_PLUGIN_AGENT_CTX,
    );
  });

  it("times out never-settling agent_end handlers", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(() => new Promise<void>(() => {}));
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "agent_end",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const runner = createHookRunner(registry, {
        logger,
        voidHookTimeoutMsByHook: { agent_end: 5 },
      });
      const run = runner.runAgentEnd({ messages: [], success: true }, TEST_PLUGIN_AGENT_CTX);

      await vi.advanceTimersByTimeAsync(5);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] agent_end handler from plugin-a failed: timed out after 5ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  beforeAll(() => {
    const script = `
      import { createHookRunner } from "./src/plugins/hooks.ts";
      const registry = {
        typedHooks: [{
          pluginId: "plugin-a",
          hookName: "agent_end",
          handler: () => new Promise(() => {}),
          priority: 0,
          source: "test",
        }],
      };
      const logger = {
        error: (message) => console.error(message),
        warn: (message) => console.warn(message),
      };
      const runner = createHookRunner(registry, {
        logger,
        voidHookTimeoutMsByHook: { agent_end: 20 },
      });
      await runner.runAgentEnd(
        { messages: [], success: true },
        {
          runId: "test-run-id",
          agentId: "test-agent",
          sessionKey: "test-session",
          sessionId: "test-session-id",
          workspaceDir: "/tmp/openclaw-test",
          messageProvider: "test",
        },
        { unrefTimeout: false },
      );
      console.log("settled-after-timeout");
    `;

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 3_000,
      },
    );
    oneShotAgentEndProbe = {
      status: child.status,
      stderr: child.stderr,
      stdout: child.stdout,
    };
  });

  it("keeps one-shot agent_end runs alive until a ref'd timeout fires", () => {
    expect(oneShotAgentEndProbe.status).toBe(0);
    expect(oneShotAgentEndProbe.stderr).toContain(
      "[hooks] agent_end handler from plugin-a failed: timed out after 20ms",
    );
    expect(oneShotAgentEndProbe.stdout).toContain("settled-after-timeout");
  });

  it("honors per-hook registration timeouts over the default void hook timeout", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          }),
      );
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "agent_end",
        handler: handler as PluginHookRegistration["handler"],
        timeoutMs: 30,
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const runner = createHookRunner(registry, {
        logger,
        voidHookTimeoutMsByHook: { agent_end: 5 },
      });
      const run = runner.runAgentEnd({ messages: [], success: true }, TEST_PLUGIN_AGENT_CTX);

      await vi.advanceTimersByTimeAsync(20);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized hook timeouts before scheduling", async () => {
    const handler = vi.fn(async () => {});
    addTestHook({
      registry,
      pluginId: "plugin-a",
      hookName: "agent_end",
      handler: handler as PluginHookRegistration["handler"],
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const runner = createHookRunner(registry);

      await runner.runAgentEnd({ messages: [], success: true }, TEST_PLUGIN_AGENT_CTX);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
