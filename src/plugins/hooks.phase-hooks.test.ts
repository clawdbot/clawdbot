/** Tests phase-scoped plugin hooks and hook registration ordering. */
import { beforeEach, describe, expect, it } from "vitest";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy.js";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "./types.js";

describe("phase hooks merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  async function runPhaseHook(params: {
    hookName: "before_model_resolve" | "before_prompt_build";
    hooks: ReadonlyArray<{
      pluginId: string;
      result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
      priority?: number;
    }>;
  }) {
    addStaticTestHooks(registry, {
      hookName: params.hookName,
      hooks: [...params.hooks],
    });
    const runner = createHookRunner(registry);
    if (params.hookName === "before_model_resolve") {
      return await runner.runBeforeModelResolve({ prompt: "test" }, {});
    }
    return await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});
  }

  async function expectPhaseHookMerge(params: {
    hookName: "before_model_resolve" | "before_prompt_build";
    hooks: ReadonlyArray<{
      pluginId: string;
      result: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
      priority?: number;
    }>;
    expected: PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult;
  }) {
    const result = await runPhaseHook(params);
    expect(result).toStrictEqual(params.expected);
  }

  it.each([
    {
      name: "before_model_resolve keeps higher-priority override values",
      hookName: "before_model_resolve" as const,
      hooks: [
        { pluginId: "low", result: { modelOverride: "demo-low-priority-model" }, priority: 1 },
        {
          pluginId: "high",
          result: {
            modelOverride: "demo-high-priority-model",
            providerOverride: "demo-provider",
          },
          priority: 10,
        },
      ],
      expected: {
        modelOverride: "demo-high-priority-model",
        providerOverride: "demo-provider",
      },
    },
    {
      name: "before_prompt_build concatenates prependContext and preserves systemPrompt precedence",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "high",
          result: { prependContext: "context A", systemPrompt: "system A" },
          priority: 10,
        },
        {
          pluginId: "low",
          result: { prependContext: "context B", systemPrompt: "system B" },
          priority: 1,
        },
      ],
      expected: {
        prependContext: "context A\n\ncontext B",
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        systemPrompt: "system A",
      },
    },
    {
      name: "before_prompt_build concatenates prependSystemContext and appendSystemContext",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "first",
          result: {
            prependSystemContext: "prepend A",
            appendSystemContext: "append A",
          },
          priority: 10,
        },
        {
          pluginId: "second",
          result: {
            prependSystemContext: "prepend B",
            appendSystemContext: "append B",
          },
          priority: 1,
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: "prepend A\n\nprepend B",
        appendSystemContext: "append A\n\nappend B",
      },
    },
    {
      name: "before_prompt_build intersects tool restrictions from every hook",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "high",
          result: { toolsAllow: ["group:fs", "web_*"] as string[] },
          priority: 10,
        },
        {
          pluginId: "low",
          result: { toolsAllow: ["read", "web_search"] as string[] },
          priority: 1,
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        toolsAllow: ["read", "web_search"],
      },
    },
    {
      name: "before_prompt_build keeps an explicit empty restriction",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "high",
          result: { toolsAllow: [] as string[] },
          priority: 10,
        },
        {
          pluginId: "low",
          result: { toolsAllow: ["read"] as string[] },
          priority: 1,
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        toolsAllow: [],
      },
    },
    {
      name: "before_prompt_build fails closed for malformed tool restrictions",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "invalid",
          result: { toolsAllow: null as unknown as string[] },
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        toolsAllow: [],
      },
    },
    {
      name: "before_prompt_build rejects mixed-type tool restrictions",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "invalid",
          result: { toolsAllow: ["*", null] as unknown as string[] },
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        toolsAllow: [],
      },
    },
  ] as const)("$name", async ({ hookName, hooks, expected }) => {
    await expectPhaseHookMerge({ hookName, hooks, expected });
  });

  it("accepts a frozen toolsAllow returned by a plugin", async () => {
    const result = await runPhaseHook({
      hookName: "before_prompt_build",
      hooks: [
        {
          pluginId: "frozen",
          result: { toolsAllow: Object.freeze(["read"]) as unknown as string[] },
        },
      ],
    });

    expect(result).toMatchObject({ toolsAllow: ["read"] });
  });

  it("preserves overlapping glob restrictions for concrete-surface evaluation", async () => {
    const result = await runPhaseHook({
      hookName: "before_prompt_build",
      hooks: [
        { pluginId: "prefix", result: { toolsAllow: ["web_*"] } },
        { pluginId: "suffix", result: { toolsAllow: ["*_search"] } },
      ],
    });
    const toolsAllow = (result as PluginHookBeforePromptBuildResult | undefined)?.toolsAllow;

    expect(toolsAllow).toBeDefined();
    expect(readToolAllowlistIntersection(toolsAllow ?? [])).toEqual([["web_*"], ["*_search"]]);
    expect(
      applyEmbeddedAttemptToolsAllow(
        [{ name: "web_search" }, { name: "web_fetch" }, { name: "memory_search" }],
        toolsAllow,
      ),
    ).toEqual([{ name: "web_search" }]);
  });
});
