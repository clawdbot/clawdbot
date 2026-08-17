import type { UiCommand } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeSplitLayoutWeights,
  splitLayoutNumericSuffix,
} from "./split-layout-persistence.ts";

export type ChatSplitPane = { id: string; sessionKey: string };
type ChatSplitColumn = { id: string; panes: ChatSplitPane[]; paneWeights: number[] };
export type ChatSplitEdge = "left" | "right" | "up" | "down";
export type ChatSplitLayout = {
  columns: ChatSplitColumn[];
  columnWeights: number[];
  activePaneId: string;
};

export function singlePaneLayout(
  columnId: string,
  paneId: string,
  sessionKey: string,
): ChatSplitLayout {
  return {
    columns: [{ id: columnId, panes: [{ id: paneId, sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: paneId,
  };
}

const MIN_PAIR_SHARE = 0.15;

export function splitWeight(weights: number[], index: number, context: string): number {
  return expectDefined(weights[index], context);
}

export function splitRatio(weights: number[], index: number, context: string): number {
  const before = splitWeight(weights, index, `${context} before divider`);
  const after = splitWeight(weights, index + 1, `${context} after divider`);
  return before / (before + after);
}

function cloneLayout(layout: ChatSplitLayout): ChatSplitLayout {
  return {
    columns: layout.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => ({ ...pane })),
      paneWeights: [...column.paneWeights],
    })),
    columnWeights: [...layout.columnWeights],
    activePaneId: layout.activePaneId,
  };
}

function nextColumnId(layout: ChatSplitLayout): string {
  const max = layout.columns.reduce(
    (current, column) => Math.max(current, splitLayoutNumericSuffix(column.id, "c")),
    0,
  );
  return `c${max + 1}`;
}

function nextPaneId(layout: ChatSplitLayout): string {
  const max = panesOf(layout).reduce(
    (current, pane) => Math.max(current, splitLayoutNumericSuffix(pane.id, "p")),
    0,
  );
  return `p${max + 1}`;
}

export function findPane(
  layout: ChatSplitLayout,
  paneId: string,
): { column: ChatSplitColumn; columnIndex: number; pane: ChatSplitPane; paneIndex: number } | null {
  for (const [columnIndex, column] of layout.columns.entries()) {
    const paneIndex = column.panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex >= 0) {
      const selectedPane = column.panes[paneIndex];
      if (!selectedPane) {
        continue;
      }
      return {
        column: {
          ...column,
          panes: column.panes.map((pane) => ({ ...pane })),
          paneWeights: [...column.paneWeights],
        },
        columnIndex,
        pane: { ...selectedPane },
        paneIndex,
      };
    }
  }
  return null;
}

export function panesOf(layout: ChatSplitLayout): ChatSplitPane[] {
  return layout.columns.flatMap((column) => column.panes.map((pane) => ({ ...pane })));
}

/** Panes actually rendered at the current viewport width. */
export function visiblePanesOf(layout: ChatSplitLayout, narrow: boolean): ChatSplitPane[] {
  if (!narrow) {
    return panesOf(layout);
  }
  const activePane = findPane(layout, layout.activePaneId)?.pane;
  return activePane ? [activePane] : [];
}

export function insertPane(
  layout: ChatSplitLayout,
  targetPaneId: string,
  sessionKey: string,
  edge: ChatSplitEdge,
): ChatSplitLayout {
  const location = findPane(layout, targetPaneId);
  const next = cloneLayout(layout);
  if (!location) {
    return next;
  }
  const newPaneId = nextPaneId(layout);
  if (edge === "left" || edge === "right") {
    const sourceWeight = expectDefined(
      next.columnWeights[location.columnIndex],
      "split column weight for located pane",
    );
    const insertIndex = location.columnIndex + (edge === "right" ? 1 : 0);
    next.columns.splice(insertIndex, 0, {
      id: nextColumnId(layout),
      panes: [{ id: newPaneId, sessionKey }],
      paneWeights: [1],
    });
    next.columnWeights.splice(location.columnIndex, 1, sourceWeight / 2, sourceWeight / 2);
  } else {
    const column = next.columns[location.columnIndex];
    if (!column) {
      return next;
    }
    const sourceWeight = expectDefined(
      column.paneWeights[location.paneIndex],
      "split pane weight for located pane",
    );
    const insertIndex = location.paneIndex + (edge === "down" ? 1 : 0);
    column.panes.splice(insertIndex, 0, { id: newPaneId, sessionKey });
    column.paneWeights.splice(location.paneIndex, 1, sourceWeight / 2, sourceWeight / 2);
  }
  next.activePaneId = newPaneId;
  return next;
}

