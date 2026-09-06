/**
 * Sandbox tool policy resolver.
 *
 * Merges global, agent, and default allow/deny lists into normalized policy plus source diagnostics.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./constants.js";
import type {
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
} from "./types.js";

type SandboxToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};

function buildSource(params: {
  scope: "agent" | "global" | "default";
  key: string;
}): SandboxToolPolicySource {
  return {
    source: params.scope,
    key: params.key,
  } satisfies SandboxToolPolicySource;
}

function pickConfiguredList(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      values: params.agent,
      source: buildSource({
        scope: "agent",
        key: "agents.entries.*.tools.sandbox.tools.allow",
      }),
    };
  }
  if (Array.isArray(params.global)) {
    return {
      values: params.global,
      source: buildSource({ scope: "global", key: "tools.sandbox.tools.allow" }),
    };
  }
  return {
    values: undefined,
    source: buildSource({ scope: "default", key: "tools.sandbox.tools.allow" }),
  };
}

function pickConfiguredDeny(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      values: params.agent,
      source: buildSource({
        scope: "agent",
        key: "agents.entries.*.tools.sandbox.tools.deny",
      }),
    };
  }
  if (Array.isArray(params.global)) {
    return {
      values: params.global,
      source: buildSource({ scope: "global", key: "tools.sandbox.tools.deny" }),
    };
  }
  return {
    values: undefined,
    source: buildSource({ scope: "default", key: "tools.sandbox.tools.deny" }),
  };
}

function pickConfiguredAlsoAllow(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source?: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      values: params.agent,
      source: buildSource({
        scope: "agent",
        key: "agents.entries.*.tools.sandbox.tools.alsoAllow",
      }),
    };
  }
  if (Array.isArray(params.global)) {
    return {
      values: params.global,
      source: buildSource({ scope: "global", key: "tools.sandbox.tools.alsoAllow" }),
    };
  }
  return { values: undefined, source: undefined };
}

function mergeAllowlist(
  base: string[] | undefined,
  extra: string[] | undefined,
  defaultAllow: readonly string[],
): string[] {
  if (Array.isArray(base)) {
    // Preserve the existing sandbox meaning of `allow: []` => allow all.
    if (base.length === 0) {
      return [];
    }
    if (!Array.isArray(extra) || extra.length === 0) {
      return [...base];
    }
    return uniqueStrings([...base, ...extra]);
  }
  if (Array.isArray(extra) && extra.length > 0) {
    return uniqueStrings([...defaultAllow, ...extra]);
  }
  return [...defaultAllow];
}

function pickAllowSource(params: {
  allow: SandboxToolPolicySource;
  allowDefined: boolean;
  alsoAllow?: SandboxToolPolicySource;
}): SandboxToolPolicySource {
  if (params.allowDefined && params.allow.source === "agent") {
    return params.allow;
  }
  if (params.alsoAllow?.source === "agent") {
    return params.alsoAllow;
  }
  if (params.allowDefined && params.allow.source === "global") {
    return params.allow;
  }
  if (params.alsoAllow?.source === "global") {
    return params.alsoAllow;
  }
  return params.allow;
}

function resolveExplicitSandboxReAllowPatterns(params: {
  allow?: string[];
  alsoAllow?: string[];
}): string[] {
  return uniqueStrings([...(params.allow ?? []), ...(params.alsoAllow ?? [])]);
}

function filterDefaultDenyForExplicitAllows(params: {
  deny: string[];
  explicitAllowPatterns: string[];
}): string[] {
  if (params.explicitAllowPatterns.length === 0) {
    return [...params.deny];
  }
  const allowPatterns = compileGlobPatterns({
    raw: expandToolGroups(params.explicitAllowPatterns),
    normalize: normalizeToolPolicyName,
  });
  if (allowPatterns.length === 0) {
    return [...params.deny];
  }
  return params.deny.filter(
    (toolName) => !matchesAnyGlobPattern(normalizeToolPolicyName(toolName), allowPatterns),
  );
}

function expandResolvedPolicy(policy: SandboxToolPolicy): SandboxToolPolicy {
  let expandedDeny = expandToolGroups(policy.deny ?? []);
  let expandedAllow = expandToolGroups(policy.allow ?? []);
  const denyPatterns = compileGlobPatterns({
    raw: expandedDeny,
    normalize: normalizeToolPolicyName,
  });
  // Shipped sandbox denies are security boundaries. Keep the old spelling
  // fail-closed until Doctor rewrites it, without restoring a runtime alias.
  if (
    matchesAnyGlobPattern("image", denyPatterns) &&
    !matchesAnyGlobPattern("view_image", denyPatterns)
  ) {
    expandedDeny = [...expandedDeny, "view_image"];
  }
  const expandedDenyLower = expandedDeny.map(normalizeLowercaseStringOrEmpty);
  const expandedAllowLower = expandedAllow.map(normalizeLowercaseStringOrEmpty);

  // `view_image` is essential for multimodal workflows; keep the existing sandbox
  // behavior that auto-includes it for explicit allowlists unless it is denied.
  if (
    expandedAllow.length > 0 &&
    !expandedDenyLower.includes("view_image") &&
    !expandedAllowLower.includes("view_image")
  ) {
    expandedAllow = [...expandedAllow, "view_image"];
  }

  return {
    allow: expandedAllow,
    deny: expandedDeny,
  };
}

export function classifyToolAgainstSandboxToolPolicy(name: string, policy?: SandboxToolPolicy) {
  if (!policy) {
    return {
      blockedByDeny: false,
      blockedByAllow: false,
    };
  }

  const normalized = normalizeToolPolicyName(name);
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolPolicyName,
  });
  const blockedByDeny = matchesAnyGlobPattern(normalized, deny);
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolPolicyName,
  });
  const blockedByAllow =
    !blockedByDeny && allow.length > 0 && !matchesAnyGlobPattern(normalized, allow);
  return {
    blockedByDeny,
    blockedByAllow,
  };
}

export function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(name, policy);
  return !blockedByDeny && !blockedByAllow;
}

export function resolveSandboxToolPolicyForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
  options?: { containedToolNames?: readonly string[] },
): SandboxToolPolicyResolved {
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentPolicy = agentConfig?.tools?.sandbox?.tools as SandboxToolPolicyConfig | undefined;
  const globalPolicy = cfg?.tools?.sandbox?.tools as SandboxToolPolicyConfig | undefined;

  const allowConfig = pickConfiguredList({
    agent: agentPolicy?.allow,
    global: globalPolicy?.allow,
  });
  const alsoAllowConfig = pickConfiguredAlsoAllow({
    agent: agentPolicy?.alsoAllow,
    global: globalPolicy?.alsoAllow,
  });
  const denyConfig = pickConfiguredDeny({
    agent: agentPolicy?.deny,
    global: globalPolicy?.deny,
  });

  const explicitAllowPatterns = resolveExplicitSandboxReAllowPatterns({
    allow: allowConfig.values,
    alsoAllow: alsoAllowConfig.values,
  });

  // Host-bound tools that operate inside this placement are sandbox capabilities.
  // Change defaults only; configured allow/deny lists retain their normal authority.
  const containedTools = new Set(options?.containedToolNames);
  const defaultAllow = uniqueStrings([...DEFAULT_TOOL_ALLOW, ...containedTools]);
  const resolvedAllow = mergeAllowlist(allowConfig.values, alsoAllowConfig.values, defaultAllow);
  const resolvedDeny = Array.isArray(denyConfig.values)
    ? [...denyConfig.values]
    : filterDefaultDenyForExplicitAllows({
        deny: DEFAULT_TOOL_DENY.filter((name) => !containedTools.has(name)),
        explicitAllowPatterns,
      });

  const expanded = expandResolvedPolicy({
    allow: resolvedAllow,
    deny: resolvedDeny,
  });

  return {
    allow: expanded.allow ?? [],
    deny: expanded.deny ?? [],
    sources: {
      allow: pickAllowSource({
        allow: allowConfig.source,
        allowDefined: Array.isArray(allowConfig.values),
        alsoAllow: alsoAllowConfig.source,
      }),
      deny: denyConfig.source,
    },
  };
}
