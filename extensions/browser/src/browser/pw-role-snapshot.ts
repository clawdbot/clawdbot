/**
 * Playwright role snapshot helpers.
 *
 * Converts ARIA or AI snapshots into compact role/name text with stable refs
 * and duplicate disambiguation for agent actions.
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CONTENT_ROLES, INTERACTIVE_ROLES, STRUCTURAL_ROLES } from "./snapshot-roles.js";

type RoleRef = {
  role: string;
  name?: string;
  /** Index used only when role+name duplicates exist. */
  nth?: number;
};

/** Mapping from generated role refs to role/name metadata. */
export type RoleRefMap = Record<string, RoleRef>;

/** Identity strategy used to compare consecutive ref-bearing snapshots. */
export type RoleSnapshotIdentityMode = "role" | "aria";

type RoleSnapshotStats = {
  lines: number;
  chars: number;
  refs: number;
  interactive: number;
};

const ROLE_SNAPSHOT_TRUNCATION_MARKER = "[...TRUNCATED - page too large]";

/** Options for filtering and compacting role snapshots. */
export type RoleSnapshotOptions = {
  /** Only include interactive elements (buttons, links, inputs, etc.). */
  interactive?: boolean;
  /** Maximum depth to include (0 = root only). */
  maxDepth?: number;
  /** Remove unnamed structural elements and empty branches. */
  compact?: boolean;
};

/** Read formatter-owned refs without interpreting names or scalar page content. */
export function findRoleSnapshotLineRef(line: string): string | undefined {
  return parseSnapshotLine(line)?.ref;
}

function getRoleSnapshotIdentityKey(
  ref: string,
  value: RoleRef,
  mode: RoleSnapshotIdentityMode,
): string {
  return mode === "aria" ? ref : `${value.role}\0${value.name ?? ""}\0${value.nth ?? 0}`;
}

/** Build the stable identity set used for per-tab snapshot deltas. */
export function getRoleSnapshotIdentityKeys<T extends RoleRef>(
  refs: Record<string, T>,
  mode: RoleSnapshotIdentityMode,
): Set<string> {
  // Duplicate role+name elements are identified positionally by nth, so insertion can mark a
  // sibling duplicate. This is acceptable: they are actor-indistinguishable without DOM backing.
  return new Set(
    Object.entries(refs).map(([ref, value]) => getRoleSnapshotIdentityKey(ref, value, mode)),
  );
}

/** Mark ref-bearing lines that were absent from the previous compatible snapshot. */
function annotateRoleSnapshotDelta<T extends RoleRef>(params: {
  lines: string[];
  refs: Record<string, T>;
  mode: RoleSnapshotIdentityMode;
  previousKeys: ReadonlySet<string>;
}): boolean {
  const markedKeys = new Set<string>();
  for (const [index, line] of params.lines.entries()) {
    const ref = findRoleSnapshotLineRef(line);
    const value = ref && Object.hasOwn(params.refs, ref) ? params.refs[ref] : undefined;
    if (!ref || !value) {
      continue;
    }
    const key = getRoleSnapshotIdentityKey(ref, value, params.mode);
    if (params.previousKeys.has(key)) {
      continue;
    }
    params.lines[index] = `${line} [new]`;
    markedKeys.add(key);
  }
  if (markedKeys.size === 0) {
    return false;
  }
  params.lines.push(`${markedKeys.size} new element(s) since last snapshot`);
  return true;
}

function truncateRoleSnapshot(lines: readonly string[], maxChars: number): string {
  const marker =
    maxChars >= ROLE_SNAPSHOT_TRUNCATION_MARKER.length ? ROLE_SNAPSHOT_TRUNCATION_MARKER : "…";
  let prefix = "";
  for (const line of lines) {
    const candidate = prefix ? `${prefix}\n${line}` : line;
    if (candidate.length + 2 + marker.length > maxChars) {
      break;
    }
    prefix = candidate;
  }
  return prefix ? `${prefix}\n\n${marker}` : marker;
}

