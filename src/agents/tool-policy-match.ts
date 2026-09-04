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

// Outside the sanitized tool-name alphabet (`[A-Za-z0-9_-]`), so a deny entry
// can cover a witness only through a wildcard, never by a literal that happens
// to spell the placeholder while missing the server's real tools.
const NAMESPACE_WITNESS = "~";

/** In-namespace tool name an allow entry could match; undefined when it cannot reach the namespace. */
function namespaceWitness(entry: string, namespace: string): string | undefined {
  const wildcard = entry.indexOf("*");
  if (wildcard < 0) {
    return entry.length > namespace.length && entry.startsWith(namespace) ? entry : undefined;
  }
  const head = entry.slice(0, wildcard);
  const tail = entry.slice(wildcard + 1).replaceAll("*", NAMESPACE_WITNESS);
  if (head.startsWith(namespace)) {
    return `${head}${NAMESPACE_WITNESS}${tail}`;
  }
  return namespace.startsWith(head) ? `${namespace}${NAMESPACE_WITNESS}${tail}` : undefined;
}

/**
 * Whether layered policies could still admit some tool inside a namespace prefix
 * (an MCP `server__`) whose tool names are unknown after a failed catalog load.
 * Every allow entry reaching the prefix stands in for a tool it could match, and
 * the real matcher judges those witnesses with deny precedence across all layers,
 * so `allow: ["memos__read*"]` plus `deny: ["memos__read*"]` hides the namespace
 * exactly as it hides the tools. Globs that intersect only through names neither
 * layer spells out yield no shared witness and hide the outage: the safe side.
 */
export function policiesAdmitToolNamespace(
  prefix: string,
  policies: Array<SandboxToolPolicy | undefined>,
): boolean {
  const namespace = normalizeToolPolicyName(prefix);
  const witnesses = new Set<string>();
  for (const policy of policies) {
    const allow = expandToolGroups(policy?.allow);
    if (allow.length === 0) {
      continue;
    }
    const reaching = allow.flatMap(
      (entry) => namespaceWitness(normalizeToolPolicyName(entry), namespace) ?? [],
    );
    if (reaching.length === 0) {
      return false;
    }
    for (const witness of reaching) {
      witnesses.add(witness);
    }
  }
  if (witnesses.size === 0) {
    witnesses.add(`${namespace}${NAMESPACE_WITNESS}`);
  }
  return [...witnesses].some((name) => isToolAllowedByPolicies(name, policies));
}
