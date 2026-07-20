import type {
  BoardOp,
  BoardSnapshot,
  BoardTab,
  BoardWidget,
} from "../../packages/gateway-protocol/src/index.js";

export const BOARD_SIZE_PRESETS = {
  sm: { sizeW: 3, sizeH: 3 },
  md: { sizeW: 6, sizeH: 4 },
  lg: { sizeW: 8, sizeH: 6 },
  xl: { sizeW: 12, sizeH: 8 },
  full: { sizeW: 12, sizeH: 8 },
} as const;

export type BoardSize = keyof typeof BOARD_SIZE_PRESETS;
export type BoardLayout = Pick<BoardSnapshot, "tabs" | "widgets">;
type BoardValidationErrorCode = "conflict" | "invalid_operation" | "not_found";

export class BoardValidationError extends Error {
  readonly code: BoardValidationErrorCode;

  constructor(code: BoardValidationErrorCode, message: string) {
    super(message);
    this.name = "BoardValidationError";
    this.code = code;
  }
}

function cloneTab(tab: BoardTab): BoardTab {
  return {
    tabId: tab.tabId,
    title: tab.title,
    position: tab.position,
    chatDock: tab.chatDock,
  };
}

function cloneWidget(widget: BoardWidget): BoardWidget {
  return {
    name: widget.name,
    tabId: widget.tabId,
    ...(widget.title !== undefined ? { title: widget.title } : {}),
    contentKind: widget.contentKind,
    sizeW: widget.sizeW,
    sizeH: widget.sizeH,
    position: widget.position,
    grantState: widget.grantState,
    revision: widget.revision,
    ...(widget.instanceId !== undefined ? { instanceId: widget.instanceId } : {}),
    ...(widget.declaredSummary !== undefined
      ? { declaredSummary: [...widget.declaredSummary] }
      : {}),
  };
}