/** Apply the final output budget, then keep only refs present on complete output lines. */
export function finalizeRoleSnapshot<T extends RoleRef>(params: {
  snapshot: string;
  refs: Record<string, T>;
  maxChars?: number;
  delta?: {
    mode: RoleSnapshotIdentityMode;
    previousKeys?: ReadonlySet<string>;
  };
}): {
  snapshot: string;
  truncated?: boolean;
  refs: Record<string, T>;
  stats: RoleSnapshotStats;
  newElements?: number;
} {
  const normalizedMaxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : undefined;
  const maxChars = normalizedMaxChars && normalizedMaxChars > 0 ? normalizedMaxChars : undefined;
  const delta = params.delta;
  const previousKeys = delta?.previousKeys;
  const sourceLines = params.snapshot.split("\n");
  const annotated =
    delta && previousKeys !== undefined
      ? annotateRoleSnapshotDelta({
          lines: sourceLines,
          refs: params.refs,
          mode: delta.mode,
          previousKeys,
        })
      : false;
  const sourceSnapshot = annotated ? sourceLines.join("\n") : params.snapshot;
  const truncated = maxChars !== undefined && sourceSnapshot.length > maxChars;
  const snapshot = truncated ? truncateRoleSnapshot(sourceLines, maxChars) : sourceSnapshot;
  const outputLines = truncated ? snapshot.split("\n") : sourceLines;
  const visibleRefs = new Set<string>();
  for (const line of outputLines) {
    const ref = findRoleSnapshotLineRef(line);
    if (ref) {
      visibleRefs.add(ref);
    }
  }
  const visibleEntries: Array<[string, T]> = [];
  const newKeys = previousKeys !== undefined ? new Set<string>() : undefined;
  let interactive = 0;
  for (const [ref, value] of Object.entries(params.refs)) {
    if (!visibleRefs.has(ref)) {
      continue;
    }
    visibleEntries.push([ref, value]);
    if (INTERACTIVE_ROLES.has(value.role)) {
      interactive += 1;
    }
    if (newKeys && delta && previousKeys !== undefined) {
      const key = getRoleSnapshotIdentityKey(ref, value, delta.mode);
      if (!previousKeys.has(key)) {
        newKeys.add(key);
      }
    }
  }
  const refs = Object.fromEntries(visibleEntries) as Record<string, T>;
  const newElements = newKeys?.size;
  const stats: RoleSnapshotStats = {
    lines: snapshot ? outputLines.length : 0,
    chars: snapshot.length,
    refs: visibleEntries.length,
    interactive,
  };
  const result = {
    snapshot,
    refs,
    stats,
    ...(newElements !== undefined ? { newElements } : {}),
  };
  return truncated ? { ...result, truncated: true } : result;
}

function getIndentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  const indent = match?.[1];
  return indent === undefined ? 0 : Math.floor(indent.length / 2);
}

function parseSnapshotLine(line: string) {
  const entry = line.match(/^(\s*-\s+)(.*)$/s);
  if (!entry) {
    return null;
  }
  const prefix = entry[1]!;
  const content = entry[2]!;
  // Playwright JSON-encodes names, then single-quotes YAML keys when required.
  // Keep the token lexical here: the shared finalizer also consumes MCP text.
  const quoted = content.match(/^'((?:[^']|'')*)'(.*)$/s);
  const key = quoted ? quoted[1]!.replaceAll("''", "'") : content;
  const match = key.match(/^(\w+)(?:\s+("(?:\\.|[^"\\])*"))?(.*)$/s);
  if (!match) {
    return null;
  }
  const roleRaw = match[1]!;
  let nameToken = match[2];
  let suffix = match[3]!;
  // Slash-delimited names are emitted literally outside codegen mode. An
  // unquoted YAML value cannot be part of that name (even if it contains '/').
  if (nameToken === undefined && suffix.startsWith(" /")) {
    const header = quoted ? suffix : suffix.split(/:(?=\s|$)/, 1)[0]!;
    const literal = header.match(/^ (\/(?:.*\/)?)/s);
    if (literal) {
      nameToken = literal[1]!;
      suffix = suffix.slice(literal[0].length);
    }
  }
  // Only consecutive bracket attributes inside the key belong to the formatter.
  // Values, descriptions, nested brackets, and the quoted key's tail are page text.
  const attributes = suffix.match(/^(?:\s+\[[^\][]*\])*/)?.[0];
  const ref = attributes?.match(/\[ref=([^\][]+)\]/)?.[1];
  return {
    prefix,
    roleRaw,
    role: normalizeLowercaseStringOrEmpty(roleRaw),
    nameToken,
    ref,
    suffix: suffix + (quoted?.[2] ?? ""),
  };
}

function decodeSnapshotName(nameToken: string | undefined): string | undefined {
  return nameToken?.startsWith('"') ? JSON.parse(nameToken) : nameToken;
}

type RoleNameTracker = {
  counts: Map<string, number>;
  refsByKey: Map<string, string[]>;
  getKey: (role: string, name?: string) => string;
  getNextIndex: (role: string, name?: string) => number;
  trackRef: (role: string, name: string | undefined, ref: string) => void;
  getDuplicateKeys: () => Set<string>;
};

