import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../i18n/index.ts";
import type { BoardSnapshot } from "./types.ts";
import type { BoardViewSnapshot } from "./view-types.ts";

const OBSERVER_TAB_ID = "builtin-observer";
const OBSERVER_WIDGET_NAME = "builtin:observer";

/** Adds the read-only client projection without writing it through the board provider. */
export function withObserverWidget(
  snapshot: BoardSnapshot | BoardViewSnapshot,
  digests: readonly SessionObserverDigest[],
): BoardViewSnapshot {
  if (digests.length === 0) {
    return snapshot;
  }
  const tabs = snapshot.tabs.some((tab) => tab.tabId === OBSERVER_TAB_ID)
    ? snapshot.tabs
    : [
        ...snapshot.tabs,
        {
          tabId: OBSERVER_TAB_ID,
          title: t("chat.observer.title"),
          position: Math.max(-1, ...snapshot.tabs.map((tab) => tab.position)) + 1,
          chatDock: "right" as const,
        },
      ];
  const widget = {
    name: OBSERVER_WIDGET_NAME,
    tabId: OBSERVER_TAB_ID,
    title: t("chat.observer.title"),
    contentKind: "builtin" as const,
    builtin: "observer" as const,
    readOnly: true,
    sizeW: 12,
    sizeH: 6,
    position: 0,
    grantState: "granted" as const,
    revision: snapshot.revision,
  } satisfies BoardViewSnapshot["widgets"][number];
  const widgets = snapshot.widgets.some((candidate) => candidate.name === OBSERVER_WIDGET_NAME)
    ? snapshot.widgets.map((candidate) =>
        candidate.name === OBSERVER_WIDGET_NAME ? widget : candidate,
      )
    : [...snapshot.widgets, widget];
  return { ...snapshot, tabs, widgets };
}
