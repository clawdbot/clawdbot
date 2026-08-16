import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { preserveRosterPresentationMetadata } from "../lib/sessions/reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";
export { fetchChildSessionRows } from "../lib/sessions/child-session-data.ts";

const MAX_SESSION_LINEAGE_DEPTH = 16;

export function collectKnownSessionRows(
  rootRows: readonly GatewaySessionRow[],
  childRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>,
): Map<string, GatewaySessionRow> {
  const rows = new Map(rootRows.map((row) => [row.key, row]));
  for (const childRows of Object.values(childRowsByParent)) {
    for (const row of childRows) {
      rows.set(row.key, row);
    }
  }
  return rows;
}

export async function fetchSessionLineage(params: {
  client: GatewayBrowserClient;
  sessionKey: string;
  knownRows: Map<string, GatewaySessionRow>;
  isCurrent: () => boolean;
}): Promise<{
  rowsByParent: Record<string, GatewaySessionRow[]>;
  topmostRow: GatewaySessionRow | null;
  lookupFailed: boolean;
} | null> {
  const rowsByParent: Record<string, GatewaySessionRow[]> = {};
  let currentKey = params.sessionKey;
  let topmostRow: GatewaySessionRow | null = null;
  let lookupFailed = false;
  const visited = new Set<string>();
  try {
    // Session ancestry is untrusted persisted state. Bound traversal so a
    // malformed cycle cannot leave direct child routes spinning forever.
    for (let depth = 0; depth < MAX_SESSION_LINEAGE_DEPTH && !visited.has(currentKey); depth += 1) {
      visited.add(currentKey);
      let row = params.knownRows.get(currentKey);
      if (!row) {
        const described = await params.client.request<{ session?: GatewaySessionRow | null }>(
          "sessions.describe",
          { key: currentKey },
        );
        if (!params.isCurrent()) {
          return null;
        }
        row = described?.session
          ? { ...described.session, runtimeSampledAt: Date.now() }
          : undefined;
        if (!row) {
          break;
        }
        params.knownRows.set(row.key, row);
      }
      topmostRow = row;
      const parentKey = resolveUiSessionNavigationParentKey(row);
      if (!parentKey) {
        break;
      }
      const siblings = rowsByParent[parentKey] ?? [];
      rowsByParent[parentKey] = [...siblings.filter((candidate) => candidate.key !== row.key), row];
      currentKey = parentKey;
    }
  } catch {
    lookupFailed = true;
  }
  return { rowsByParent, topmostRow, lookupFailed };
}

function mergeChildSessionRows(
  current: Readonly<Record<string, readonly GatewaySessionRow[]>>,
  additions: Readonly<Record<string, readonly GatewaySessionRow[]>>,
): Record<string, GatewaySessionRow[]> {
  const merged = Object.fromEntries(
    Object.entries(current).map(([parentKey, rows]) => [parentKey, [...rows]]),
  );
  for (const [parentKey, rows] of Object.entries(additions)) {
    const children = merged[parentKey] ?? [];
    for (const row of rows) {
      if (!children.some((candidate) => candidate.key === row.key)) {
        children.push(row);
      }
    }
    merged[parentKey] = children;
  }
  return merged;
}

/** Retain only the routed ancestry while a canonical refresh invalidates other child snapshots. */
export function preserveActiveSessionLineageRows(
  sessionKey: string | null,
  rowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>,
): Readonly<Record<string, readonly GatewaySessionRow[]>> {
  const preserved: Record<string, readonly GatewaySessionRow[]> = {};
  let childKey = sessionKey?.trim();
  const visited = new Set<string>();
  while (childKey && !visited.has(childKey)) {
    visited.add(childKey);
    const parent = Object.entries(rowsByParent).find(([, rows]) =>
      rows.some((row) => areUiSessionKeysEquivalent(row.key, childKey)),
    );
    if (!parent) {
      break;
    }
    preserved[parent[0]] = parent[1].filter((row) => areUiSessionKeysEquivalent(row.key, childKey));
    childKey = parent[0];
  }
  return preserved;
}

