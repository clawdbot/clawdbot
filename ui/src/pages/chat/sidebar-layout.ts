import type {
  SidebarColumn,
  SidebarLayout,
  SidebarPanel,
  SidebarSide,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

export type {
  SidebarColumn,
  SidebarLayout,
  SidebarPanel,
  SidebarSide,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

const SIDEBAR_DEFAULT_WIDTH_PX = 360;
const SIDEBAR_CHAT_DEFAULT_WIDTH_PX = 480;
export const SIDEBAR_MIN_WIDTH_PX = 260;
const SIDEBAR_MAX_WIDTH_PX = 1_200;
const SIDEBAR_MAIN_MIN_WIDTH_PX = 312;
export const SIDEBAR_NARROW_BREAKPOINT_PX = 680;
const SIDEBAR_DIVIDER_WIDTH_PX = 4;

const SLOT_RANK: Record<SidebarSlotId, number> = {
  chat: 0,
  detail: 1,
  discussion: 2,
};

function cloneLayout(layout: SidebarLayout): SidebarLayout {
  return structuredClone(layout);
}

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width));
}

function defaultWidth(slot: SidebarSlotId): number {
  return slot === "chat" ? SIDEBAR_CHAT_DEFAULT_WIDTH_PX : SIDEBAR_DEFAULT_WIDTH_PX;
}

function columnRank(column: SidebarColumn): number {
  return Math.min(...column.panels.map((panel) => SLOT_RANK[panel.slot]));
}

function nextColumnId(layout: SidebarLayout, panelId: string): string {
  const base = `${panelId}-column`;
  const used = new Set(layout.columns.map((column) => column.id));
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function nextPanelId(layout: SidebarLayout, slot: SidebarSlotId): string {
  const used = new Set(layout.columns.flatMap((column) => column.panels.map((panel) => panel.id)));
  if (!used.has(slot)) {
    return slot;
  }
  let suffix = 2;
  while (used.has(`${slot}-${suffix}`)) {
    suffix += 1;
  }
  return `${slot}-${suffix}`;
}

function sideInsertIndex(layout: SidebarLayout, side: SidebarSide, sideIndex: number): number {
  const indexes = layout.columns.flatMap((column, index) => (column.side === side ? [index] : []));
  if (indexes.length === 0) {
    const firstRight = layout.columns.findIndex((column) => column.side === "right");
    return side === "left" && firstRight >= 0 ? firstRight : layout.columns.length;
  }
  const clamped = Math.max(0, Math.min(sideIndex, indexes.length));
  return clamped === indexes.length ? (indexes.at(-1) ?? -1) + 1 : (indexes[clamped] ?? 0);
}

function removePanel(layout: SidebarLayout, panelId: string): SidebarPanel | null {
  for (let columnIndex = 0; columnIndex < layout.columns.length; columnIndex += 1) {
    const column = layout.columns[columnIndex]!;
    const panelIndex = column.panels.findIndex((panel) => panel.id === panelId);
    if (panelIndex < 0) {
      continue;
    }
    const panel = column.panels.splice(panelIndex, 1)[0]!;
    if (column.panels.length === 0) {
      layout.columns.splice(columnIndex, 1);
    } else if (column.activePanelId === panelId) {
      column.activePanelId =
        column.panels[Math.min(panelIndex, column.panels.length - 1)]?.id ?? "";
    }
    return panel;
  }
  return null;
}

export function openSlot(
  layout: SidebarLayout,
  slot: SidebarSlotId,
  side: SidebarSide = "right",
): SidebarLayout {
  const next = cloneLayout(layout);
  if (next.columns.some((column) => column.panels.some((panel) => panel.slot === slot))) {
    return next;
  }
  const panel: SidebarPanel = { id: nextPanelId(next, slot), slot };
  const column: SidebarColumn = {
    id: nextColumnId(next, panel.id),
    side,
    panels: [panel],
    activePanelId: panel.id,
    width: defaultWidth(slot),
  };
  const sameSide = next.columns.filter((entry) => entry.side === side);
  const rankedIndex = sameSide.findIndex((entry) => columnRank(entry) > SLOT_RANK[slot]);
  const sideIndex = rankedIndex >= 0 ? rankedIndex : sameSide.length;
  next.columns.splice(sideInsertIndex(next, side, sideIndex), 0, column);
  return next;
}

export function closeSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  const next = cloneLayout(layout);
  const panel = next.columns
    .flatMap((column) => column.panels)
    .find((entry) => entry.slot === slot);
  if (panel) {
    removePanel(next, panel.id);
  }
  return next;
}