function cloneLayout(layout: BoardLayout): BoardLayout {
  return {
    tabs: layout.tabs.map(cloneTab),
    widgets: layout.widgets.map(cloneWidget),
  };
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function comparePosition(a: { position: number }, b: { position: number }): number {
  return a.position - b.position;
}

export function normalizeBoardLayout(layout: BoardLayout): BoardLayout {
  const tabs = layout.tabs.toSorted(comparePosition).map((tab, position) => {
    const next = cloneTab(tab);
    next.position = position;
    return next;
  });
  const tabPosition = new Map(tabs.map((tab) => [tab.tabId, tab.position]));
  const widgets = layout.widgets
    .toSorted((a, b) => {
      const tabDelta =
        (tabPosition.get(a.tabId) ?? Number.MAX_SAFE_INTEGER) -
        (tabPosition.get(b.tabId) ?? Number.MAX_SAFE_INTEGER);
      return tabDelta || a.position - b.position;
    })
    .map(cloneWidget);
  const nextPosition = new Map<string, number>();
  for (const widget of widgets) {
    const position = nextPosition.get(widget.tabId) ?? 0;
    widget.position = position;
    nextPosition.set(widget.tabId, position + 1);
  }
  return { tabs, widgets };
}

function requireTab(layout: BoardLayout, tabId: string): BoardTab {
  const tab = layout.tabs.find((candidate) => candidate.tabId === tabId);
  if (!tab) {
    throw new BoardValidationError("not_found", `board tab not found: ${tabId}`);
  }
  return tab;
}

function requireWidget(layout: BoardLayout, name: string): BoardWidget {
  const widget = layout.widgets.find((candidate) => candidate.name === name);
  if (!widget) {
    throw new BoardValidationError("not_found", `board widget not found: ${name}`);
  }
  return widget;
}

function moveTab(layout: BoardLayout, tab: BoardTab, position: number): void {
  const ordered = layout.tabs.toSorted(comparePosition).filter((candidate) => candidate !== tab);
  ordered.splice(clampInteger(position, 0, ordered.length), 0, tab);
  ordered.forEach((candidate, index) => {
    candidate.position = index;
  });
  layout.tabs = ordered;
}

function moveWidget(
  layout: BoardLayout,
  widget: BoardWidget,
  targetTabId: string,
  position?: number,
  after?: string,
): void {
  requireTab(layout, targetTabId);
  if (position !== undefined && after !== undefined) {
    throw new BoardValidationError(
      "invalid_operation",
      "widget_move accepts either position or after, not both",
    );
  }
  const targetWidgets = layout.widgets
    .filter((candidate) => candidate.tabId === targetTabId && candidate !== widget)
    .toSorted(comparePosition);
  let targetPosition = targetWidgets.length;
  if (after !== undefined) {
    if (after === widget.name) {
      throw new BoardValidationError("invalid_operation", "widget cannot be placed after itself");
    }
    const anchorIndex = targetWidgets.findIndex((candidate) => candidate.name === after);
    if (anchorIndex < 0) {
      throw new BoardValidationError(
        "not_found",
        `board widget anchor not found on tab ${targetTabId}: ${after}`,
      );
    }
    targetPosition = anchorIndex + 1;
  } else if (position !== undefined) {
    targetPosition = clampInteger(position, 0, targetWidgets.length);
  }
  widget.tabId = targetTabId;
  targetWidgets.splice(targetPosition, 0, widget);
  targetWidgets.forEach((candidate, index) => {
    candidate.position = index;
  });
  const otherWidgets = layout.widgets.filter(
    (candidate) => candidate !== widget && candidate.tabId !== targetTabId,
  );
  layout.widgets = [...otherWidgets, ...targetWidgets];
}

function applyBoardOp(layout: BoardLayout, op: BoardOp): void {
  switch (op.kind) {
    case "tab_create": {
      if (layout.tabs.some((tab) => tab.tabId === op.tabId)) {
        throw new BoardValidationError("conflict", `board tab already exists: ${op.tabId}`);
      }
      layout.tabs.push({
        tabId: op.tabId,
        title: op.title,
        position: layout.tabs.length,
        chatDock: op.chatDock ?? "right",
      });
      return;
    }
    case "tab_update": {
      const tab = requireTab(layout, op.tabId);
      if (op.title === undefined && op.chatDock === undefined && op.position === undefined) {
        throw new BoardValidationError("invalid_operation", "tab_update has no changes");
      }
      if (op.title !== undefined) {
        tab.title = op.title;
      }
      if (op.chatDock !== undefined) {
        tab.chatDock = op.chatDock;
      }
      if (op.position !== undefined) {
        moveTab(layout, tab, op.position);
      }
      return;
    }
    case "tab_delete": {
      const tab = requireTab(layout, op.tabId);
      const remainingTabs = layout.tabs
        .filter((candidate) => candidate !== tab)
        .toSorted(comparePosition);
      const tabWidgets = layout.widgets
        .filter((widget) => widget.tabId === tab.tabId)
        .toSorted(comparePosition);
      if (remainingTabs.length === 0 && tabWidgets.length > 0) {
        throw new BoardValidationError(
          "invalid_operation",
          "cannot delete the last board tab while it contains widgets",
        );
      }
      layout.tabs = remainingTabs;
      if (tabWidgets.length > 0) {
        const fallback = remainingTabs[0]!;
        for (const widget of tabWidgets) {
          widget.tabId = fallback.tabId;
          widget.position = Number.MAX_SAFE_INTEGER;
        }
      }
      return;
    }
    case "tabs_reorder": {
      if (
        op.tabIds.length !== layout.tabs.length ||
        new Set(op.tabIds).size !== op.tabIds.length ||
        op.tabIds.some((tabId) => !layout.tabs.some((tab) => tab.tabId === tabId))
      ) {
        throw new BoardValidationError(
          "invalid_operation",
          "tabs_reorder must contain every tab exactly once",
        );
      }
      const byId = new Map(layout.tabs.map((tab) => [tab.tabId, tab]));
      layout.tabs = op.tabIds.map((tabId, position) => {
        const tab = byId.get(tabId)!;
        tab.position = position;
        return tab;
      });
      return;
    }
    case "widget_move": {
      const widget = requireWidget(layout, op.name);
      moveWidget(layout, widget, op.tabId ?? widget.tabId, op.position, op.after);
      return;
    }
    case "widget_resize": {
      const widget = requireWidget(layout, op.name);
      widget.sizeW = clampInteger(op.sizeW, 1, 12);
      widget.sizeH = clampInteger(op.sizeH, 1, 20);
      return;
    }
    case "widget_remove": {
      requireWidget(layout, op.name);
      layout.widgets = layout.widgets.filter((widget) => widget.name !== op.name);
    }
  }
}

export function applyBoardOps(layout: BoardLayout, ops: readonly BoardOp[]): BoardLayout {
  const next = cloneLayout(layout);
  for (const op of ops) {
    applyBoardOp(next, op);
    const normalized = normalizeBoardLayout(next);
    next.tabs = normalized.tabs;
    next.widgets = normalized.widgets;
  }
  return normalizeBoardLayout(next);
}

export function insertBoardWidget(
  layout: BoardLayout,
  widget: BoardWidget,
  placement: { tabId: string; after?: string; move?: boolean },
): BoardLayout {
  const next = cloneLayout(layout);
  const existing = next.widgets.find((candidate) => candidate.name === widget.name);
  if (existing) {
    const position = existing.position;
    Object.assign(existing, widget, { tabId: placement.tabId, position });
    if (placement.move) {
      moveWidget(next, existing, placement.tabId, undefined, placement.after);
    }
  } else {
    next.widgets.push({ ...widget, tabId: placement.tabId });
    const inserted = requireWidget(next, widget.name);
    moveWidget(next, inserted, placement.tabId, undefined, placement.after);
  }
  return normalizeBoardLayout(next);
}
