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

type RoleSnapshotStats = {
  lines: number;
  chars: number;
  refs: number;
  interactive: number;
};

const ROLE_SNAPSHOT_TRUNCATION_MARKER = "[...TRUNCATED - page too large]";
// A formatter ref precedes any YAML scalar delimiter; ref-looking scalar text is hostile page content.
const ROLE_SNAPSHOT_LINE_REF_RE = /^\s*-\s+\w+(?:\s+"(?:\\.|[^"\\])*")?[^:]*?\[ref=([^\]]+)\]/;

/** Options for filtering and compacting role snapshots. */
export type RoleSnapshotOptions = {
  /** Only include interactive elements (buttons, links, inputs, etc.). */
  interactive?: boolean;
  /** Maximum depth to include (0 = root only). */
  maxDepth?: number;
  /** Remove unnamed structural elements and empty branches. */
  compact?: boolean;
};

/** Compute snapshot line/char/ref statistics. */
export function getRoleSnapshotStats<T extends { role: string }>(
  snapshot: string,
  refs: Record<string, T>,
): RoleSnapshotStats {
  const interactive = Object.values(refs).filter((r) => INTERACTIVE_ROLES.has(r.role)).length;
  return {
    lines: snapshot ? snapshot.split("\n").length : 0,
    chars: snapshot.length,
    refs: Object.keys(refs).length,
    interactive,
  };
}

function findSnapshotLineRef(line: string): string | undefined {
  return ROLE_SNAPSHOT_LINE_REF_RE.exec(line)?.[1];
}

function truncateRoleSnapshot(snapshot: string, maxChars: number): string {
  const marker =
    maxChars >= ROLE_SNAPSHOT_TRUNCATION_MARKER.length ? ROLE_SNAPSHOT_TRUNCATION_MARKER : "…";
  let prefix = "";
  for (const line of snapshot.split("\n")) {
    const candidate = prefix ? `${prefix}\n${line}` : line;
    if (candidate.length + 2 + marker.length > maxChars) {
      break;
    }
    prefix = candidate;
  }
  return prefix ? `${prefix}\n\n${marker}` : marker;
}

/** Apply the final output budget, then keep only refs present on complete output lines. */
export function finalizeRoleSnapshot<T extends { role: string }>(params: {
  snapshot: string;
  refs: Record<string, T>;
  maxChars?: number;
}): {
  snapshot: string;
  truncated?: boolean;
  refs: Record<string, T>;
  stats: RoleSnapshotStats;
} {
  const normalizedMaxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : undefined;
  const maxChars = normalizedMaxChars && normalizedMaxChars > 0 ? normalizedMaxChars : undefined;
  const truncated = maxChars !== undefined && params.snapshot.length > maxChars;
  const snapshot = truncated ? truncateRoleSnapshot(params.snapshot, maxChars) : params.snapshot;
  const visibleRefs = new Set(
    snapshot
      .split("\n")
      .map(findSnapshotLineRef)
      .filter((ref): ref is string => Boolean(ref)),
  );
  const refs = Object.fromEntries(
    Object.entries(params.refs).filter(([ref]) => visibleRefs.has(ref)),
  ) as Record<string, T>;
  const result = {
    snapshot,
    refs,
    stats: getRoleSnapshotStats(snapshot, refs),
  };
  return truncated ? { ...result, truncated: true } : result;
}

function getIndentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  const indent = match?.[1];
  return indent === undefined ? 0 : Math.floor(indent.length / 2);
}

function matchInteractiveSnapshotLine(
  line: string,
  options: RoleSnapshotOptions,
): { roleRaw: string; role: string; name?: string; suffix: string } | null {
  const depth = getIndentLevel(line);
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return null;
  }
  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
  if (!match) {
    return null;
  }
  const roleRaw = match[2];
  const name = match[3];
  const suffix = match[4];
  if (roleRaw === undefined || suffix === undefined) {
    return null;
  }
  if (roleRaw.startsWith("/")) {
    return null;
  }
  const role = normalizeLowercaseStringOrEmpty(roleRaw);
  return {
    roleRaw,
    role,
    ...(name ? { name } : {}),
    suffix,
  };
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
    const entry = {
      line,
      keep: line.includes("[ref=") || (line.includes(":") && !line.trimEnd().endsWith(":")),
      hasRef: line.includes("[ref="),
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

  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
  if (!match) {
    return options.interactive ? null : line;
  }

  const prefix = match[1];
  const roleRaw = match[2];
  const name = match[3];
  const suffix = match[4];
  if (prefix === undefined || roleRaw === undefined || suffix === undefined) {
    return options.interactive ? null : line;
  }
  if (roleRaw.startsWith("/")) {
    return options.interactive ? null : line;
  }

  const role = normalizeLowercaseStringOrEmpty(roleRaw);
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
    enhanced += ` "${name}"`;
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

type InteractiveSnapshotLine = NonNullable<ReturnType<typeof matchInteractiveSnapshotLine>>;

function buildInteractiveSnapshotLines(params: {
  lines: string[];
  options: RoleSnapshotOptions;
  resolveRef: (parsed: InteractiveSnapshotLine) => { ref: string; nth?: number } | null;
  recordRef: (parsed: InteractiveSnapshotLine, ref: string, nth?: number) => void;
  includeSuffix: (suffix: string) => boolean;
}): string[] {
  const out: string[] = [];
  for (const line of params.lines) {
    const parsed = matchInteractiveSnapshotLine(line, params.options);
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
      enhanced += ` "${parsed.name}"`;
    }
    enhanced += ` [ref=${resolved.ref}]`;
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

function parseAiSnapshotRef(suffix: string): string | null {
  const eMatch = suffix.match(/\[ref=(e\d+)\]/i);
  if (eMatch) {
    return eMatch[1] ?? null;
  }
  const numMatch = suffix.match(/\[ref=(\d{1,9})\]/);
  return numMatch?.[1] ?? null;
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
      resolveRef: ({ suffix }) => {
        const ref = parseAiSnapshotRef(suffix);
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

    const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    const roleRaw = match[2];
    const name = match[3];
    const suffix = match[4];
    if (roleRaw === undefined || suffix === undefined) {
      out.push(line);
      continue;
    }
    if (roleRaw.startsWith("/")) {
      out.push(line);
      continue;
    }

    const role = normalizeLowercaseStringOrEmpty(roleRaw);
    const isStructural = STRUCTURAL_ROLES.has(role);

    if (options.compact && isStructural && !name) {
      continue;
    }

    const ref = parseAiSnapshotRef(suffix);
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
