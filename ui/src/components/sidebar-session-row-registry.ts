import type { ApplicationGateway } from "../app/gateway.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type SidebarSessionRowsByOwner = Map<object, ReadonlyMap<string, SidebarRecentSession>>;

const rowsByGateway = new WeakMap<ApplicationGateway, SidebarSessionRowsByOwner>();

function flattenSidebarSessionRows(
  rows: readonly SidebarRecentSession[],
): ReadonlyMap<string, SidebarRecentSession> {
  const flattened = new Map<string, SidebarRecentSession>();
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.shift();
    if (!row) {
      continue;
    }
    flattened.set(row.key, row);
    pending.push(...row.children);
  }
  return flattened;
}

export function publishSidebarSessionRows(
  gateway: ApplicationGateway,
  owner: object,
  rows: readonly SidebarRecentSession[],
): void {
  const owners = rowsByGateway.get(gateway) ?? new Map();
  owners.set(owner, flattenSidebarSessionRows(rows));
  rowsByGateway.set(gateway, owners);
}

export function unpublishSidebarSessionRows(gateway: ApplicationGateway, owner: object): void {
  const owners = rowsByGateway.get(gateway);
  if (!owners) {
    return;
  }
  owners.delete(owner);
  if (owners.size === 0) {
    rowsByGateway.delete(gateway);
  }
}

export function getSidebarSessionRow(
  gateway: ApplicationGateway,
  sessionKey: string,
): SidebarRecentSession | undefined {
  for (const rows of rowsByGateway.get(gateway)?.values() ?? []) {
    const row = rows.get(sessionKey);
    if (row) {
      return row;
    }
  }
  return undefined;
}
