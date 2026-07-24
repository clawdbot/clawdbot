import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
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
      const parentKey = (row.spawnedBy ?? row.parentSessionKey)?.trim();
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

export function mergeChildSessionRows(
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
