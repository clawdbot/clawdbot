import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { findCatalogSessionHovercardRow } from "./app-sidebar-session-catalogs.ts";
import {
  findProjectedSidebarSession,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import type {
  SidebarRecentSession,
  SidebarSessionHovercardRow,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

type SidebarSessionLookupData = Pick<
  SessionDataController,
  | "activeSessionLineageRoot"
  | "activeSessionLineageSelectedRow"
  | "childSessionRowsByParent"
  | "sessionResultsByAgent"
>;

type SidebarSessionLookupSource = {
  readonly sessionData: SidebarSessionLookupData;
  getSessionNavigationState(): SidebarSessionNavigationState;
  visibleSessionCatalogs(): readonly SessionCatalog[];
};

export function findActiveSidebarLineageRow(
  sessionData: SidebarSessionLookupData,
  sessionKey: string,
): GatewaySessionRow | undefined {
  return [
    sessionData.activeSessionLineageSelectedRow,
    sessionData.activeSessionLineageRoot,
    ...Object.values(sessionData.childSessionRowsByParent).flat(),
  ].find(
    (row): row is GatewaySessionRow =>
      row != null && areUiSessionKeysEquivalent(row.key, sessionKey),
  );
}

export function findSidebarHovercardRow(
  source: SidebarSessionLookupSource,
  sessionKey: string,
): SidebarSessionHovercardRow | undefined {
  const navigationState = source.getSessionNavigationState();
  const child = findActiveSidebarLineageRow(source.sessionData, sessionKey);
  const liveRow =
    findProjectedSidebarSession({
      sessionKey,
      navigationState,
      sessionResultsByAgent: source.sessionData.sessionResultsByAgent,
    }) ?? (child ? navigationState.toSidebarSession(child, true) : undefined);
  return findCatalogSessionHovercardRow({
    catalogs: source.visibleSessionCatalogs(),
    sessionKey,
    liveRow,
  });
}

/** Merge adopted catalog sessions into the visible PR-indicator rows so an
    adopted session hidden from the regular list still surfaces its PR state. */
export function mergeAdoptedSessionPullRequestRows(input: {
  rows: SidebarRecentSession[];
  adopted: ReadonlySet<string>;
  sessionsResult: SessionsListResult | null;
  sessionResultsByAgent: Record<string, SessionsListResult>;
  navigationState: SidebarSessionNavigationState;
}): SidebarRecentSession[] {
  if (input.adopted.size === 0) {
    return input.rows;
  }
  const byKey = new Map(input.rows.map((row) => [row.key, row]));
  const liveRows = [
    ...(input.sessionsResult?.sessions ?? []),
    ...Object.values(input.sessionResultsByAgent).flatMap((result) => result.sessions),
  ];
  for (const row of liveRows) {
    if (input.adopted.has(row.key) && !byKey.has(row.key)) {
      byKey.set(row.key, input.navigationState.toSidebarSession(row));
    }
  }
  return [...byKey.values()];
}
