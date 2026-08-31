/**
 * Chrome MCP snapshot conversion helpers.
 *
 * Converts chrome-devtools-mcp structured snapshots into OpenClaw ARIA nodes
 * and compact AI snapshots with stable refs and duplicate tracking.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SnapshotAriaNode } from "./client.types.js";
import type { RoleRefMap, RoleSnapshotOptions } from "./pw-role-snapshot.js";
import { ROLE_SNAPSHOT_MAX_DEPTH } from "./snapshot-depth-limit.js";
import { CONTENT_ROLES, INTERACTIVE_ROLES, STRUCTURAL_ROLES } from "./snapshot-roles.js";

/** Structured snapshot node shape returned by chrome-devtools-mcp. */
export type ChromeMcpSnapshotNode = {
  id?: string;
  role?: string;
  name?: string;
  value?: string | number | boolean;
  description?: string;
  children?: ChromeMcpSnapshotNode[];
};

function normalizeSnapshotString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function normalizeRole(node: ChromeMcpSnapshotNode): string {
  const role = normalizeLowercaseStringOrEmpty(node.role);
  return role || "generic";
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

/** Build ARIA nodes while preserving whether a traversal ceiling omitted input. */
export function flattenChromeMcpSnapshotToAriaResult(
  root: ChromeMcpSnapshotNode,
  limit = 500,
): { nodes: SnapshotAriaNode[]; truncated?: true } {
  const boundedLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const out: SnapshotAriaNode[] = [];
  let truncated = false;

  const visit = (node: ChromeMcpSnapshotNode, depth: number) => {
    if (out.length >= boundedLimit) {
      truncated = true;
      return;
    }
    if (depth > ROLE_SNAPSHOT_MAX_DEPTH) {
      truncated = true;
      return;
    }
    const ref = normalizeSnapshotString(node.id);
    if (ref) {
      out.push({
        ref,
        role: normalizeRole(node),
        name: normalizeSnapshotString(node.name) ?? "",
        value: normalizeSnapshotString(node.value),
        description: normalizeSnapshotString(node.description),
        depth,
      });
    }
    const children = node.children ?? [];
    for (const [index, child] of children.entries()) {
      visit(child, depth + 1);
      if (out.length >= boundedLimit) {
        truncated ||= index + 1 < children.length;
        return;
      }
    }
  };

  visit(root, 0);
  return truncated ? { nodes: out, truncated: true } : { nodes: out };
}

/** Build a compact text snapshot and ref map from a Chrome MCP snapshot tree. */
export function buildAiSnapshotFromChromeMcpSnapshot(params: {
  root: ChromeMcpSnapshotNode;
  options?: RoleSnapshotOptions;
}): {
  snapshot: string;
  refs: RoleRefMap;
  truncated?: true;
} {
  const refs: RoleRefMap = {};
  const counts = new Map<string, number>();
  const lines: string[] = [];
  const maxDepth = Math.min(
    params.options?.maxDepth ?? ROLE_SNAPSHOT_MAX_DEPTH,
    ROLE_SNAPSHOT_MAX_DEPTH,
  );
  const hardLimitApplied =
    params.options?.maxDepth === undefined || params.options.maxDepth >= ROLE_SNAPSHOT_MAX_DEPTH;
  let truncated = false;

  const visit = (node: ChromeMcpSnapshotNode, depth: number) => {
    if (depth > maxDepth) {
      truncated ||= hardLimitApplied;
      return;
    }
    const role = normalizeRole(node);
    const name = normalizeSnapshotString(node.name);
    const value = normalizeSnapshotString(node.value);
    const description = normalizeSnapshotString(node.description);

    const includeNode = shouldIncludeNode({ role, name, options: params.options });
    if (includeNode) {
      let line = `${"  ".repeat(depth)}- ${role}`;
      if (name) {
        line += ` ${JSON.stringify(name)}`;
      }
      const ref = normalizeSnapshotString(node.id);
      if (ref && shouldCreateRef(role, name)) {
        const key = `${role}:${name ?? ""}`;
        const nth = counts.get(key);
        counts.set(key, (nth ?? 0) + 1);
        refs[ref] = nth === undefined ? { role, name } : { role, name, nth };
        line += ` [ref=${ref}]`;
      }
      if (value) {
        line += ` value=${JSON.stringify(value)}`;
      }
      if (description) {
        line += ` description=${JSON.stringify(description)}`;
      }
      lines.push(line);
    }

    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  };

  visit(params.root, 0);

  const result = { snapshot: lines.join("\n"), refs };
  return truncated ? { ...result, truncated: true } : result;
}
