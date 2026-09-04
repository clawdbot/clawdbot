/**
 * Runtime matcher for sandbox tool policies. Deny patterns always win, then
 * an empty allow list means "allow everything not denied".
 */
import { couldMaterializeToolName, TOOL_NAME_MAX_TOTAL } from "./agent-bundle-mcp-names.js";
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

// Entries a provider-safe tool name could ever match once `expandToolGroups`
// has trimmed and lowercased them (letters, digits, `_`, interior `-`, and
// `*`); anything else authorizes or denies no real tool.
const REALIZABLE_ENTRY_RE = /^[a-z0-9_*-]+$/;

function realizableEntries(list: string[] | undefined): string[] {
  return expandToolGroups(list).filter((entry) => REALIZABLE_ENTRY_RE.test(entry));
}

/**
 * Positions a glob can occupy after reading input, closed over `*` matching
 * nothing: a position at a `*` also stands one past it. A glob accepts when its
 * length is among them.
 */
function closeGlobPositions(glob: string, positions: Iterable<number>): number[] {
  const closed = new Set<number>();
  for (const position of positions) {
    let cursor = position;
    closed.add(cursor);
    while (glob[cursor] === "*") {
      cursor += 1;
      closed.add(cursor);
    }
  }
  return [...closed].toSorted((a, b) => a - b);
}

/** Positions after one more character: a `*` keeps consuming, a literal must match. */
function stepGlobPositions(glob: string, positions: readonly number[], char: string): number[] {
  const next: number[] = [];
  for (const position of positions) {
    const symbol = glob[position];
    if (symbol === "*") {
      next.push(position);
    } else if (symbol === char) {
      next.push(position + 1);
    }
  }
  return closeGlobPositions(glob, next);
}

/** One glob list run in lockstep: `positions[i]` tracks `globs[i]`. */
type GlobRun = { globs: readonly string[]; positions: number[][] };

function stepGlobRun(run: GlobRun, char: string): GlobRun {
  return {
    globs: run.globs,
    positions: run.positions.map((positions, index) =>
      stepGlobPositions(run.globs[index] ?? "", positions, char),
    ),
  };
}

/** No glob of the run can advance any further. */
function globRunIsDead(run: GlobRun): boolean {
  return run.positions.every((positions) => positions.length === 0);
}

/**
 * Once one glob of an allow layer sits on its trailing `*`, the layer accepts
 * every extension; keeping only that glob's positions lets states that differ
 * only in how the rest of the layer got there merge.
 */
function settleGlobRun(run: GlobRun): GlobRun {
  const settled = run.positions.findIndex((positions, index) => {
    const glob = run.globs[index] ?? "";
    return glob.endsWith("*") && positions.includes(glob.length - 1);
  });
  if (settled < 0) {
    return run;
  }
  return {
    globs: run.globs,
    positions: run.positions.map((positions, index) => (index === settled ? positions : [])),
  };
}

/** A glob sitting on its trailing `*` accepts every extension; a deny there ends the search. */
function globRunAcceptsForever(run: GlobRun): boolean {
  return run.positions.some((positions, index) => {
    const glob = run.globs[index] ?? "";
    return glob.endsWith("*") && positions.includes(glob.length - 1);
  });
}

function globRunAccepts(run: GlobRun): boolean {
  return run.positions.some((positions, index) =>
    positions.includes(run.globs[index]?.length ?? -1),
  );
}

/**
 * Whether some provider-safe tool name under `namespace` is matched by a glob
 * of every allow layer and by no deny glob. Every glob is simulated together
 * over one candidate name at a time, breadth-first over the suffix, so the
 * decision is exact: no synthetic witness, no cap that drops a candidate.
 * The position sets form a finite space the search never revisits, so it
 * always terminates with the exact answer; a policy that denies every
 * candidate ends as soon as each branch reaches a deny's trailing `*`.
 */
