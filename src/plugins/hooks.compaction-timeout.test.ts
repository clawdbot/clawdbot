/**
 * Test: before_compaction & after_compaction void-hook default timeouts.
 *
 * Without a default budget these hooks run fully unbounded. In the codex
 * agent harness they fire on the serialized notification queue, so a hung
 * handler freezes every later codex notification — including turn/completed —
 * and the whole turn hangs. The runner seeds DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK
 * with a defensive budget for both hooks; these tests assert a never-settling
 * handler is bounded by that default rather than hanging.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

// The defensive default applied to before_compaction / after_compaction in
// DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK. Kept in sync with hooks.ts.
const DEFAULT_COMPACTION_HOOK_TIMEOUT_MS = 30_000;

describe("compaction hook default timeouts", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("bounds a never-settling before_compaction handler with the default timeout", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(() => new Promise<void>(() => {}));
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "before_compaction",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      // No voidHookTimeoutMsByHook override — relies on the built-in default.
      const runner = createHookRunner(registry, { logger });
      const run = runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX);

      await vi.advanceTimersByTimeAsync(DEFAULT_COMPACTION_HOOK_TIMEOUT_MS);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        `[hooks] before_compaction handler from plugin-a failed: timed out after ${DEFAULT_COMPACTION_HOOK_TIMEOUT_MS}ms`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-settling after_compaction handler with the default timeout", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(() => new Promise<void>(() => {}));
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "after_compaction",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const runner = createHookRunner(registry, { logger });
      const run = runner.runAfterCompaction(
        { messageCount: 2, compactedCount: 1 },
        TEST_PLUGIN_AGENT_CTX,
      );

      await vi.advanceTimersByTimeAsync(DEFAULT_COMPACTION_HOOK_TIMEOUT_MS);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        `[hooks] after_compaction handler from plugin-a failed: timed out after ${DEFAULT_COMPACTION_HOOK_TIMEOUT_MS}ms`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a fast before_compaction handler complete without timing out", async () => {
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
        hookName: "before_compaction",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const runner = createHookRunner(registry, { logger });
      const run = runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX);

      await vi.advanceTimersByTimeAsync(20);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
