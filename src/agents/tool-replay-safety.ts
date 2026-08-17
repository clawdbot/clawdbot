/**
 * Defines the narrow set of tool instances that blind attempt retries may repeat.
 */
import { normalizeToolPolicyName } from "./tool-policy-shared.js";

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
  "conversations_list",
  "get_goal",
  "update_plan",
  "tool_search",
  "tool_describe",
  "view_image",
]);

type NamedTool = { name?: string };

function groupUniqueToolsByName(tools: NamedTool[]): Map<string, NamedTool | undefined> {
  const toolsByName = new Map<string, NamedTool | undefined>();
  for (const tool of tools) {
    const name = normalizeToolPolicyName(tool.name ?? "");
    if (!name) {
      continue;
    }
    toolsByName.set(name, toolsByName.has(name) ? undefined : tool);
  }
  return toolsByName;
}

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
  return UNCONDITIONALLY_REPLAY_SAFE_TOOL_NAMES.has(normalizeToolPolicyName(tool.name ?? ""));
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
  return UNCONDITIONALLY_REPLAY_SAFE_TOOL_NAMES.has(normalizeToolPolicyName(tool.name ?? ""));
}

/**
 * Name-only tool events are safe only when one concrete registered instance
 * owns the name. Duplicate/shadowed names fail closed.
 */
export function collectReplaySafeToolNames(
  tools: NamedTool[],
  options?: { declaredReplaySafe?: (tool: { name?: string }) => boolean | undefined },
): Set<string> {
  const replaySafeNames = new Set<string>();
  for (const [name, tool] of groupUniqueToolsByName(tools)) {
    if (tool && isAgentToolReplaySafe(tool, options)) {
      replaySafeNames.add(name);
    }
  }
  return replaySafeNames;
}

/** Bind name-only terminal events to the one concrete owner-declared side-effecting tool. */
export function collectSideEffectToolOwners(
  tools: NamedTool[],
  options: { declaredOwner: (tool: NamedTool) => string | undefined },
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [name, tool] of groupUniqueToolsByName(tools)) {
    const owner = tool ? options.declaredOwner(tool) : undefined;
    if (owner) {
      owners.set(name, owner);
    }
  }
  return owners;
}
