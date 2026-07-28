// Provides shared helpers for plugin hook tests.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookRegistration } from "./types.js";

export function createMockPluginRegistry(
  hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
    priority?: number;
    timeoutMs?: number;
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
      ...(h.timeoutMs !== undefined ? { timeoutMs: h.timeoutMs } : {}),
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
  timeoutMs?: number;
}) {
  params.registry.typedHooks.push({
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: params.handler,
    priority: params.priority ?? 0,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    source: "test",
  } as PluginHookRegistration);
}