export function publishActiveSessionLineage(
  owner: {
    activeSessionLineageRoot: GatewaySessionRow | null;
    activeSessionLineageSelectedRow: GatewaySessionRow | null;
    childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
    context?: {
      gateway?: { snapshot: { sessionKey?: string | null } };
      sessions: Pick<SessionCapability, "reconcile">;
    };
    sessionsResult: SessionsListResult | null;
  },
  sessionKey: string,
  lineage: NonNullable<Awaited<ReturnType<typeof fetchSessionLineage>>>,
): void {
  const previousRoot = owner.activeSessionLineageRoot;
  const previousSelectedRow = owner.activeSessionLineageSelectedRow;
  const preserveLineageRow = (row: GatewaySessionRow): GatewaySessionRow => {
    const previous = areUiSessionKeysEquivalent(row.key, sessionKey)
      ? previousSelectedRow
      : previousRoot && areUiSessionKeysEquivalent(row.key, previousRoot.key)
        ? previousRoot
        : null;
    return preserveRosterPresentationMetadata(row, previous ?? undefined);
  };
  const topmostRow = lineage.topmostRow ? preserveLineageRow(lineage.topmostRow) : null;
  const rowsByParent = Object.fromEntries(
    Object.entries(lineage.rowsByParent).map(([parentKey, rows]) => [
      parentKey,
      rows.map(preserveLineageRow),
    ]),
  );
  owner.childSessionRowsByParent = mergeChildSessionRows(
    owner.childSessionRowsByParent,
    rowsByParent,
  );
  owner.activeSessionLineageRoot = topmostRow;
  // Prefer the fetched lineage on ties, but keep a newer child-list snapshot
  // so a delayed describe cannot regress already-settled run state.
  const selectedRow = [
    topmostRow,
    ...Object.values(rowsByParent).flat(),
    ...collectKnownSessionRows(
      owner.sessionsResult?.sessions ?? [],
      owner.childSessionRowsByParent,
    ).values(),
  ]
    .filter(
      (row): row is GatewaySessionRow =>
        row != null && areUiSessionKeysEquivalent(row.key, sessionKey),
    )
    .reduce<GatewaySessionRow | undefined>((freshest, row) => {
      return !freshest || (row.updatedAt ?? 0) > (freshest.updatedAt ?? 0) ? row : freshest;
    }, undefined);
  owner.activeSessionLineageSelectedRow =
    selectedRow ?? (lineage.lookupFailed ? previousSelectedRow : null);
  if (selectedRow) {
    // The active list intentionally omits archived rows. Publish the routed
    // descriptor so the chat pane and header share the sidebar's cold-load truth.
    owner.context?.sessions.reconcile(selectedRow, owner.sessionsResult?.defaults, {
      archivedFilter: "all",
    });
  }
}

export function evictArchivedSessionLineage(
  owner: Parameters<typeof publishActiveSessionLineage>[0],
  sessionKey: string | null,
): void {
  if (!sessionKey) {
    return;
  }
  const routedSessionKey = owner.context?.gateway?.snapshot.sessionKey?.trim();
  if (routedSessionKey && areUiSessionKeysEquivalent(routedSessionKey, sessionKey)) {
    // Sidebar lineage can momentarily retarget while the archived route remains
    // selected. The routed descriptor still owns pane/header presentation and
    // must survive until application navigation actually moves elsewhere.
    return;
  }
  const selectedRow =
    owner.sessionsResult?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, sessionKey)) ??
    [
      owner.activeSessionLineageSelectedRow,
      owner.activeSessionLineageRoot,
      ...Object.values(owner.childSessionRowsByParent).flat(),
    ].find(
      (row): row is GatewaySessionRow =>
        row != null && areUiSessionKeysEquivalent(row.key, sessionKey),
    );
  if (selectedRow?.archived === true) {
    // Navigation has ended the archived row's temporary presentation lease.
    // Remove it from the child cache before the next canonical list refresh.
    owner.childSessionRowsByParent = Object.fromEntries(
      Object.entries(owner.childSessionRowsByParent).map(([parentKey, rows]) => [
        parentKey,
        rows.filter((row) => !areUiSessionKeysEquivalent(row.key, sessionKey)),
      ]),
    );
    owner.context?.sessions.reconcile(selectedRow, owner.sessionsResult?.defaults, {
      archivedFilter: "active",
    });
  }
}
