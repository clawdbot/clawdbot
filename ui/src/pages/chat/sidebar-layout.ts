import type {
  SidebarDock,
  SidebarLayout,
  SidebarPanel,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

export type {
  SidebarColumn,
  SidebarDock,
  SidebarLayout,
  SidebarPanel,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

const SIDEBAR_DEFAULT_WIDTH_PX = 480;
const SIDEBAR_DEFAULT_HEIGHT_PX = 360;
export const SIDEBAR_GEOMETRY_COMMIT_EVENT = "openclaw-sidebar-geometry-commit";
export const SIDEBAR_MIN_WIDTH_PX = 260;
export const SIDEBAR_MIN_HEIGHT_PX = 220;
const SIDEBAR_MAX_WIDTH_PX = 1_200;
const SIDEBAR_MAX_HEIGHT_PX = 800;
const SIDEBAR_MAIN_MIN_WIDTH_PX = 312;
export const SIDEBAR_NARROW_BREAKPOINT_PX = 680;
const SIDEBAR_DIVIDER_WIDTH_PX = 4;

function cloneLayout(layout: SidebarLayout): SidebarLayout {
  return structuredClone(layout);
}

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width));
}

function clampHeight(height: number): number {
  return Math.min(SIDEBAR_MAX_HEIGHT_PX, Math.max(SIDEBAR_MIN_HEIGHT_PX, height));
}

export function sidebarDock(layout: SidebarLayout): SidebarDock {
  return layout.dock === "bottom" ? "bottom" : "right";
}

export function isSidebarSlotVisible(layout: SidebarLayout, slot: SidebarSlotId): boolean {
  if (layout.open !== true) {
    return false;
  }
  return layout.columns.some((column) => {
    const active = column.panels.find((panel) => panel.id === column.activePanelId);
    return active?.slot === slot;
  });
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

export function openSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  const next = cloneLayout(layout);
  const existing = next.columns
    .flatMap((column) => column.panels)
    .find((panel) => panel.slot === slot);
  if (existing) {
    next.open = true;
    const column = next.columns.find((entry) => entry.panels.includes(existing));
    if (column) {
      column.activePanelId = existing.id;
    }
    return next;
  }
  const panel: SidebarPanel = { id: nextPanelId(next, slot), slot };
  const column = next.columns[0];
  if (column) {
    column.panels.push(panel);
    column.activePanelId = panel.id;
  } else {
    next.columns = [
      {
        id: "side-panel-column",
        side: "right",
        panels: [panel],
        activePanelId: panel.id,
        height: SIDEBAR_DEFAULT_HEIGHT_PX,
        width: SIDEBAR_DEFAULT_WIDTH_PX,
      },
    ];
  }
  next.open = true;
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
    next.open = true;
  }
  return next;
}

export function reorderPanel(
  layout: SidebarLayout,
  panelId: string,
  targetPanelId: string,
  placement: "before" | "after",
): SidebarLayout {
  const next = cloneLayout(layout);
  const panels = next.columns[0]?.panels;
  if (!panels || panelId === targetPanelId) {
    return next;
  }
  const panelIndex = panels.findIndex((panel) => panel.id === panelId);
  const targetIndex = panels.findIndex((panel) => panel.id === targetPanelId);
  if (panelIndex < 0 || targetIndex < 0) {
    return next;
  }
  const [panel] = panels.splice(panelIndex, 1);
  const settledTargetIndex = panels.findIndex((entry) => entry.id === targetPanelId);
  panels.splice(settledTargetIndex + (placement === "after" ? 1 : 0), 0, panel!);
  return next;
}

export function setSidebarOpen(layout: SidebarLayout, open: boolean): SidebarLayout {
  return { ...cloneLayout(layout), open };
}

export function setSidebarExpanded(layout: SidebarLayout, expanded: boolean): SidebarLayout {
  return { ...cloneLayout(layout), expanded };
}

export function setSidebarDock(layout: SidebarLayout, dock: SidebarDock): SidebarLayout {
  return { ...cloneLayout(layout), dock };
}

export function resizeSidebarPanel(
  layout: SidebarLayout,
  columnId: string,
  size: number,
): SidebarLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.id === columnId);
  if (column && Number.isFinite(size)) {
    if (sidebarDock(next) === "bottom") {
      column.height = clampHeight(size);
    } else {
      column.width = clampWidth(size);
    }
  }
  return next;
}

export function fitSidebarLayout(
  layout: SidebarLayout,
  availableWidth: number,
): SidebarLayout | null {
  const next = cloneLayout(layout);
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return next;
  }
  const column = next.columns[0];
  if (!column) {
    return next;
  }
  next.columns = [column];
  if (sidebarDock(next) === "bottom") {
    column.height = clampHeight(column.height);
    return next;
  }
  const maxColumnWidth = Math.max(
    SIDEBAR_MIN_WIDTH_PX,
    Math.min(SIDEBAR_MAX_WIDTH_PX, availableWidth * 0.6),
  );
  const budget = Math.max(0, availableWidth - SIDEBAR_MAIN_MIN_WIDTH_PX - SIDEBAR_DIVIDER_WIDTH_PX);
  if (SIDEBAR_MIN_WIDTH_PX > budget) {
    return null;
  }
  column.width = Math.min(maxColumnWidth, budget, clampWidth(column.width));
  return next;
}

export function isSidebarRegionCollapsed(_layout: SidebarLayout, availableWidth: number): boolean {
  return availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX;
}

export { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
