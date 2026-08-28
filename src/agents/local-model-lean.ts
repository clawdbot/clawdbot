/**
 * Local-model lean tool filtering.
 * Removes high-latency or channel-dependent tools for local models while
 * preserving explicitly required delivery tools.
 */
import { messageToolOwnsVisibleReply } from "../auto-reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolPolicyName } from "./tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set([
  "browser",
  AUTOMATIONS_TOOL_NAME,
  "image_generate",
  "message",
  "music_generate",
  "pdf",
  "tts",
  "video_generate",
]);
const LOCAL_MODEL_LEAN_TOOL_SEARCH_DEFAULTS = {
  enabled: true,
  mode: "tools",
  searchDefaultLimit: 5,
  maxSearchLimit: 10,
} as const;

function resolvePreservedLocalModelLeanToolNames(names?: Iterable<string>) {
  if (!names) {
    return [];
  }
  return compileGlobPatterns({
    raw: expandToolGroups([...names]).filter((name) => normalizeToolPolicyName(name) !== "*"),
    normalize: normalizeToolPolicyName,
  });
}

/** Resolves tool names that must survive local-model lean filtering. */
export function resolveLocalModelLeanPreserveToolNames(params?: {
  toolNames?: Iterable<string>;
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): string[] {
  const names = [...(params?.toolNames ?? [])];
  if (params && messageToolOwnsVisibleReply(params)) {
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
  if (params.config) {
    return resolveSessionAgentIds({
      config: params.config,
      agentId: explicitAgentId,
      sessionKey: params.sessionKey,
    }).sessionAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  return (
    explicitAgentId ?? (parsedSessionAgentId ? normalizeAgentId(parsedSessionAgentId) : undefined)
  );
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
    const normalizedName = normalizeToolPolicyName(tool.name);
    return (
      matchesAnyGlobPattern(normalizedName, preservedToolNames) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}

export function applyLocalModelLeanToolSearchDefaults(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): OpenClawConfig | undefined {
  if (!params.config || !isLocalModelLeanEnabled(params)) {
    return params.config;
  }
  if (params.config.tools?.toolSearch !== undefined) {
    return params.config;
  }
  return {
    ...params.config,
    tools: {
      ...params.config.tools,
      toolSearch: LOCAL_MODEL_LEAN_TOOL_SEARCH_DEFAULTS,
    },
  };
}