function globLayersAdmitSomeName(params: {
  namespace: string;
  layers: readonly (readonly string[])[];
  denies: readonly string[];
}): boolean {
  const { namespace, denies } = params;
  const literals = new Set<string>();
  for (const glob of [...params.layers.flat(), ...denies]) {
    for (const char of glob) {
      if (char !== "*") {
        literals.add(char);
      }
    }
  }
  // Characters no literal spells behave alike within their class, so one
  // representative per class (letter, digit, `_`, `-`) completes the alphabet;
  // a class whose every member is a literal is already fully present.
  const alphabet = new Set(literals);
  for (const classChars of ["abcdefghijklmnopqrstuvwxyz", "0123456789", "_", "-"]) {
    const fresh = classChars.split("").find((char) => !literals.has(char));
    if (fresh) {
      alphabet.add(fresh);
    }
  }
  const startRun = (globs: readonly string[]): GlobRun => {
    let run: GlobRun = { globs, positions: globs.map((glob) => closeGlobPositions(glob, [0])) };
    for (const char of namespace) {
      run = stepGlobRun(run, char);
    }
    return run;
  };
  type SearchState = { layers: GlobRun[]; deny: GlobRun; suffix: string };
  const initial: SearchState = {
    layers: params.layers.map((globs) => settleGlobRun(startRun(globs))),
    deny: startRun(denies),
    suffix: "",
  };
  // A layer none of whose globs survived the namespace can never accept, and a
  // deny already on its trailing `*` covers every name under it.
  if (initial.layers.some(globRunIsDead) || globRunAcceptsForever(initial.deny)) {
    return false;
  }
  // Positions decide the future; the suffix matters only through "started yet",
  // since a shorter suffix reaching the same positions can do anything a longer
  // one can within the same name budget.
  const keyOf = (state: SearchState) =>
    [state.suffix.length === 0 ? "" : "+", ...state.layers, state.deny]
      .map((run) =>
        typeof run === "string" ? run : run.positions.map((p) => p.join(".")).join(","),
      )
      .join("|");

  const visited = new Set<string>([keyOf(initial)]);
  const queue: SearchState[] = [initial];
  // `for…of` sees states pushed during iteration, so the queue needs no index.
  for (const state of queue) {
    const candidate = namespace + state.suffix;
    if (
      state.suffix.length > 0 &&
      state.layers.every(globRunAccepts) &&
      !globRunAccepts(state.deny) &&
      couldMaterializeToolName(candidate, namespace)
    ) {
      return true;
    }
    if (candidate.length >= TOOL_NAME_MAX_TOTAL) {
      continue;
    }
    for (const char of alphabet) {
      // Generated names open their suffix with a letter; nothing else can follow.
      if (state.suffix.length === 0 && !/[a-z]/.test(char)) {
        continue;
      }
      const next: SearchState = {
        layers: state.layers.map((run) => settleGlobRun(stepGlobRun(run, char))),
        deny: stepGlobRun(state.deny, char),
        suffix: state.suffix + char,
      };
      // Once a deny sits on its trailing `*` no extension escapes it, and a
      // layer with no live glob can never accept again.
      if (globRunAcceptsForever(next.deny) || next.layers.some(globRunIsDead)) {
        continue;
      }
      const key = keyOf(next);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Whether layered policies could still admit some tool inside a namespace prefix
 * (an MCP `server__`) whose tool names are unknown after a failed catalog load.
 * The allow globs of every layer and every deny glob are decided together over
 * the provider-safe name language, so `allow: ["memos__read*"]` plus
 * `deny: ["memos__read*"]` hides the namespace exactly as it hides the tools.
 */
export function policiesAdmitToolNamespace(
  prefix: string,
  policies: Array<SandboxToolPolicy | undefined>,
): boolean {
  const namespace = normalizeToolPolicyName(prefix);
  const layers: string[][] = [];
  const denies: string[] = [];
  for (const policy of policies) {
    const allow = realizableEntries(policy?.allow);
    // A layer whose allow list names nothing realizable admits no real tool.
    if (allow.length === 0 && expandToolGroups(policy?.allow).length > 0) {
      return false;
    }
    denies.push(...realizableEntries(policy?.deny));
    if (allow.length > 0) {
      layers.push(allow);
    }
  }
  return globLayersAdmitSomeName({ namespace, layers, denies });
}
