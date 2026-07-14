/**
 * Defines the narrow set of tool instances that blind attempt retries may repeat.
 */
import { normalizeToolName } from "./tool-policy-shared.js";

const UNCONDITIONALLY_REPLAY_SAFE_TOOL_NAMES = new Set([
  "read",
  "search",
  "find",
  "grep",
  "glob",
  "ls",
  "web_search",
  "web_fetch",
  "x_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "agents_list",
  "get_goal",
  "update_plan",
  "tool_search",
  "tool_describe",
  "image",
]);

/**
 * Tool names are not ownership boundaries. Callers must reject plugin/channel
 * instances before using this audited core-tool allowlist.
 */
export function isAgentToolReplaySafe(
  tool: { name?: string },
  options?: { declaredReplaySafe?: (tool: { name?: string }) => boolean | undefined },
): boolean {
  if (options?.declaredReplaySafe?.(tool) === false) {
    return false;
  }
  return UNCONDITIONALLY_REPLAY_SAFE_TOOL_NAMES.has(normalizeToolName(tool.name ?? ""));
}

/**
 * Classify one concrete tool instance for an explicitly restart-safe turn.
 * Unlike blind name-only replay, an owner declaration is sufficient because
 * the host filters the concrete registered instance before execution.
 */
export function isAgentToolRestartSafe(
  tool: { name?: string },
  options?: { declaredReplaySafe?: (tool: { name?: string }) => boolean | undefined },
): boolean {
  const declaredReplaySafe = options?.declaredReplaySafe?.(tool);
  if (declaredReplaySafe !== undefined) {
    return declaredReplaySafe;
  }
  return UNCONDITIONALLY_REPLAY_SAFE_TOOL_NAMES.has(normalizeToolName(tool.name ?? ""));
}

/**
 * Name-only tool events are safe only when one concrete registered instance
 * owns the name. Duplicate/shadowed names fail closed.
 */
export function collectReplaySafeToolNames(
  tools: Array<{ name?: string }>,
  options?: { declaredReplaySafe?: (tool: { name?: string }) => boolean | undefined },
): Set<string> {
  const toolsByName = new Map<string, Array<{ name?: string }>>();
  for (const tool of tools) {
    const name = normalizeToolName(tool.name ?? "");
    if (!name) {
      continue;
    }
    const entries = toolsByName.get(name) ?? [];
    entries.push(tool);
    toolsByName.set(name, entries);
  }

  const replaySafeNames = new Set<string>();
  for (const [name, entries] of toolsByName) {
    const tool = entries.length === 1 ? entries[0] : undefined;
    if (tool && isAgentToolReplaySafe(tool, options)) {
      replaySafeNames.add(name);
    }
  }
  return replaySafeNames;
}
