/**
 * Plans which core, bundle MCP, and bundle LSP tools an attempt should build.
 */
import { TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import type { OpenClawCodingToolConstructionPlan } from "../../agent-tools.js";
import { isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
} from "../../tool-policy.js";

const BASE_CODING_TOOL_FACTORY_NAMES = new Set(["edit", "read", "write"]);

const SHELL_CODING_TOOL_FACTORY_NAMES = new Set(["apply_patch", "exec", "process"]);

// Names here must be emitted directly by createOpenClawTools(). Catalog entries
// backed by plugin registration, such as browser/x_search/code_execution, stay
// out of this set so narrow allowlists still materialize plugin tools.
const OPENCLAW_TOOL_FACTORY_NAMES = new Set([
  "agents_list",
  "canvas",
  "cron",
  "gateway",
  "get_goal",
  "heartbeat_respond",
  "heartbeat_response",
  "image",
  "image_generate",
  "message",
  "music_generate",
  "nodes",
  "pdf",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "skill_workshop",
  "create_goal",
  "subagents",
  "tts",
  "update_goal",
  "update_plan",
  "video_generate",
  "web_fetch",
  "web_search",
]);

const ALL_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: true,
  includeShellTools: true,
  includeChannelTools: true,
  includeOpenClawTools: true,
  includePluginTools: true,
};

const NO_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: false,
};

function cloneCodingToolConstructionPlan(
  plan: OpenClawCodingToolConstructionPlan,
): OpenClawCodingToolConstructionPlan {
  return { ...plan };
}

function isBundleMcpAllowlistName(normalized: string): boolean {
  // Bundle MCP tools use the synthetic bundle name or `bundle__tool` separator form.
  return normalized === "bundle-mcp" || normalized.includes(TOOL_NAME_SEPARATOR);
}

function isPluginGroupAllowlistName(normalized: string): boolean {
  return normalized === "group:plugins";
}

function hasWildcardToolAllowlist(toolsAllow: string[]): boolean {
  return toolsAllow.some((entry) => normalizeToolName(entry) === "*");
}

function isKnownLocalCodingToolName(normalized: string): boolean {
  // Unknown non-bundle names are treated as plugin tools so installed plugin
  // catalog entries still materialize under narrow allowlists.
  return (
    BASE_CODING_TOOL_FACTORY_NAMES.has(normalized) ||
    SHELL_CODING_TOOL_FACTORY_NAMES.has(normalized) ||
    OPENCLAW_TOOL_FACTORY_NAMES.has(normalized)
  );
}

/**
 * Applies a runtime allowlist to a concrete tool list after expanding tool and
 * plugin groups. Undefined allowlists keep all tools; an explicit empty list
 * intentionally disables all runtime tools.
 */
export function applyEmbeddedAttemptToolsAllow<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
  options?: {
    toolMeta?: (tool: T) => { pluginId: string } | undefined;
  },
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  if (toolsAllow.length === 0) {
    return [];
  }
  if (hasWildcardToolAllowlist(toolsAllow)) {
    return tools;
  }
  const pluginGroups = options?.toolMeta
    ? buildPluginToolGroups({ tools, toolMeta: options.toolMeta })
    : undefined;
  const policy = pluginGroups
    ? expandPolicyWithPluginGroups({ allow: toolsAllow }, pluginGroups)
    : { allow: toolsAllow };
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}

/**
 * Adds the message tool to a narrowed allowlist when the caller must support
 * forced source-reply delivery. Wildcard and undefined allowlists already cover
 * message, while an empty allowlist becomes message-only.
 */
export function mergeForcedEmbeddedAttemptToolsAllow(
  toolsAllow: string[] | undefined,
  params: { forceMessageTool?: boolean },
): string[] | undefined {
  if (
    !params.forceMessageTool ||
    toolsAllow === undefined ||
    hasWildcardToolAllowlist(toolsAllow)
  ) {
    return toolsAllow;
  }
  if (toolsAllow.length === 0) {
    return ["message"];
  }
  const normalized = new Set(toolsAllow.map((entry) => normalizeToolName(entry)));
  return normalized.has("message") ? toolsAllow : [...toolsAllow, "message"];
}

