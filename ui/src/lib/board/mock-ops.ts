import type { BoardOp, BoardSnapshot } from "@openclaw/gateway-protocol";

export function normalizeMockBoardSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  const tabs = snapshot.tabs
    .toSorted((left, right) => left.position - right.position)
    .map((tab, position) => Object.assign({}, tab, { position }));
  const tabPositions = new Map(tabs.map((tab) => [tab.tabId, tab.position]));
  const nextWidgetPosition = new Map<string, number>();
  const widgets = snapshot.widgets
    .toSorted((left, right) => {
      const tabDelta =
        (tabPositions.get(left.tabId) ?? Number.MAX_SAFE_INTEGER) -
        (tabPositions.get(right.tabId) ?? Number.MAX_SAFE_INTEGER);
      return tabDelta || left.position - right.position;
    })
    .map((widget) => {
      const position = nextWidgetPosition.get(widget.tabId) ?? 0;
      nextWidgetPosition.set(widget.tabId, position + 1);
      return Object.assign({}, widget, { position });
    });
  return { ...snapshot, tabs, widgets };
}

export function applyMockBoardOp(snapshot: BoardSnapshot, op: BoardOp): BoardSnapshot {
  switch (op.kind) {
    case "tab_create":
      if (snapshot.tabs.some((tab) => tab.tabId === op.tabId)) {
        return snapshot;
      }
      return {
        ...snapshot,
        tabs: [
          ...snapshot.tabs,
          {
            tabId: op.tabId,
            title: op.title,
            position: snapshot.tabs.length,
            chatDock: op.chatDock ?? "right",
          },
        ],
      };
    case "tab_update": {
      const orderedTabs = snapshot.tabs.toSorted((left, right) => left.position - right.position);
      const tabIndex = orderedTabs.findIndex((tab) => tab.tabId === op.tabId);
      if (tabIndex < 0) {
        return snapshot;
      }
      const [tab] = orderedTabs.splice(tabIndex, 1);
      const updated = {
        ...tab!,
        ...(op.title !== undefined ? { title: op.title } : {}),
        ...(op.chatDock !== undefined ? { chatDock: op.chatDock } : {}),
      };
      const position = Math.max(
        0,
        Math.min(
          op.position === undefined ? tabIndex : Math.trunc(op.position),
          orderedTabs.length,
        ),
      );
      orderedTabs.splice(position, 0, updated);
      return {
        ...snapshot,
        tabs: orderedTabs.map((candidate, nextPosition) =>
          Object.assign({}, candidate, { position: nextPosition }),
        ),
      };
    }
    case "tab_delete": {
      const remainingTabs = snapshot.tabs.filter((tab) => tab.tabId !== op.tabId);
      if (remainingTabs.length === 0 && snapshot.widgets.length > 0) {
        return snapshot;
      }
      const firstTabId = remainingTabs[0]?.tabId;
      return {
        ...snapshot,
        tabs: remainingTabs,
        widgets: snapshot.widgets.map((widget) =>
          widget.tabId === op.tabId && firstTabId
            ? { ...widget, tabId: firstTabId, position: Number.MAX_SAFE_INTEGER }
            : widget,
        ),
      };
    }
    case "tabs_reorder": {
      const requestedTabIds = new Set(op.tabIds);
      if (
        op.tabIds.length !== snapshot.tabs.length ||
        requestedTabIds.size !== snapshot.tabs.length ||
        snapshot.tabs.some((tab) => !requestedTabIds.has(tab.tabId))
      ) {
        return snapshot;
      }
      return {
        ...snapshot,
        tabs: op.tabIds.flatMap((tabId, position) => {
          const tab = snapshot.tabs.find((candidate) => candidate.tabId === tabId);
          return tab ? [{ ...tab, position }] : [];
        }),
      };
    }
    case "widget_move": {
      const moving = snapshot.widgets.find((widget) => widget.name === op.name);
      const anchor = op.after
        ? snapshot.widgets.find((widget) => widget.name === op.after)
        : undefined;
      if (!moving || (op.after && (!anchor || anchor.name === moving.name))) {
        return snapshot;
      }
      const targetTabId = op.tabId ?? moving.tabId;
      if (
        (op.position !== undefined && op.after !== undefined) ||
        !snapshot.tabs.some((tab) => tab.tabId === targetTabId) ||
        (anchor && anchor.tabId !== targetTabId)
      ) {
        return snapshot;
      }
      const remaining = snapshot.widgets.filter((widget) => widget.name !== moving.name);
      const targetWidgets = remaining
        .filter((widget) => widget.tabId === targetTabId)
        .toSorted((left, right) => left.position - right.position);
      const anchorIndex = anchor
        ? targetWidgets.findIndex((widget) => widget.name === anchor.name)
        : -1;
      const insertionIndex = anchor
        ? anchorIndex + 1
        : Math.max(0, Math.min(op.position ?? targetWidgets.length, targetWidgets.length));
      targetWidgets.splice(insertionIndex, 0, { ...moving, tabId: targetTabId });
      return {
        ...snapshot,
        widgets: snapshot.tabs.flatMap((tab) =>
          (tab.tabId === targetTabId
            ? targetWidgets
            : remaining
                .filter((widget) => widget.tabId === tab.tabId)
                .toSorted((left, right) => left.position - right.position)
          ).map((widget, position) => Object.assign({}, widget, { position })),
        ),
      };
    }
    case "widget_resize":
      return {
        ...snapshot,
        widgets: snapshot.widgets.map((widget) =>
          widget.name === op.name
            ? {
                ...widget,
                sizeW: Math.min(12, Math.max(1, Math.trunc(op.sizeW))),
                sizeH: Math.min(20, Math.max(1, Math.trunc(op.sizeH))),
              }
            : widget,
        ),
      };
    case "widget_remove":
      return { ...snapshot, widgets: snapshot.widgets.filter((widget) => widget.name !== op.name) };
  }
  return snapshot;
}
