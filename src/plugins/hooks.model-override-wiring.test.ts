/**
 * Layer 2: Explicit model/prompt hook wiring tests.
 *
 * Verifies:
 * 1. before_model_resolve applies deterministic provider/model overrides
 * 2. before_prompt_build receives session messages and prepends prompt context
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

function addBeforeModelResolveHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforeModelResolveResult | Promise<PluginHookBeforeModelResolveResult>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_model_resolve",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

function addBeforePromptBuildHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforePromptBuildResult | Promise<PluginHookBeforePromptBuildResult>,
  priority?: number,
  timeoutMs?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_prompt_build",
    handler: handler as PluginHookRegistration["handler"],
    priority,
    timeoutMs,
  });
}

const stubCtx: PluginHookAgentContext = TEST_PLUGIN_AGENT_CTX;

describe("model override pipeline wiring", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  async function runPromptBuildWithMessages(messages: unknown[]) {
    const runner = createHookRunner(registry);
    return await runner.runBeforePromptBuild({ prompt: "test", messages }, stubCtx);
  }

  async function expectBeforeModelResolve(params: {
    event: PluginHookBeforeModelResolveEvent;
    expected: PluginHookBeforeModelResolveResult;
    withBrokenHook?: boolean;
    catchErrors?: boolean;
  }) {
    const handlerSpy = vi.fn(
      (_eventValue: PluginHookBeforeModelResolveEvent) =>
        ({
          modelOverride: "demo-local-model",
          providerOverride: "demo-local-provider",
        }) as PluginHookBeforeModelResolveResult,
    );

    if (params.withBrokenHook) {
      addBeforeModelResolveHook(
        registry,
        "broken-plugin",
        () => {
          throw new Error("plugin crashed");
        },
        10,
      );
    }
    addBeforeModelResolveHook(registry, "router-plugin", handlerSpy);
    const runner = createHookRunner(
      registry,
      params.catchErrors ? { catchErrors: true } : undefined,
    );
    const result = await runner.runBeforeModelResolve(params.event, stubCtx);

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(handlerSpy).toHaveBeenCalledWith(params.event, stubCtx);
    expect(result).toEqual(params.expected);
    return result;
  }

  async function expectPromptBuildPrependContext(params: {
    messages: unknown[];
    expectedPrependContext: string;
  }) {
    const handlerSpy = vi.fn(
      (event: PluginHookBeforePromptBuildEvent) =>
        ({
          prependContext: `Saw ${event.messages.length} messages`,
        }) as PluginHookBeforePromptBuildResult,
    );

    addBeforePromptBuildHook(registry, "context-plugin", handlerSpy);
    const result = await runPromptBuildWithMessages(params.messages);

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(result?.prependContext).toBe(params.expectedPrependContext);
    return result;
  }

  describe("before_model_resolve (run.ts pattern)", () => {
    it.each([
      {
        name: "hook receives prompt-only event and returns provider/model override",
        event: { prompt: "PII text" },
        expected: {
          modelOverride: "demo-local-model",
          providerOverride: "demo-local-provider",
        },
      },
      {
        name: "one broken before_model_resolve plugin does not block other overrides",
        event: { prompt: "PII data" },
        withBrokenHook: true,
        catchErrors: true,
        expected: {
          modelOverride: "demo-local-model",
          providerOverride: "demo-local-provider",
        },
      },
    ] as const)("$name", async ({ event, expected, withBrokenHook, catchErrors }) => {
      await expectBeforeModelResolve({ event, expected, withBrokenHook, catchErrors });
    });
  });

  describe("before_prompt_build (attempt.ts pattern)", () => {
    it("passes prompt and messages to context hooks", async () => {
      await expectPromptBuildPrependContext({
        messages: [{}, {}],
        expectedPrependContext: "Saw 2 messages",
      });
    });

    it("skips timed-out handlers, continues, and marks the dropped contribution", async () => {
      vi.useFakeTimers();
      try {
        addBeforePromptBuildHook(
          registry,
          "slow-plugin",
          () => new Promise<PluginHookBeforePromptBuildResult>(() => {}),
          10,
        );
        addBeforePromptBuildHook(registry, "fast-plugin", () => ({ prependContext: "fast" }), 1);
        const logger = {
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
        };
        const runner = createHookRunner(registry, {
          logger,
          modifyingHookTimeoutMsByHook: { before_prompt_build: 5 },
        });

        const resultPromise = runner.runBeforePromptBuild(
          { prompt: "test", messages: [] },
          stubCtx,
        );
        await vi.advanceTimersByTimeAsync(5);

        const result = await resultPromise;
        expect(result?.prependContext).toBe("fast");
        // A dropped contribution must be visible in the prompt, not merely logged:
        // absence alone reads to the agent as "the plugin had nothing to say".
        expect(result?.appendContext).toContain(
          '<dropped_plugin_context hook="before_prompt_build">',
        );
        expect(result?.appendContext).toContain("slow-plugin (handler-failed)");
        expect(result?.appendContext).not.toContain("fast-plugin");
        // The timeout text is a diagnostic, so it belongs in the operator log and
        // nowhere near the prompt.
        expect(result?.appendContext).not.toContain("timed out after 5ms");
        expect(logger.error).toHaveBeenCalledWith(
          "[hooks] before_prompt_build handler from slow-plugin failed: timed out after 5ms",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks the skipped chain when a nested prompt build re-enters the dispatch", async () => {
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      const runner = createHookRunner(registry, { logger });
      let nested: PluginHookBeforePromptBuildResult | undefined;
      registry.typedHooks.push({
        pluginId: "authority-only-plugin",
        hookName: "before_prompt_build",
        handler: () => ({ prependContext: "authorized" }),
        requiresToolAuthority: true,
        source: "test",
      });
      addBeforePromptBuildHook(registry, "nesting-plugin", async () => {
        // A plugin that starts an agent run from inside its own handler: the
        // nested prompt build hits the re-entrancy guard.
        nested = await runner.runBeforePromptBuild({ prompt: "nested", messages: [] }, stubCtx);
        return { prependContext: "outer" };
      });

      const outer = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, stubCtx);

      expect(outer?.prependContext).toBe("outer");
      expect(outer?.appendContext).toBeUndefined();
      expect(nested?.appendContext).toContain("nesting-plugin (nested-prompt-build)");
      expect(nested?.appendContext).not.toContain("authority-only-plugin");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[hooks] before_prompt_build skipped for a nested prompt build"),
      );
    });

    it("keeps secret-like thrown error text out of the marker and only in the log", async () => {
      const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      addBeforePromptBuildHook(registry, "leaky-plugin", () => {
        throw new Error(`bd ready failed: ${secret}`);
      });
      addBeforePromptBuildHook(registry, "healthy-plugin", () => ({ prependContext: "healthy" }));
      const runner = createHookRunner(registry, { logger });

      const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, stubCtx);

      expect(result?.prependContext).toBe("healthy");
      expect(result?.appendContext).toContain("leaky-plugin (handler-failed)");
      // The whole point of the reason-code contract: nothing error-derived can
      // cross the model/provider boundary, however the handler failed.
      expect(result?.appendContext).not.toContain(secret);
      expect(result?.appendContext).not.toContain("sk-live-9f3c");
      expect(result?.appendContext).not.toContain("internal.example");
      expect(result?.appendContext).not.toContain("bd ready failed");
      // ...while the operator still gets the diagnostic, through the log path's
      // own secret redaction (`formatHookErrorForLog` masks the token value).
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("leaky-plugin failed: bd ready failed:"),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("https://internal.example/v1/queue"),
      );
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("AUTH_TOKEN=***"));
    });

    it("caps the marker when a nested prompt build skips many registered hooks", async () => {
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      for (let index = 0; index < 30; index += 1) {
        addBeforePromptBuildHook(registry, `bulk-plugin-${index}`, () => ({}));
      }
      const runner = createHookRunner(registry, { logger });
      let nested: PluginHookBeforePromptBuildResult | undefined;
      addBeforePromptBuildHook(registry, "nesting-plugin", async () => {
        nested = await runner.runBeforePromptBuild({ prompt: "nested", messages: [] }, stubCtx);
        return {};
      });

      await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, stubCtx);

      const marker = nested?.appendContext ?? "";
      expect(marker).toContain('<dropped_plugin_context hook="before_prompt_build">');
      // 31 registered hooks were skipped; the marker names 5 and counts the rest.
      expect(marker.match(/\(nested-prompt-build\)/gu)).toHaveLength(5);
      expect(marker).toContain("+26 more");
      expect(new TextEncoder().encode(marker).length).toBeLessThanOrEqual(640);
    });

    it("honors per-hook registration timeouts over the default modifying hook timeout", async () => {
      vi.useFakeTimers();
      try {
        addBeforePromptBuildHook(
          registry,
          "active-memory",
          async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, 20);
            });
            return { prependContext: "memory context" };
          },
          10,
          30,
        );
        const logger = {
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
        };
        const runner = createHookRunner(registry, {
          logger,
          modifyingHookTimeoutMsByHook: { before_prompt_build: 5 },
        });

        const resultPromise = runner.runBeforePromptBuild(
          { prompt: "test", messages: [] },
          stubCtx,
        );
        await vi.advanceTimersByTimeAsync(20);

        await expect(resultPromise).resolves.toEqual({ prependContext: "memory context" });
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("graceful degradation + hook detection", () => {
    it("hasHooks reports model and prompt hooks independently", () => {
      const runner1 = createHookRunner(registry);
      expect(runner1.hasHooks("before_model_resolve")).toBe(false);
      expect(runner1.hasHooks("before_prompt_build")).toBe(false);

      addBeforeModelResolveHook(registry, "plugin-a", () => ({}));
      addBeforePromptBuildHook(registry, "plugin-b", () => ({}));

      const runner2 = createHookRunner(registry);
      expect(runner2.hasHooks("before_model_resolve")).toBe(true);
      expect(runner2.hasHooks("before_prompt_build")).toBe(true);
    });
  });
});