function createRoleNameTracker(): RoleNameTracker {
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();
  return {
    counts,
    refsByKey,
    getKey(role: string, name?: string) {
      return `${role}:${name ?? ""}`;
    },
    getNextIndex(role: string, name?: string) {
      const key = this.getKey(role, name);
      const current = counts.get(key) ?? 0;
      counts.set(key, current + 1);
      return current;
    },
    trackRef(role: string, name: string | undefined, ref: string) {
      const key = this.getKey(role, name);
      const list = refsByKey.get(key) ?? [];
      list.push(ref);
      refsByKey.set(key, list);
    },
    getDuplicateKeys() {
      const out = new Set<string>();
      for (const [key, refs] of refsByKey) {
        if (refs.length > 1) {
          out.add(key);
        }
      }
      return out;
    },
  };
}

function removeNthFromNonDuplicates(refs: RoleRefMap, tracker: RoleNameTracker) {
  const duplicates = tracker.getDuplicateKeys();
  for (const [ref, data] of Object.entries(refs)) {
    const key = tracker.getKey(data.role, data.name);
    if (!duplicates.has(key)) {
      delete refs[ref]?.nth;
    }
  }
}

function compactTree(tree: string) {
  const lines = tree.split("\n");
  const entries: Array<{ line: string; keep: boolean; hasRef: boolean; indent: number }> = [];
  const stack: Array<{ entry: (typeof entries)[number]; indent: number }> = [];

  const finishEntry = () => {
    const current = stack.pop();
    if (!current) {
      return;
    }
    current.entry.keep ||= current.entry.hasRef;
    if (current.entry.hasRef && stack.length > 0) {
      const parent = stack.at(-1);
      if (parent !== undefined) {
        parent.entry.hasRef = true;
      }
    }
  };

  for (const line of lines) {
    const indent = getIndentLevel(line);
    while (stack.length > 0) {
      const lastEntry = expectDefined(stack.at(-1), "non-empty role snapshot stack");
      if (lastEntry.indent < indent) {
        break;
      }
      finishEntry();
    }
    const hasRef = Boolean(findRoleSnapshotLineRef(line));
    const entry = {
      line,
      keep: hasRef || (line.includes(":") && !line.trimEnd().endsWith(":")),
      hasRef,
      indent,
    };
    entries.push(entry);
    stack.push({ entry, indent });
  }
  while (stack.length > 0) {
    finishEntry();
  }

  const compacted = entries
    .filter((entry) => entry.keep)
    .map((entry) => entry.line)
    .join("\n");
  return compacted || "(empty)";
}

function processLine(
  line: string,
  refs: RoleRefMap,
  options: RoleSnapshotOptions,
  tracker: RoleNameTracker,
  nextRef: () => string,
): string | null {
  const depth = getIndentLevel(line);
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return null;
  }

  const parsed = parseSnapshotLine(line);
  if (!parsed) {
    return options.interactive ? null : line;
  }
  const { prefix, roleRaw, role, suffix } = parsed;
  const name = decodeSnapshotName(parsed.nameToken);
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isContent = CONTENT_ROLES.has(role);
  const isStructural = STRUCTURAL_ROLES.has(role);

  if (options.interactive && !isInteractive) {
    return null;
  }
  if (options.compact && isStructural && !name) {
    return null;
  }

  const shouldHaveRef = isInteractive || (isContent && name);
  if (!shouldHaveRef) {
    return line;
  }

  const ref = nextRef();
  const nth = tracker.getNextIndex(role, name);
  tracker.trackRef(role, name, ref);
  refs[ref] = {
    role,
    name,
    nth,
  };

  let enhanced = `${prefix}${roleRaw}`;
  if (name) {
    enhanced += ` ${JSON.stringify(name)}`;
  }
  enhanced += ` [ref=${ref}]`;
  if (nth > 0) {
    enhanced += ` [nth=${nth}]`;
  }
  if (suffix) {
    enhanced += suffix;
  }
  return enhanced;
}

type InteractiveSnapshotLine = NonNullable<ReturnType<typeof parseSnapshotLine>> & {
  name?: string;
};

function buildInteractiveSnapshotLines(params: {
  lines: string[];
  options: RoleSnapshotOptions;
  resolveRef: (parsed: InteractiveSnapshotLine) => { ref: string; nth?: number } | null;
  recordRef: (parsed: InteractiveSnapshotLine, ref: string, nth?: number) => void;
  formatSuffix: (suffix: string, ref: string) => string;
}): string[] {
  const out: string[] = [];
  for (const line of params.lines) {
    if (params.options.maxDepth !== undefined && getIndentLevel(line) > params.options.maxDepth) {
      continue;
    }
    const entry = parseSnapshotLine(line);
    if (!entry) {
      continue;
    }
    const parsed = { ...entry, name: decodeSnapshotName(entry.nameToken) };
    if (!INTERACTIVE_ROLES.has(parsed.role)) {
      continue;
    }
    const resolved = params.resolveRef(parsed);
    if (!resolved?.ref) {
      continue;
    }
    params.recordRef(parsed, resolved.ref, resolved.nth);

    let enhanced = `- ${parsed.roleRaw}`;
    if (parsed.name) {
      enhanced += ` ${JSON.stringify(parsed.name)}`;
    }
    enhanced += ` [ref=${resolved.ref}]`;
    if ((resolved.nth ?? 0) > 0) {
      enhanced += ` [nth=${resolved.nth}]`;
    }
    enhanced += params.formatSuffix(parsed.suffix, resolved.ref);
    out.push(enhanced);
  }
  return out;
}

