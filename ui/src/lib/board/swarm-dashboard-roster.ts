import type { GatewaySessionRow } from "../../api/types.ts";
import { fetchChildSessionRows } from "../sessions/child-session-data.ts";
import type { SessionCapability } from "../sessions/index.ts";

const SWARM_SESSION_PAGE_SIZE = 10_000;

function isNewerSessionRow(candidate: GatewaySessionRow, current: GatewaySessionRow): boolean {
  // Callers pass hydrated rows first and the current lifecycle-decorated page
  // second, so equal persisted timestamps intentionally prefer the latter.
  return (candidate.updatedAt ?? 0) >= (current.updatedAt ?? 0);
}

export function mergeSwarmSessionRows(
  childRows: readonly GatewaySessionRow[],
  currentRows: readonly GatewaySessionRow[],
): GatewaySessionRow[] {
  const merged = new Map<string, GatewaySessionRow>();
  for (const row of [...childRows, ...currentRows]) {
    const current = merged.get(row.key);
    if (!current || isNewerSessionRow(row, current)) {
      merged.set(row.key, row);
    }
  }
  return [...merged.values()];
}

export async function hydrateSwarmSessionRows(params: {
  sessions: SessionCapability;
  parentKey: string;
  currentRows: readonly GatewaySessionRow[];
  isCurrent: () => boolean;
}): Promise<GatewaySessionRow[] | null> {
  const childRows = await fetchChildSessionRows({
    sessions: params.sessions,
    parentKey: params.parentKey,
    isCurrent: params.isCurrent,
    pageSize: SWARM_SESSION_PAGE_SIZE,
  });
  return childRows ? mergeSwarmSessionRows(params.currentRows, childRows) : null;
}
