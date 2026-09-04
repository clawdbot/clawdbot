/** Tests phase-scoped plugin hooks and hook registration ordering. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy.js";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
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

  it("dispatches authorized enrichment only after the host supplies the final tool surface", async () => {
    const enrichment = vi.fn((_event, ctx) => {
      expect(ctx.toolAuthority?.allows("memory_search")).toBe(false);
      expect(ctx.toolAuthority?.allows("message")).toBe(true);
      return { prependContext: "authorized context", systemPrompt: "ignored override" };
    });
    registry.typedHooks.push(
      {
        pluginId: "restrictor",
        hookName: "before_prompt_build",
        handler: () => ({ toolsAllow: ["message"] }),
        source: "test",
      },
      {
        pluginId: "enricher",
        hookName: "before_prompt_build",
        handler: enrichment,
        requiresToolAuthority: true,
        source: "test",
      },
    );
    const runner = createHookRunner(registry);
    const event = { prompt: "test", messages: [] };

    await expect(runner.runBeforePromptBuild(event, {})).resolves.toMatchObject({
      toolsAllow: ["message"],
    });
    expect(enrichment).not.toHaveBeenCalled();

    const result = await runner.runAuthorizedPromptBuild(
      event,
      {},
      {
        toolAuthorityFingerprint: "turn-authority",
        activeToolNames: ["message"],
        assertHostActive: () => undefined,
      },
    );
    const retainedAuthority = enrichment.mock.calls[0]?.[1].toolAuthority;

    expect(result).toEqual({ prependContext: "authorized context" });
    expect(() => retainedAuthority?.assertActive()).toThrow("no longer active");
  });

  it("rejects enrichment that finishes after the host authority closes", async () => {
    let releaseEnrichment: () => void = () => {
      throw new Error("enrichment gate was not initialized");
    };
    const enrichmentGate = new Promise<void>((resolve) => {
      releaseEnrichment = resolve;
    });
    const enrichment = vi.fn(async () => {
      await enrichmentGate;
      return { prependContext: "stale authorized context" };
    });
    registry.typedHooks.push({
      pluginId: "enricher",
      hookName: "before_prompt_build",
      handler: enrichment,
      requiresToolAuthority: true,
      source: "test",
    });
    const runner = createHookRunner(registry);
    let hostActive = true;
    const run = runner.runAuthorizedPromptBuild(
      { prompt: "test", messages: [] },
      {},
      {
        toolAuthorityFingerprint: "turn-authority",
        activeToolNames: ["memory_search"],
        assertHostActive: () => {
          if (!hostActive) {
            throw new Error("host turn authority is no longer active");
          }
        },
      },
    );
    await vi.waitFor(() => {
      expect(enrichment).toHaveBeenCalledOnce();
    });

    hostActive = false;
    releaseEnrichment();

    await expect(run).rejects.toThrow("host turn authority is no longer active");
  });

  it("does not start a later authorized handler after host authority closes", async () => {
    let hostActive = true;
    const firstEnrichment = vi.fn(async () => {
      hostActive = false;
      return { prependContext: "first context" };
    });
    const laterEnrichment = vi.fn(() => ({ prependContext: "stale later context" }));
    registry.typedHooks.push(
      {
        pluginId: "first-enricher",
        hookName: "before_prompt_build",
        handler: firstEnrichment,
        requiresToolAuthority: true,
        source: "test",
      },
      {
        pluginId: "later-enricher",
        hookName: "before_prompt_build",
        handler: laterEnrichment,
        requiresToolAuthority: true,
        source: "test",
      },
    );
    const runner = createHookRunner(registry);

    await expect(
      runner.runAuthorizedPromptBuild(
        { prompt: "test", messages: [] },
        {},
        {
          toolAuthorityFingerprint: "turn-authority",
          activeToolNames: ["memory_search"],
          assertHostActive: () => {
            if (!hostActive) {
              throw new Error("host turn authority is no longer active");
            }
          },
        },
      ),
    ).rejects.toThrow("host turn authority is no longer active");
    expect(firstEnrichment).toHaveBeenCalledOnce();
    expect(laterEnrichment).not.toHaveBeenCalled();
  });
});
