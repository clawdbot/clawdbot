/**
 * Plans which core, bundle MCP, and bundle LSP tools an attempt should build.
 */
import { TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import {
  type CoreToolFactoryFamily,
  type OpenClawCodingToolConstructionPlan,
  listCoreToolFactoryDescriptors,
  resolveCoreToolFactoryFamily,
} from "../../core-tool-factory-descriptors.js";
import { mayMatchGlobWithPrefix } from "../../glob-pattern.js";
import { createRuntimeToolMatcher } from "../../tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandShippedCoreToolPolicyNames,
  expandToolGroups,
  normalizeToolList,
  normalizeToolPolicyName,
  readToolAllowlistIntersection,
} from "../../tool-policy.js";

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

function hasWildcardToolAllowlist(toolsAllow: string[]): boolean {
  return toolsAllow.some((entry) => normalizeToolPolicyName(entry) === "*");
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
  const restrictions = readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow];
  return restrictions.reduce<T[]>((currentTools, restriction) => {
    if (restriction.length === 0) {
      return [];
    }
    if (hasWildcardToolAllowlist(restriction)) {
      return currentTools;
    }
    if (currentTools.length === 0) {
      return [];
    }
    const pluginGroups = options?.toolMeta
      ? buildPluginToolGroups({ tools: currentTools, toolMeta: options.toolMeta })
      : undefined;
    const policy = pluginGroups
      ? expandPolicyWithPluginGroups({ allow: restriction }, pluginGroups)
      : { allow: expandShippedCoreToolPolicyNames(restriction) };
    const matches = createRuntimeToolMatcher(policy?.allow);
    return currentTools.filter((tool) => matches(tool.name));
  }, tools);
}

/**
 * Adds host-required tools to a narrowed runtime allowlist. Wildcard and
 * undefined allowlists already cover every required tool.
 */
export function mergeForcedEmbeddedAttemptToolsAllow(
  toolsAllow: string[] | undefined,
  params: { forceMessageTool?: boolean; forceToolNames?: readonly string[] },
): string[] | undefined {
  if (toolsAllow === undefined || hasWildcardToolAllowlist(toolsAllow)) {
    return toolsAllow;
  }
  const required = [
    ...(params.forceMessageTool ? ["message"] : []),
    ...(params.forceToolNames ?? []),
  ];
  if (required.length === 0) {
    return toolsAllow;
  }
  const normalized = new Set(toolsAllow.map((entry) => normalizeToolPolicyName(entry)));
  const missing = required.filter((name) => !normalized.has(normalizeToolPolicyName(name)));
  if (missing.length === 0) {
    return toolsAllow;
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow);
  const merged = [...toolsAllow, ...missing];
  return restrictions
    ? attachToolAllowlistIntersection(
        merged,
        restrictions.map((restriction) => restriction.concat(missing)),
      )
    : merged;
}

function resolveCodingToolConstructionPlanForAllowlist(
  toolsAllow?: string[],
): OpenClawCodingToolConstructionPlan {
  if (!toolsAllow) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow);
  if (!restrictions && toolsAllow.length === 0) {
    return cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (!restrictions && hasWildcardToolAllowlist(toolsAllow)) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  const constructionEntries = restrictions?.flat() ?? toolsAllow;
  const expanded = expandToolGroups(expandShippedCoreToolPolicyNames(constructionEntries));
  const normalized = normalizeToolList(expanded);
  // Construction must not select a shell factory only through write -> apply_patch.
  const constructionMatchers = (restrictions ?? [toolsAllow]).map((restriction) =>
    createRuntimeToolMatcher(expandShippedCoreToolPolicyNames(restriction), false),
  );
  // Construct every family containing a tool that the final runtime policy can retain.
  // Otherwise a valid glob can survive filtering after its factory was never run.
  const coreFamilies = new Set<CoreToolFactoryFamily>(
    listCoreToolFactoryDescriptors()
      .filter(({ name }) => constructionMatchers.every((matches) => matches(name)))
      .map(({ family }) => family),
  );
  let includePluginTools = false;
  for (const name of normalized) {
    const family = resolveCoreToolFactoryFamily(name);
    if (family) {
      continue;
    }
    // Only bundle-mcp is unambiguous; namespaced entries can belong to plugins.
    if (name !== "bundle-mcp") {
      includePluginTools = true;
    }
  }
  const includeBaseCodingTools = coreFamilies.has("base-coding");
  const includeShellTools = coreFamilies.has("shell");
  const includeOpenClawTools = coreFamilies.has("openclaw");
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
  toolsEnabled?: boolean;
  toolsAllow?: string[];
  forceMessageTool?: boolean;
}): {
  constructTools: boolean;
  includeCoreTools: boolean;
  runtimeToolAllowlist?: string[];
  codingToolConstructionPlan: OpenClawCodingToolConstructionPlan;
} {
  // Model capability is authoritative: forced delivery cannot materialize a
  // tool the selected model cannot call.
  if (
    params.disableTools === true ||
    params.isRawModelRun === true ||
    params.toolsEnabled === false
  ) {
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

function shouldCreateBundleRuntimeForAttempt(
  params: {
    toolsEnabled: boolean;
    disableTools?: boolean;
    toolsAllow?: string[];
  },
  matchesAllowlist: (normalizedToolNames: string[]) => boolean,
): boolean {
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
  return matchesAllowlist(params.toolsAllow.map(normalizeToolPolicyName));
}

/**
 * Decides whether the bundled MCP runtime is needed for this attempt. Bundle
 * runtime creation follows explicit bundle/plugin names or globs that can reach
 * a configured server namespace. Final tool policy remains authoritative.
 */
export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  resolveConfiguredMcpNamespaces?: () => string[];
}): boolean {
  return shouldCreateBundleRuntimeForAttempt(params, (names) => {
    if (names.some((name) => isBundleMcpAllowlistName(name) || name === "group:plugins")) {
      return true;
    }
    // Discovery can start all enabled static servers, even if a later glob
    // constraint matches no tool. Only final full-name policy grants tools.
    const globs = names.filter((name) => name.includes("*"));
    return (
      globs.length > 0 &&
      (params.resolveConfiguredMcpNamespaces?.() ?? []).some((namespace) =>
        globs.some((glob) => mayMatchGlobWithPrefix(glob, namespace.toLowerCase())),
      )
    );
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
  return shouldCreateBundleRuntimeForAttempt(params, (names) =>
    names.some((name) => name.startsWith("lsp_")),
  );
}
