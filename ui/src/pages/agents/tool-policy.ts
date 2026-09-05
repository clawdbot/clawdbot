// Keep catalog-backed policy evaluation behind the Agents page's lazy boundary;
// importing it from shared agent display helpers loads tool descriptions at startup.
import {
  compileGlobPatterns,
  matchesAnyGlobPattern as matchesAny,
} from "../../../../src/agents/glob-pattern.js";
import {
  expandToolGroups,
  normalizeToolPolicyName,
} from "../../../../src/agents/tool-policy-shared.js";

type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

function compilePatterns(patterns?: string[]) {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return compileGlobPatterns({
    raw: expandToolGroups(patterns),
    normalize: normalizeToolPolicyName,
  });
}

export function isAllowedByPolicy(name: string, policy?: ToolPolicy) {
  if (!policy) {
    return true;
  }
  const normalized = normalizeToolPolicyName(name);
  const deny = compilePatterns(policy.deny);
  if (matchesAny(normalized, deny)) {
    return false;
  }
  const allow = compilePatterns(policy.allow);
  if (allow.length === 0) {
    return true;
  }
  if (matchesAny(normalized, allow)) {
    return true;
  }
  if (normalized === "apply_patch" && matchesAny("exec", allow)) {
    return true;
  }
  return false;
}

export function matchesList(name: string, list?: string[]) {
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }
  const normalized = normalizeToolPolicyName(name);
  const patterns = compilePatterns(list);
  if (matchesAny(normalized, patterns)) {
    return true;
  }
  if (normalized === "apply_patch" && matchesAny("exec", patterns)) {
    return true;
  }
  return false;
}