function resolveCodingToolConstructionPlanForAllowlist(
  toolsAllow?: string[],
): OpenClawCodingToolConstructionPlan {
  if (!toolsAllow) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (toolsAllow.length === 0) {
    return cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (hasWildcardToolAllowlist(toolsAllow)) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  const expanded = expandToolGroups(toolsAllow);
  const normalized = normalizeToolList(expanded);
  const includeBaseCodingTools = normalized.some((name) =>
    BASE_CODING_TOOL_FACTORY_NAMES.has(name),
  );
  const includeShellTools = normalized.some((name) => SHELL_CODING_TOOL_FACTORY_NAMES.has(name));
  const includeOpenClawTools = normalized.some((name) => OPENCLAW_TOOL_FACTORY_NAMES.has(name));
  const includePluginTools = normalized.some(
    (name) =>
      name === "group:plugins" ||
      // Plugin ids/tool names are not known to this local factory list at build time.
      (!isBundleMcpAllowlistName(name) && !isKnownLocalCodingToolName(name)),
  );
  // Channel delivery tools are constructed through plugin-capable runtime setup.
  const includeChannelTools = includePluginTools;

  return {
    includeBaseCodingTools,
    includeShellTools,
    includeChannelTools,
    includeOpenClawTools,
    includePluginTools,
  };
}

/**
 * Decides which tool families need to be constructed for an embedded attempt.
 * This keeps allowlisted plugin/channel tools available without forcing every
 * local core tool factory to run for narrow plugin-only configurations.
 */
export function resolveEmbeddedAttemptToolConstructionPlan(params: {
  disableTools?: boolean;
  isRawModelRun?: boolean;
  toolsAllow?: string[];
  forceMessageTool?: boolean;
}): {
  constructTools: boolean;
  includeCoreTools: boolean;
  runtimeToolAllowlist?: string[];
  codingToolConstructionPlan: OpenClawCodingToolConstructionPlan;
} {
  if (params.disableTools === true || params.isRawModelRun === true) {
    return {
      constructTools: false,
      includeCoreTools: false,
      codingToolConstructionPlan: cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN),
    };
  }
  const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
  });
  const codingToolConstructionPlan = resolveCodingToolConstructionPlanForAllowlist(toolsAllow);
  const includeCoreTools =
    codingToolConstructionPlan.includeBaseCodingTools ||
    codingToolConstructionPlan.includeShellTools ||
    codingToolConstructionPlan.includeOpenClawTools;
  const constructTools =
    includeCoreTools ||
    codingToolConstructionPlan.includeChannelTools ||
    codingToolConstructionPlan.includePluginTools;

  return {
    constructTools,
    includeCoreTools,
    ...(toolsAllow ? { runtimeToolAllowlist: toolsAllow } : {}),
    codingToolConstructionPlan,
  };
}

/** Returns whether the allowlist requires any built-in coding/OpenClaw tools. */
export function shouldBuildCoreCodingToolsForAllowlist(toolsAllow?: string[]): boolean {
  return resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow }).includeCoreTools;
}

/**
 * Decides whether the bundled MCP runtime is needed for this attempt. Bundle
 * runtime creation follows explicit bundle/plugin allowlist names rather than
 * generic local tool names.
 */
export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow) {
    return true;
  }
  if (params.toolsAllow.length === 0) {
    return false;
  }
  if (hasWildcardToolAllowlist(params.toolsAllow)) {
    return true;
  }
  return params.toolsAllow.some((toolName) => {
    const normalized = normalizeToolName(toolName);
    return isBundleMcpAllowlistName(normalized) || isPluginGroupAllowlistName(normalized);
  });
}

/**
 * Decides whether the bundled LSP runtime is needed for this attempt. LSP tools
 * are enabled by default/wildcard and by allowlist entries with the `lsp_`
 * prefix.
 */
export function shouldCreateBundleLspRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow) {
    return true;
  }
  if (params.toolsAllow.length === 0) {
    return false;
  }
  if (hasWildcardToolAllowlist(params.toolsAllow)) {
    return true;
  }
  return params.toolsAllow.some((toolName) => {
    const normalized = normalizeToolName(toolName);
    return normalized.startsWith("lsp_");
  });
}
