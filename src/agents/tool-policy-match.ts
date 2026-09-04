/**
 * Runtime matcher for sandbox tool policies. Deny patterns always win, then
 * an empty allow list means "allow everything not denied".
 */
import { couldMaterializeToolName } from "./agent-bundle-mcp-names.js";
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

// Outside the sanitized tool-name alphabet (`[A-Za-z0-9_-]`), so a policy entry
// can cover a witness only through a wildcard, never by a literal that happens
// to spell the placeholder while missing the server's real tools. It stands for
// one safe letter when the witness is checked against the name grammar.
const NAMESPACE_WITNESS = "~";
const NAMESPACE_WITNESS_LETTER = "a";
// Entries a provider-safe tool name could ever match once `expandToolGroups`
// has trimmed and lowercased them; anything else (including one spelling the
// placeholder) authorizes or denies no real tool.
const REALIZABLE_ENTRY_RE = /^[a-z0-9_*-]+$/;

function realizableEntries(list: string[] | undefined): string[] {
  return expandToolGroups(list).filter((entry) => REALIZABLE_ENTRY_RE.test(entry));
}
// Ways of picking one glob per allow layer; exotic policies beyond this fall closed.
const MAX_WITNESS_COMBINATIONS = 64;

/** A glob split at its wildcards: literal head, inner literals, literal tail. */
type GlobShape = { head: string; inner: string[]; tail: string };

/** How an allow entry reaches the namespace: a concrete name as itself, a glob as its shape. */
function namespaceReach(entry: string, namespace: string): string | GlobShape | undefined {
  const parts = entry.split("*");
  const head = parts[0] ?? "";
  if (parts.length === 1) {
    return entry.length > namespace.length && entry.startsWith(namespace) ? entry : undefined;
  }
  if (!head.startsWith(namespace) && !namespace.startsWith(head)) {
    return undefined;
  }
  return {
    head: head.length >= namespace.length ? head : namespace,
    inner: parts.slice(1, -1),
    tail: parts.at(-1) ?? "",
  };
}

/**
 * One in-namespace name per way of picking a glob from every glob layer whose
 * heads nest and whose tails nest: the longest head, every inner literal in
 * order, and the longest tail, joined by the placeholder, is matched by each
 * chosen glob at once (`memos__read*` with `memos__*note` gives `memos__read~note`).
 */
function intersectGlobWitnesses(layers: GlobShape[][], namespace: string): string[] {
  let combinations: GlobShape[] = [{ head: namespace, inner: [], tail: "" }];
  for (const layer of layers) {
    const next: GlobShape[] = [];
    for (const combined of combinations) {
      for (const shape of layer) {
        const head = combined.head.length >= shape.head.length ? combined.head : shape.head;
        const tail = combined.tail.length >= shape.tail.length ? combined.tail : shape.tail;
        const nests =
          head.startsWith(combined.head) &&
          head.startsWith(shape.head) &&
          tail.endsWith(combined.tail) &&
          tail.endsWith(shape.tail);
        if (nests) {
          next.push({ head, inner: [...combined.inner, ...shape.inner], tail });
        }
      }
    }
    combinations = next.slice(0, MAX_WITNESS_COMBINATIONS);
    if (combinations.length === 0) {
      return [];
    }
  }
  return combinations.map((shape) =>
    [shape.head, ...shape.inner, shape.tail].join(NAMESPACE_WITNESS),
  );
}

/**
 * Whether layered policies could still admit some tool inside a namespace prefix
 * (an MCP `server__`) whose tool names are unknown after a failed catalog load.
 * Allow entries reaching the prefix stand in for tools they could match: concrete
 * names as themselves, globs through one witness per way of satisfying every
 * glob layer at once. The real matcher then judges those witnesses with deny
 * precedence across all layers, so `allow: ["memos__read*"]` plus
 * `deny: ["memos__read*"]` hides the namespace exactly as it hides the tools.
 */
export function policiesAdmitToolNamespace(
  prefix: string,
  policies: Array<SandboxToolPolicy | undefined>,
): boolean {
  const namespace = normalizeToolPolicyName(prefix);
  const names = new Set<string>();
  const globLayers: GlobShape[][] = [];
  const judged: SandboxToolPolicy[] = [];
  for (const policy of policies) {
    const allow = realizableEntries(policy?.allow);
    // A layer whose allow list names nothing realizable admits no real tool.
    if (allow.length === 0 && expandToolGroups(policy?.allow).length > 0) {
      return false;
    }
    judged.push({ allow, deny: realizableEntries(policy?.deny) });
    if (allow.length === 0) {
      continue;
    }
    const shapes: GlobShape[] = [];
    let reached = false;
    for (const entry of allow) {
      const reach = namespaceReach(entry, namespace);
      if (reach === undefined) {
        continue;
      }
      reached = true;
      if (typeof reach !== "string") {
        shapes.push(reach);
      } else if (couldMaterializeToolName(reach, namespace)) {
        names.add(reach);
      }
    }
    if (!reached) {
      return false;
    }
    if (shapes.length > 0) {
      globLayers.push(shapes);
    }
  }
  // Each placeholder counts as one letter, so `memos__1*` (no tool starts with a
  // digit) and literals past the name budget yield no witness and fall closed.
  const witnesses = [...names, ...intersectGlobWitnesses(globLayers, namespace)].filter((name) =>
    couldMaterializeToolName(
      name.replaceAll(NAMESPACE_WITNESS, NAMESPACE_WITNESS_LETTER),
      namespace,
    ),
  );
  return witnesses.some((name) => isToolAllowedByPolicies(name, judged));
}
