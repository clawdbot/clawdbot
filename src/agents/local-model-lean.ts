/**
 * Local-model lean tool filtering.
 * Removes high-latency or channel-dependent tools for local models while
 * preserving explicitly required delivery tools.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set(["browser", "cron", "message"]);

function resolvePreservedLocalModelLeanToolNames(names?: Iterable<string>): Set<string> {
  if (!names) {
    return new Set();
  }
  return new Set(
    expandToolGroups([...names])
      .map(normalizeToolName)
      .filter((name) => name && name !== "*"),
  );
}

/** Resolves tool names that must survive local-model lean filtering. */
export function resolveLocalModelLeanPreserveToolNames(params?: {
  toolNames?: Iterable<string>;
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): string[] {
  const names = [...(params?.toolNames ?? [])];
  if (params?.forceMessageTool || params?.sourceReplyDeliveryMode === "message_tool_only") {
    names.push("message");
  }
  return [...new Set(names)];
}

// Agent id may arrive explicitly, through the session key, or via config default.
// Resolve once so default/agent experimental flags use the same scope.
function resolveLocalModelLeanAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (parsedSessionAgentId) {
    return normalizeAgentId(parsedSessionAgentId);
  }
  return params.config ? resolveDefaultAgentId(params.config) : undefined;
}

/** Returns true when local-model lean mode is enabled for the selected agent. */
export function isLocalModelLeanEnabled(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): boolean {
  const normalizedAgentId = resolveLocalModelLeanAgentId(params);
  const resolvedExperimental =
    params.config && normalizedAgentId
      ? (resolveAgentConfig(params.config, normalizedAgentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  return resolvedExperimental?.localModelLean ?? false;
}

/** Filters tools for local-model lean mode while preserving required delivery tools. */
export function filterLocalModelLeanTools(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preserveToolNames?: Iterable<string>;
}): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolName(tool.name);
    return (
      preservedToolNames.has(normalizedName) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}
