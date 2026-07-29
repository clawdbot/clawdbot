import type { GatewaySessionRow } from "../api/types.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  rowDemandsVisibility,
  RowVisibilityReason,
  sidebarSessionAttentionPriority,
  type SidebarKnownSessionAttention,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

/**
 * Pure projection of flat session rows into the sidebar's parent/child tree.
 * Child links come from both directions (parent childSessions lists and child
 * spawnedBy/parentSessionKey backrefs); the ancestor set guards against cycles
 * in malformed link data.
 */
export function projectSessionTree(params: {
  roots: readonly GatewaySessionRow[];
  agentRows: readonly GatewaySessionRow[];
  childRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
  loadingChildKeys: ReadonlySet<string>;
  knownSessionAttention: readonly SidebarKnownSessionAttention[];
  toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession;
}): SidebarRecentSession[] {
  const {
    roots,
    agentRows,
    childRowsByParent,
    loadingChildKeys,
    knownSessionAttention,
    toSidebarSession,
  } = params;
  const rowsByKey = new Map<string, GatewaySessionRow>();
  for (const rows of Object.values(childRowsByParent)) {
    for (const row of rows) {
      rowsByKey.set(row.key, row);
    }
  }
  for (const row of agentRows) {
    rowsByKey.set(row.key, row);
  }
  const childKeysByParent = new Map<string, string[]>();
  const appendChild = (parentKey: string, childKey: string) => {
    const keys = childKeysByParent.get(parentKey) ?? [];
    if (!keys.includes(childKey)) {
      keys.push(childKey);
      childKeysByParent.set(parentKey, keys);
    }
  };
  for (const row of rowsByKey.values()) {
    for (const childKey of row.childSessions ?? []) {
      appendChild(row.key, childKey);
    }
  }
  for (const row of rowsByKey.values()) {
    const parentKey = row.spawnedBy ?? row.parentSessionKey;
    if (parentKey) {
      appendChild(parentKey, row.key);
    }
  }

  const build = (
    row: GatewaySessionRow,
    isChild: boolean,
    ancestors: ReadonlySet<string>,
  ): SidebarRecentSession => {
    const childSessionKeys = row.archived === true ? [] : (childKeysByParent.get(row.key) ?? []);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(row.key);
    const children = childSessionKeys.flatMap((key) => {
      const child = rowsByKey.get(key);
      return child && !nextAncestors.has(key) ? [build(child, true, nextAncestors)] : [];
    });
    const projected = toSidebarSession(row, isChild);
    const projectedRunningChildCount = children.reduce(
      (count, child) =>
        count +
        (child.hasActiveRun || child.status === "running" ? 1 : 0) +
        child.runningChildCount,
      0,
    );
    const runningChildCount = Math.max(
      projectedRunningChildCount,
      row.hasActiveSubagentRun ? 1 : 0,
    );
    const failedChildCount = children.reduce(
      (count, child) =>
        count +
        (child.status === "failed" || child.status === "timeout" ? 1 : 0) +
        child.failedChildCount,
      0,
    );
    // Conflict attention is transitive: a collapsed parent must expose staged
    // cloud results held by descendants or the recovery signal disappears.
    const workspaceConflictCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (projected.workspaceConflictCount ?? 0) +
        children.reduce((count, child) => count + (child.workspaceConflictCount ?? 0), 0),
    );
    const unloadedChildKeys = childSessionKeys.filter((key) => !rowsByKey.has(key));
    // Only direct unloaded children can match: parents carry their keys, but not grandchildren's.
    // Grandchildren join the normal transitive fold after their branch is materialized.
    const unloadedChildAttention = knownSessionAttention.reduce(
      (current, entry) =>
        unloadedChildKeys.some((key) => areUiSessionKeysEquivalent(entry.sessionKey, key)) &&
        sidebarSessionAttentionPriority(entry.attention) > sidebarSessionAttentionPriority(current)
          ? entry.attention
          : current,
      SIDEBAR_SESSION_NO_ATTENTION,
    );
    // Accepted gap: an unloaded failed child needs expansion before its error attention can surface.
    // Child attention is transitive just like live-run counts: a collapsed
    // ancestor remains actionable even when the blocked descendant is hidden.
    const attention = children.reduce(
      (current, child) =>
        rowDemandsVisibility(child, RowVisibilityReason.Attention) &&
        sidebarSessionAttentionPriority(child.attention) > sidebarSessionAttentionPriority(current)
          ? child.attention
          : current,
      sidebarSessionAttentionPriority(unloadedChildAttention) >
        sidebarSessionAttentionPriority(projected.attention)
        ? unloadedChildAttention
        : projected.attention,
    );
    return {
      ...projected,
      attention,
      childSessionKeys,
      children,
      loadingChildren: loadingChildKeys.has(row.key),
      containsActiveDescendant: children.some(
        (child) => child.active || child.visuallyActive || child.containsActiveDescendant,
      ),
      workspaceConflictCount: workspaceConflictCount || undefined,
      runningChildCount,
      failedChildCount,
    };
  };

  const rootKeys = new Set(roots.map((row) => row.key));
  return roots
    .filter((row) => {
      const parentKey = row.spawnedBy ?? row.parentSessionKey;
      return !parentKey || !rootKeys.has(parentKey);
    })
    .map((row) => build(row, false, new Set()));
}
