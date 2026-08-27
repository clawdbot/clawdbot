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

function parseRoleSnapshotLine(line: string) {
  const lineMatch = /^(\s*-\s*)(.*)$/s.exec(line);
  if (!lineMatch) {
    return null;
  }
  const prefix = lineMatch[1]!;
  let key = lineMatch[2]!;
  let scalar = "";
  // Playwright JSON-encodes names, then YAML-quotes the entire key when needed.
  // Decode only that emitted grammar; page text after the key never supplies refs.
  const quoted = key.startsWith("'");
  if (quoted) {
    // Delta annotation adds its marker after the original serialized line.
    const quotedKey = /^'((?:[^']|'')*)'(:.*|(?:\s+\[new\])?\s*)$/s.exec(key);
    if (!quotedKey) {
      return null;
    }
    key = quotedKey[1]!.replaceAll("''", "'");
    scalar = quotedKey[2]!;
  }
  const roleMatch = /^(\w+)(?=\s|:|$)/.exec(key);
  if (!roleMatch) {
    return null;
  }
  const roleRaw = roleMatch[1]!;
  let suffix = key.slice(roleRaw.length);
  let name: string | undefined;
  const nameStart = suffix.trimStart();
  if (nameStart.startsWith('"')) {
    const encoded = /^"(?:\\.|[^"\\])*"/.exec(nameStart)?.[0];
    if (!encoded) {
      return null;
    }
    try {
      name = JSON.parse(encoded) as string;
    } catch {
      return null;
    }
    suffix = nameStart.slice(encoded.length);
  } else if (nameStart.startsWith("/")) {
    // Slash-wrapped DOM names are emitted literally, even outside codegen mode.
    // A colon-space within the name forces YAML quoting; otherwise it ends the key.
    const scalarStart = quoted ? -1 : nameStart.search(/:(?:\s|$)/);
    const nameEnd =
      (scalarStart < 0 ? nameStart : nameStart.slice(0, scalarStart)).lastIndexOf("/") + 1;
    name = nameStart.slice(0, nameEnd);
    suffix = nameStart.slice(nameEnd);
  }
  const attributes = /^(?:\s+\[[^\]\r\n]*\])*/.exec(suffix)?.[0] ?? "";
  let ref: string | undefined;
  for (const attribute of attributes.matchAll(/\s+\[([^\]]*)\]/g)) {
    const match = /^ref=([^[\]\s]+)$/.exec(attribute[1]!);
    if (match) {
      ref = match[1];
      break;
    }
  }
  return {
    prefix,
    roleRaw,
    role: normalizeLowercaseStringOrEmpty(roleRaw),
    name,
    suffix: suffix + scalar,
    ref,
  };
}

/** Read a formatter-owned ref, excluding ref-looking names, values, and scalar text. */
export function findRoleSnapshotLineRef(line: string): string | undefined {
  return parseRoleSnapshotLine(line)?.ref;
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
    const hasRef = findRoleSnapshotLineRef(line) !== undefined;
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

  return entries
    .filter((entry) => entry.keep)
    .map((entry) => entry.line)
    .join("\n");
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

  const parsed = parseRoleSnapshotLine(line);
  if (!parsed) {
    return options.interactive ? null : line;
  }
  const { prefix, roleRaw, role, name, suffix } = parsed;
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

type InteractiveSnapshotLine = NonNullable<ReturnType<typeof parseRoleSnapshotLine>>;

function buildInteractiveSnapshotLines(params: {
  lines: string[];
  options: RoleSnapshotOptions;
  resolveRef: (parsed: InteractiveSnapshotLine) => { ref: string; nth?: number } | null;
  recordRef: (parsed: InteractiveSnapshotLine, ref: string, nth?: number) => void;
  includeSuffix: (suffix: string) => boolean;
}): string[] {
  const out: string[] = [];
  for (const line of params.lines) {
    if (params.options.maxDepth !== undefined && getIndentLevel(line) > params.options.maxDepth) {
      continue;
    }
    const parsed = parseRoleSnapshotLine(line);
    if (!parsed) {
      continue;
    }
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
    if (parsed.ref !== resolved.ref) {
      enhanced += ` [ref=${resolved.ref}]`;
    }
    if ((resolved.nth ?? 0) > 0) {
      enhanced += ` [nth=${resolved.nth}]`;
    }
    if (params.includeSuffix(parsed.suffix)) {
      enhanced += parsed.suffix;
    }
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
      includeSuffix: (suffix) => suffix.includes("["),
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
  return ref && /^(?:e\d+|\d{1,9})$/i.test(ref) ? ref : null;
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
      includeSuffix: () => true,
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

    const parsed = parseRoleSnapshotLine(line);
    if (!parsed) {
      out.push(line);
      continue;
    }
    const { role, name } = parsed;
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