export function activatePanel(layout: SidebarLayout, panelId: string): SidebarLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.panels.some((panel) => panel.id === panelId));
  if (column) {
    column.activePanelId = panelId;
  }
  return next;
}

export function mergePanelIntoColumn(
  layout: SidebarLayout,
  panelId: string,
  targetColumnId: string,
  index: number,
): SidebarLayout {
  const next = cloneLayout(layout);
  const source = next.columns.find((column) => column.panels.some((panel) => panel.id === panelId));
  const sourceIndex = source?.panels.findIndex((panel) => panel.id === panelId) ?? -1;
  const sameColumn = source?.id === targetColumnId;
  const panel = removePanel(next, panelId);
  const target = next.columns.find((column) => column.id === targetColumnId);
  if (!panel || !target) {
    return cloneLayout(layout);
  }
  const requestedIndex = Math.trunc(index) - (sameColumn && sourceIndex < index ? 1 : 0);
  const insertIndex = Math.max(0, Math.min(requestedIndex, target.panels.length));
  target.panels.splice(insertIndex, 0, panel);
  target.activePanelId = panel.id;
  return next;
}

export function detachPanelToColumn(
  layout: SidebarLayout,
  panelId: string,
  side: SidebarSide,
  columnIndex: number,
): SidebarLayout {
  const next = cloneLayout(layout);
  const source = next.columns.find((column) => column.panels.some((panel) => panel.id === panelId));
  const sourceSideIndex = source
    ? next.columns.filter((column) => column.side === source.side).indexOf(source)
    : -1;
  const removesSourceColumn = source?.panels.length === 1;
  const sourceWidth = source?.width ?? SIDEBAR_DEFAULT_WIDTH_PX;
  const panel = removePanel(next, panelId);
  if (!panel) {
    return next;
  }
  const column: SidebarColumn = {
    id: nextColumnId(next, panel.id),
    side,
    panels: [panel],
    activePanelId: panel.id,
    width: sourceWidth,
  };
  const requestedIndex =
    source?.side === side && removesSourceColumn && sourceSideIndex < columnIndex
      ? columnIndex - 1
      : columnIndex;
  next.columns.splice(sideInsertIndex(next, side, Math.trunc(requestedIndex)), 0, column);
  return next;
}

export function resizeColumn(
  layout: SidebarLayout,
  columnId: string,
  width: number,
): SidebarLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.id === columnId);
  if (column && Number.isFinite(width)) {
    column.width = clampWidth(width);
  }
  return next;
}

export function fitSidebarLayout(
  layout: SidebarLayout,
  availableWidth: number,
  newestColumnId?: string,
): SidebarLayout | null {
  const next = cloneLayout(layout);
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return next;
  }
  const maxColumnWidth = Math.max(
    SIDEBAR_MIN_WIDTH_PX,
    Math.min(SIDEBAR_MAX_WIDTH_PX, availableWidth * 0.6),
  );
  for (const column of next.columns) {
    column.width = Math.min(maxColumnWidth, clampWidth(column.width));
  }
  const budget = Math.max(
    0,
    availableWidth - SIDEBAR_MAIN_MIN_WIDTH_PX - next.columns.length * SIDEBAR_DIVIDER_WIDTH_PX,
  );
  if (next.columns.length * SIDEBAR_MIN_WIDTH_PX > budget) {
    return null;
  }
  let excess = next.columns.reduce((sum, column) => sum + column.width, 0) - budget;
  const shrinkOrder = next.columns.toSorted((left, right) => {
    const newestOrder = Number(left.id === newestColumnId) - Number(right.id === newestColumnId);
    return newestOrder || right.width - left.width;
  });
  for (const column of shrinkOrder) {
    if (excess <= 0) {
      break;
    }
    const shrink = Math.min(excess, column.width - SIDEBAR_MIN_WIDTH_PX);
    column.width -= shrink;
    excess -= shrink;
  }
  return next;
}

export function isSidebarRegionCollapsed(layout: SidebarLayout, availableWidth: number): boolean {
  return (
    availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX ||
    SIDEBAR_MAIN_MIN_WIDTH_PX +
      layout.columns.length * (SIDEBAR_MIN_WIDTH_PX + SIDEBAR_DIVIDER_WIDTH_PX) >
      availableWidth
  );
}

export function sidebarPrimaryWidth(layout: SidebarLayout, availableWidth: number): number {
  const sidebarWidth = layout.columns.reduce((sum, column) => sum + column.width, 0);
  return Math.max(
    SIDEBAR_MAIN_MIN_WIDTH_PX,
    availableWidth - sidebarWidth - layout.columns.length * SIDEBAR_DIVIDER_WIDTH_PX,
  );
}

export { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
