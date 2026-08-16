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

    it("skips timed-out handlers and continues", async () => {
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

        await expect(resultPromise).resolves.toEqual({ prependContext: "fast" });
        expect(logger.error).toHaveBeenCalledWith(
          "[hooks] before_prompt_build handler from slow-plugin failed: timed out after 5ms",
        );
      } finally {
        vi.useRealTimers();
      }
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
