import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeString } from "../record-shared.js";
import type { SnapshotAriaNode } from "./client.types.js";
import {
  getRoleSnapshotStats,
  type RoleRefMap,
  type RoleSnapshotOptions,
} from "./pw-role-snapshot.js";
import { CONTENT_ROLES, INTERACTIVE_ROLES, STRUCTURAL_ROLES } from "./snapshot-roles.js";

export type ChromeMcpSnapshotNode = {
  id?: string;
  role?: string;
  name?: string;
  value?: string | number | boolean;
  description?: string;
  children?: ChromeMcpSnapshotNode[];
};

function normalizeRole(node: ChromeMcpSnapshotNode): string {
  const role = normalizeLowercaseStringOrEmpty(node.role);
  return role || "generic";
}

function escapeQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function shouldIncludeNode(params: {
  role: string;
  name?: string;
  options?: RoleSnapshotOptions;
}): boolean {
  if (params.options?.interactive && !INTERACTIVE_ROLES.has(params.role)) {
    return false;
  }
  if (params.options?.compact && STRUCTURAL_ROLES.has(params.role) && !params.name) {
    return false;
  }
  return true;
}

function shouldCreateRef(role: string, name?: string): boolean {
  return INTERACTIVE_ROLES.has(role) || (CONTENT_ROLES.has(role) && Boolean(name));
}

type DuplicateTracker = {
  counts: Map<string, number>;
  keysByRef: Map<string, string>;
  duplicates: Set<string>;
};

function createDuplicateTracker(): DuplicateTracker {
  return {
    counts: new Map(),
    keysByRef: new Map(),
    duplicates: new Set(),
  };
}

function registerRef(
  tracker: DuplicateTracker,
  ref: string,
  role: string,
  name?: string,
): number | undefined {
  const key = `${role}:${name ?? ""}`;
  const count = tracker.counts.get(key) ?? 0;
  tracker.counts.set(key, count + 1);
  tracker.keysByRef.set(ref, key);
  if (count > 0) {
    tracker.duplicates.add(key);
    return count;
  }
  return undefined;
}

export function flattenChromeMcpSnapshotToAriaNodes(
  root: ChromeMcpSnapshotNode,
  limit = 500,
): SnapshotAriaNode[] {
  const boundedLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const out: SnapshotAriaNode[] = [];

  const visit = (node: ChromeMcpSnapshotNode, depth: number) => {
    if (out.length >= boundedLimit) {
      return;
    }
    const ref = normalizeString(node.id);
    if (ref) {
      out.push({
        ref,
        role: normalizeRole(node),
        name: normalizeString(node.name) ?? "",
        value: normalizeString(node.value),
        description: normalizeString(node.description),
        depth,
      });
    }
    for (const child of node.children ?? []) {
      visit(child, depth + 1);
      if (out.length >= boundedLimit) {
        return;
      }
    }
  };

  visit(root, 0);
  return out;
}

export function buildAiSnapshotFromChromeMcpSnapshot(params: {
  root: ChromeMcpSnapshotNode;
  options?: RoleSnapshotOptions;
  maxChars?: number;
}): {
  snapshot: string;
  truncated?: boolean;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
} {
  const refs: RoleRefMap = {};
  const tracker = createDuplicateTracker();
  const lines: string[] = [];

  const visit = (node: ChromeMcpSnapshotNode, depth: number) => {
    const role = normalizeRole(node);
    const name = normalizeString(node.name);
    const value = normalizeString(node.value);
    const description = normalizeString(node.description);
    const maxDepth = params.options?.maxDepth;
    if (maxDepth !== undefined && depth > maxDepth) {
      return;
    }

    const includeNode = shouldIncludeNode({ role, name, options: params.options });
    if (includeNode) {
      let line = `${"  ".repeat(depth)}- ${role}`;
      if (name) {
        line += ` "${escapeQuoted(name)}"`;
      }
      const ref = normalizeString(node.id);
      if (ref && shouldCreateRef(role, name)) {
        const nth = registerRef(tracker, ref, role, name);
        refs[ref] = nth === undefined ? { role, name } : { role, name, nth };
        line += ` [ref=${ref}]`;
      }
      if (value) {
        line += ` value="${escapeQuoted(value)}"`;
      }
      if (description) {
        line += ` description="${escapeQuoted(description)}"`;
      }
      lines.push(line);
    }

    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  };

  visit(params.root, 0);

  for (const [ref, data] of Object.entries(refs)) {
    const key = tracker.keysByRef.get(ref);
    if (key && !tracker.duplicates.has(key)) {
      delete data.nth;
    }
  }

  let snapshot = lines.join("\n");
  let truncated = false;
  const maxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : undefined;
  if (maxChars && snapshot.length > maxChars) {
    snapshot = `${snapshot.slice(0, maxChars)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const stats = getRoleSnapshotStats(snapshot, refs);
  return truncated ? { snapshot, truncated, refs, stats } : { snapshot, refs, stats };
}