export function closePane(layout: ChatSplitLayout, paneId: string): ChatSplitLayout | undefined {
  const location = findPane(layout, paneId);
  if (!location) {
    return cloneLayout(layout);
  }
  const next = cloneLayout(layout);
  const column = next.columns[location.columnIndex];
  if (!column) {
    return next;
  }
  const activeWasClosed = next.activePaneId === paneId;
  let nextActivePaneId = next.activePaneId;
  if (activeWasClosed) {
    nextActivePaneId =
      column.panes[location.paneIndex - 1]?.id ??
      next.columns[location.columnIndex - 1]?.panes.at(-1)?.id ??
      next.columns.flatMap((entry) => entry.panes).find((pane) => pane.id !== paneId)?.id ??
      "";
  }
  column.panes.splice(location.paneIndex, 1);
  column.paneWeights.splice(location.paneIndex, 1);
  if (column.panes.length === 0) {
    next.columns.splice(location.columnIndex, 1);
    next.columnWeights.splice(location.columnIndex, 1);
  } else {
    column.paneWeights = normalizeSplitLayoutWeights(column.paneWeights);
  }
  if (panesOf(next).length <= 1) {
    return undefined;
  }
  next.columnWeights = normalizeSplitLayoutWeights(next.columnWeights);
  next.activePaneId = nextActivePaneId;
  return next;
}

export function setPaneSession(
  layout: ChatSplitLayout,
  paneId: string,
  sessionKey: string,
): ChatSplitLayout {
  const next = cloneLayout(layout);
  const pane = next.columns.flatMap((column) => column.panes).find((entry) => entry.id === paneId);
  if (pane) {
    pane.sessionKey = sessionKey;
  }
  return next;
}

export function setActivePane(layout: ChatSplitLayout, paneId: string): ChatSplitLayout {
  const next = cloneLayout(layout);
  if (panesOf(layout).some((pane) => pane.id === paneId)) {
    next.activePaneId = paneId;
  }
  return next;
}

type UiSplitLayoutCommand = Extract<UiCommand, { kind: "split" | "close-pane" | "focus" }>;

export function applyUiCommandToSplitLayout(
  layout: ChatSplitLayout,
  command: UiSplitLayoutCommand,
  sourceSessionKey?: string,
): ChatSplitLayout | undefined {
  if (command.kind === "split") {
    const sourcePane = sourceSessionKey
      ? panesOf(layout).find((entry) => entry.sessionKey === sourceSessionKey)
      : undefined;
    if (sourceSessionKey && !sourcePane) {
      return layout;
    }
    return insertPane(
      layout,
      sourcePane?.id ?? layout.activePaneId,
      command.sessionKey,
      command.direction,
    );
  }
  const pane = panesOf(layout).find((entry) => entry.sessionKey === command.sessionKey);
  if (!pane) {
    return layout;
  }
  return command.kind === "close-pane"
    ? closePane(layout, pane.id)
    : setActivePane(layout, pane.id);
}

function resizePair(weights: number[], boundaryIndex: number, pairRatio: number): number[] {
  const next = [...weights];
  if (boundaryIndex < 0 || boundaryIndex + 1 >= weights.length) {
    return next;
  }
  const before = weights[boundaryIndex];
  const after = weights[boundaryIndex + 1];
  if (before === undefined || after === undefined) {
    return next;
  }
  const pairSum = before + after;
  const ratio = Math.max(MIN_PAIR_SHARE, Math.min(1 - MIN_PAIR_SHARE, pairRatio));
  next[boundaryIndex] = pairSum * ratio;
  next[boundaryIndex + 1] = pairSum * (1 - ratio);
  return next;
}

export function resizeColumns(
  layout: ChatSplitLayout,
  boundaryIndex: number,
  pairRatio: number,
): ChatSplitLayout {
  const next = cloneLayout(layout);
  next.columnWeights = resizePair(next.columnWeights, boundaryIndex, pairRatio);
  return next;
}

export function resizePanes(
  layout: ChatSplitLayout,
  columnId: string,
  boundaryIndex: number,
  pairRatio: number,
): ChatSplitLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.id === columnId);
  if (column) {
    column.paneWeights = resizePair(column.paneWeights, boundaryIndex, pairRatio);
  }
  return next;
}
