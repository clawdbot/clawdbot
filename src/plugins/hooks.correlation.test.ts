import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

describe("hook correlation fields", () => {
  let registry: PluginRegistry;

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
      expect.objectContaining({ prompt: "hello", runId: "test-run-id" }),
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
      expect.objectContaining({ messages: [], success: true, runId: "test-run-id" }),
      TEST_PLUGIN_AGENT_CTX,
    );
  });
});
