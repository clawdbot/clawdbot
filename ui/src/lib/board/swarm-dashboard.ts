import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { areUiSessionKeysEquivalent } from "../sessions/session-key.ts";
import type { BoardSnapshot } from "./types.ts";
import type { BoardViewSnapshot } from "./view-types.ts";

const SWARM_TAB_ID = "builtin-swarm";
const SWARM_WIDGET_NAME = "builtin:swarm";

function hasSwarmRowsForSession(
  sessions: readonly GatewaySessionRow[],
  sessionKey: string,
): boolean {
  return sessions.some(
    (row) =>
      Boolean(row.swarmGroupId?.trim()) &&
      ((row.parentSessionKey && areUiSessionKeysEquivalent(row.parentSessionKey, sessionKey)) ||
        (row.spawnedBy && areUiSessionKeysEquivalent(row.spawnedBy, sessionKey)) ||
        ((): boolean => {
          const owner = row.swarmGroupId?.split(":").slice(1, -1).join(":");
          return Boolean(owner && areUiSessionKeysEquivalent(owner, sessionKey));
        })()),
  );
}

/** Creates the ephemeral board card from the live session roster, never from persisted board state. */
export function withSwarmWidget(
  snapshot: BoardSnapshot,
  sessions: readonly GatewaySessionRow[],
): BoardViewSnapshot {
  // Keep the card mounted through terminal collector updates so its explicit
  // empty state is visible before the retention sweep removes the group.
  if (!hasSwarmRowsForSession(sessions, snapshot.sessionKey)) {
    return snapshot;
  }
  const tabs = snapshot.tabs.some((tab) => tab.tabId === SWARM_TAB_ID)
    ? snapshot.tabs
    : [
        ...snapshot.tabs,
        {
          tabId: SWARM_TAB_ID,
          title: t("labsPage.swarm.title"),
          position: Math.max(-1, ...snapshot.tabs.map((tab) => tab.position)) + 1,
          chatDock: "right" as const,
        },
      ];
  const widget = {
    name: SWARM_WIDGET_NAME,
    tabId: SWARM_TAB_ID,
    title: t("labsPage.swarm.title"),
    contentKind: "builtin" as const,
    builtin: "swarm" as const,
    readOnly: true,
    sizeW: 12,
    sizeH: 4,
    position: 0,
    grantState: "granted" as const,
    revision: snapshot.revision,
  } satisfies BoardViewSnapshot["widgets"][number];
  const widgets = snapshot.widgets.some((candidate) => candidate.name === SWARM_WIDGET_NAME)
    ? snapshot.widgets.map((candidate) =>
        candidate.name === SWARM_WIDGET_NAME ? widget : candidate,
      )
    : [...snapshot.widgets, widget];
  return { ...snapshot, tabs, widgets };
}
