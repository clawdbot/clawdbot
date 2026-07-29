// Provides shared helpers for plugin hook tests.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookAgentTrigger, PluginHookRegistration } from "./types.js";

export function createMockPluginRegistry(
  hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
    priority?: number;
    registrationId?: string;
    timeoutMs?: number;
    eligibleTriggers?: readonly PluginHookAgentTrigger[];
  }>,
): PluginRegistry {
  const pluginIds =
    hooks.length > 0
      ? uniqueStrings(hooks.map((hook) => hook.pluginId ?? "test-plugin"))
      : ["test-plugin"];
  return {
    ...createEmptyPluginRegistry(),
    plugins: pluginIds.map((pluginId) =>
      createPluginRecord({
        id: pluginId,
        name: "Test Plugin",
        source: "test",
        hookCount: hooks.filter((hook) => (hook.pluginId ?? "test-plugin") === pluginId).length,
      }),
    ),
    hooks: hooks as never[],
    typedHooks: hooks.map((h) => ({
      pluginId: h.pluginId ?? "test-plugin",
      hookName: h.hookName,
      handler: h.handler,
      priority: h.priority ?? 0,
      ...(h.registrationId ? { registrationId: h.registrationId } : {}),
      ...(h.timeoutMs !== undefined ? { timeoutMs: h.timeoutMs } : {}),
      ...(h.eligibleTriggers !== undefined ? { eligibleTriggers: h.eligibleTriggers } : {}),
      source: "test",
    })) as PluginRegistry["typedHooks"],
  };
}
export function addTestHook(params: {
  registry: PluginRegistry;
  pluginId: string;
  hookName: PluginHookRegistration["hookName"];
  handler: PluginHookRegistration["handler"];
  priority?: number;
  registrationId?: string;
  timeoutMs?: number;
  eligibleTriggers?: readonly PluginHookAgentTrigger[];
}) {
  params.registry.typedHooks.push({
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: params.handler,
    priority: params.priority ?? 0,
    ...(params.registrationId ? { registrationId: params.registrationId } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.eligibleTriggers !== undefined ? { eligibleTriggers: params.eligibleTriggers } : {}),
    source: "test",
  } as PluginHookRegistration);
}
