/**
 * Runtime matcher for sandbox tool policies. Deny patterns always win, then
 * an empty allow list means "allow everything not denied".
 */
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import {
  expandToolGroups,
  normalizeToolPolicyName,
  readToolAllowlistIntersection,
} from "./tool-policy-shared.js";

/** Snapshot one synchronous filtering operation; execution checks must prepare current policy. */
export function createToolPolicyMatcher(policy?: SandboxToolPolicy, writeAllowsApplyPatch = true) {
  if (!policy) {
    return () => true;
  }
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolPolicyName,
  });
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolPolicyName,
  });
  return (name: string) => {
    const normalized = normalizeToolPolicyName(name);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    if (matchesAnyGlobPattern(normalized, allow)) {
      return true;
    }
    // Runtime policy historically treats `write` as covering `apply_patch`.
    // Construction planning can disable that compatibility to avoid selecting a shell factory.
    if (
      writeAllowsApplyPatch &&
      normalized === "apply_patch" &&
      matchesAnyGlobPattern("write", allow)
    ) {
      return true;
    }
    return false;
  };
}

/** Return whether one tool name is allowed by a single sandbox policy. */
export function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean {
  if (!policy) {
    return true;
  }
  return createToolPolicyMatcher(policy)(name);
}

/** Runtime caps deny empty lists and preserve every independently merged restriction. */
export function createRuntimeToolMatcher(toolsAllow?: string[], writeAllowsApplyPatch = true) {
  const matchers = (
    toolsAllow === undefined ? [] : (readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow])
  ).map((allow) =>
    allow.length > 0 ? createToolPolicyMatcher({ allow }, writeAllowsApplyPatch) : () => false,
  );
  return (name: string) => matchers.every((matches) => matches(name));
}

export function isRuntimeToolAllowed(name: string, toolsAllow?: string[]): boolean {
  return (
    toolsAllow === undefined ||
    (readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow]).every(
      (allow) => allow.length > 0 && isToolAllowedByPolicyName(name, { allow }),
    )
  );
}

/** Filter runtime tools by policy without rebuilding its patterns for each tool. */
export function filterToolsByPolicy<TTool extends { name: string }>(
  tools: TTool[],
  policy?: SandboxToolPolicy,
): TTool[] {
  if (!policy) {
    return tools;
  }
  if (tools.length === 0) {
    return [];
  }
  const matches = createToolPolicyMatcher(policy);
  return tools.filter((tool) => matches(tool.name));
}

/** Return whether one tool name is allowed by every active sandbox policy. */
export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
