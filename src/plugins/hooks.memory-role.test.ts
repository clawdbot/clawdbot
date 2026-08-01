import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookBeforePromptBuildResult, PluginHookRegistration } from "./types.js";

function addMemoryPlugin(
  registry: PluginRegistry,
  pluginId: string,
  selections: NonNullable<ReturnType<typeof createPluginRecord>["memoryRoleSelections"]>,
) {
  registry.plugins.push(
    createPluginRecord({
      id: pluginId,
      kind: "memory",
      memoryRoleSelections: selections,
    }),
  );
}

function addHook(params: {
  registry: PluginRegistry;
  pluginId: string;
  hookName: PluginHookRegistration["hookName"];
  handler: PluginHookRegistration["handler"];
  memoryRole: NonNullable<PluginHookRegistration["memoryRole"]>;
}) {
  params.registry.typedHooks.push({
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: params.handler,
    memoryRole: params.memoryRole,
    source: "test",
  } as PluginHookRegistration);
}

describe("memory-role hook enforcement", () => {
  function createRegistryWithMemoryHook(params: {
    pluginId: string;
    selections: NonNullable<ReturnType<typeof createPluginRecord>["memoryRoleSelections"]>;
    hookName: PluginHookRegistration["hookName"];
    memoryRole: NonNullable<PluginHookRegistration["memoryRole"]>;
    calls: string[];
    result?: PluginHookBeforePromptBuildResult;
  }) {
    const registry = createEmptyPluginRegistry();
    addMemoryPlugin(registry, params.pluginId, params.selections);
    addHook({
      registry,
      pluginId: params.pluginId,
      hookName: params.hookName,
      memoryRole: params.memoryRole,
      handler: () => {
        params.calls.push(params.memoryRole);
        return params.result;
      },
    });
    return registry;
  }

  it("does not run recall hooks for a plugin selected only for capture", async () => {
    const calls: string[] = [];
    const registry = createRegistryWithMemoryHook({
      pluginId: "memory-capture",
      selections: [{ role: "capture", slotKey: "memory.capture", pluginId: "memory-capture" }],
      hookName: "before_prompt_build",
      memoryRole: "recall",
      calls,
      result: { prependContext: "memory" },
    });

    const result = await createHookRunner(registry).runBeforePromptBuild(
      { prompt: "remember this", messages: [] },
      TEST_PLUGIN_AGENT_CTX,
    );

    expect(calls).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("runs agent-scoped capture hooks only for the selected owner scope", async () => {
    const registry = createEmptyPluginRegistry();
    addMemoryPlugin(registry, "global-capture", [
      { role: "capture", slotKey: "memory.capture", pluginId: "global-capture" },
    ]);
    addMemoryPlugin(registry, "agent-capture", [
      { role: "capture", slotKey: "memory.capture", pluginId: "agent-capture", agentId: "agent-a" },
    ]);
    const calls: string[] = [];
    for (const pluginId of ["global-capture", "agent-capture"]) {
      addHook({
        registry,
        pluginId,
        hookName: "agent_end",
        memoryRole: "capture",
        handler: () => {
          calls.push(pluginId);
        },
      });
    }

    const runner = createHookRunner(registry);
    await runner.runAgentEnd(
      { messages: [], success: true },
      { ...TEST_PLUGIN_AGENT_CTX, agentId: "agent-a" },
    );
    await runner.runAgentEnd(
      { messages: [], success: true },
      { ...TEST_PLUGIN_AGENT_CTX, agentId: "agent-b" },
    );

    expect(calls).toEqual(["agent-capture", "global-capture"]);
  });

  it("preserves default hooks for unrelated agents when only one agent has a role override", async () => {
    const registry = createEmptyPluginRegistry();
    addMemoryPlugin(registry, "memory-core", []);
    addMemoryPlugin(registry, "agent-recall", [
      { role: "recall", slotKey: "memory.recall", pluginId: "agent-recall", agentId: "agent-a" },
    ]);
    const calls: string[] = [];
    for (const pluginId of ["memory-core", "agent-recall"]) {
      addHook({
        registry,
        pluginId,
        hookName: "before_prompt_build",
        memoryRole: "recall",
        handler: () => {
          calls.push(pluginId);
          return { prependContext: pluginId };
        },
      });
    }

    const runner = createHookRunner(registry);

    await expect(
      runner.runBeforePromptBuild(
        { prompt: "remember this", messages: [] },
        { ...TEST_PLUGIN_AGENT_CTX, agentId: "agent-a" },
      ),
    ).resolves.toEqual({ prependContext: "agent-recall" });
    await expect(
      runner.runBeforePromptBuild(
        { prompt: "remember this", messages: [] },
        { ...TEST_PLUGIN_AGENT_CTX, agentId: "agent-b" },
      ),
    ).resolves.toEqual({ prependContext: "memory-core" });
    expect(calls).toEqual(["agent-recall", "memory-core"]);
  });

  it.each([
    {
      name: "modifying recall hooks",
      role: "recall" as const,
      slotKey: "memory.recall" as const,
      hookName: "before_prompt_build" as const,
      run: async (runner: ReturnType<typeof createHookRunner>, agentId: string) =>
        runner.runBeforePromptBuild(
          { prompt: "remember this", messages: [] },
          { ...TEST_PLUGIN_AGENT_CTX, agentId },
        ),
      disabledResult: undefined,
      globalResult: { prependContext: "memory" },
      result: { prependContext: "memory" },
    },
    {
      name: "void capture hooks",
      role: "capture" as const,
      slotKey: "memory.capture" as const,
      hookName: "agent_end" as const,
      run: async (runner: ReturnType<typeof createHookRunner>, agentId: string) => {
        await runner.runAgentEnd(
          { messages: [], success: true },
          { ...TEST_PLUGIN_AGENT_CTX, agentId },
        );
        return undefined;
      },
      disabledResult: undefined,
      globalResult: undefined,
      result: undefined,
    },
  ])(
    "honors an explicit per-agent none for $name while preserving global fallback",
    async ({ role, slotKey, hookName, run, disabledResult, globalResult, result }) => {
      const calls: string[] = [];
      const registry = createRegistryWithMemoryHook({
        pluginId: "memory-core",
        selections: [
          { role, slotKey, pluginId: "memory-core" },
          { role, slotKey, pluginId: "none", agentId: "agent-a", disabled: true },
        ],
        hookName,
        memoryRole: role,
        calls,
        result,
      });
      const runner = createHookRunner(registry);

      await expect(run(runner, "agent-a")).resolves.toEqual(disabledResult);
      await expect(run(runner, "agent-b")).resolves.toEqual(globalResult);
      expect(calls).toEqual([role]);
    },
  );
});