/** Normalize a role snapshot ref accepted by browser actions. */
export function parseRoleRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.startsWith("@")
    ? trimmed.slice(1)
    : trimmed.startsWith("ref=")
      ? trimmed.slice(4)
      : trimmed;
  if (/^e\d+$/i.test(normalized)) {
    return normalized;
  }
  if (/^\d{1,9}$/.test(normalized)) {
    return normalized;
  }
  return null;
}

/** Build a role snapshot and refs from Playwright ARIA snapshot text. */
export function buildRoleSnapshotFromAriaSnapshot(
  ariaSnapshot: string,
  options: RoleSnapshotOptions = {},
): { snapshot: string; refs: RoleRefMap } {
  const lines = ariaSnapshot.split("\n");
  const refs: RoleRefMap = {};
  const tracker = createRoleNameTracker();

  let counter = 0;
  const nextRef = () => {
    counter += 1;
    return `e${counter}`;
  };

  if (options.interactive) {
    const result = buildInteractiveSnapshotLines({
      lines,
      options,
      resolveRef: ({ role, name }) => {
        const ref = nextRef();
        const nth = tracker.getNextIndex(role, name);
        tracker.trackRef(role, name, ref);
        return { ref, nth };
      },
      recordRef: ({ role, name }, ref, nth) => {
        refs[ref] = {
          role,
          name,
          nth,
        };
      },
      formatSuffix: (suffix) => (suffix.includes("[") ? suffix : ""),
    });

    removeNthFromNonDuplicates(refs, tracker);

    return {
      snapshot: result.join("\n") || "(no interactive elements)",
      refs,
    };
  }

  const result: string[] = [];
  for (const line of lines) {
    const processed = processLine(line, refs, options, tracker, nextRef);
    if (processed !== null) {
      result.push(processed);
    }
  }

  removeNthFromNonDuplicates(refs, tracker);

  const tree = result.join("\n") || "(empty)";
  return {
    snapshot: options.compact ? compactTree(tree) : tree,
    refs,
  };
}

function parseAiSnapshotRef(ref: string | undefined): string | null {
  // Playwright's page-wide AI snapshots qualify element refs with a frame seq.
  return ref && /^(?:f\d+)?e\d+$|^\d{1,9}$/i.test(ref) ? ref : null;
}

/**
 * Build a role snapshot from Playwright's AI snapshot output while preserving Playwright's own
 * aria-ref ids (e.g. ref=e13). This makes the refs self-resolving across calls.
 */
/** Build a role snapshot and refs from Playwright AI snapshot text. */
export function buildRoleSnapshotFromAiSnapshot(
  aiSnapshot: string,
  options: RoleSnapshotOptions = {},
): { snapshot: string; refs: RoleRefMap } {
  const lines = aiSnapshot.split("\n");
  const refs: RoleRefMap = {};

  if (options.interactive) {
    const out = buildInteractiveSnapshotLines({
      lines,
      options,
      resolveRef: (parsed) => {
        const ref = parseAiSnapshotRef(parsed.ref);
        return ref ? { ref } : null;
      },
      recordRef: ({ role, name }, ref) => {
        refs[ref] = { role, ...(name ? { name } : {}) };
      },
      formatSuffix: (suffix, ref) => suffix.replace(` [ref=${ref}]`, ""),
    });
    return {
      snapshot: out.join("\n") || "(no interactive elements)",
      refs,
    };
  }

  const out: string[] = [];
  for (const line of lines) {
    const depth = getIndentLevel(line);
    if (options.maxDepth !== undefined && depth > options.maxDepth) {
      continue;
    }

    const parsed = parseSnapshotLine(line);
    if (!parsed) {
      out.push(line);
      continue;
    }
    const { role } = parsed;
    const name = decodeSnapshotName(parsed.nameToken);
    const isStructural = STRUCTURAL_ROLES.has(role);

    if (options.compact && isStructural && !name) {
      continue;
    }

    const ref = parseAiSnapshotRef(parsed.ref);
    if (ref) {
      refs[ref] = { role, ...(name ? { name } : {}) };
    }

    out.push(line);
  }

  const tree = out.join("\n") || "(empty)";
  return {
    snapshot: options.compact ? compactTree(tree) : tree,
    refs,
  };
}
