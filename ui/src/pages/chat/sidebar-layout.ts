import type {
  SidebarColumn,
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

function createSidebarColumn(): SidebarColumn {
  return {
    id: "side-panel-column",
    side: "right",
    panels: [],
    activePanelId: "",
    height: SIDEBAR_DEFAULT_HEIGHT_PX,
    width: SIDEBAR_DEFAULT_WIDTH_PX,
  };
}

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width));
}

function clampHeight(height: number): number {
  return Math.min(SIDEBAR_MAX_HEIGHT_PX, Math.max(SIDEBAR_MIN_HEIGHT_PX, height));
}

export function sidebarDock(layout: SidebarLayout): SidebarDock {
  return layout.dock === "bottom" || layout.dock === "left" ? layout.dock : "right";
}

export function sidebarMainPanel(layout: SidebarLayout): SidebarPanel | undefined {
  return layout.columns[0]?.panels.find((panel) => panel.id === layout.mainPanelId);
}

export function sidebarSidePanels(layout: SidebarLayout): SidebarPanel[] {
  return layout.columns[0]?.panels.filter((panel) => panel.id !== layout.mainPanelId) ?? [];
}

export function sidebarActivePanel(layout: SidebarLayout): SidebarPanel | undefined {
  return sidebarSidePanels(layout).find((panel) => panel.id === layout.columns[0]?.activePanelId);
}

export function isSidebarSlotVisible(layout: SidebarLayout, slot: SidebarSlotId): boolean {
  if ((sidebarMainPanel(layout)?.slot ?? "conversation") === slot) {
    return true;
  }
  return layout.open === true && !layout.expanded && sidebarActivePanel(layout)?.slot === slot;
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
  for (const column of layout.columns) {
    const panelIndex = column.panels.findIndex((panel) => panel.id === panelId);
    if (panelIndex < 0) {
      continue;
    }
    const sideIndex = column.panels
      .filter((entry) => entry.id !== layout.mainPanelId)
      .findIndex((entry) => entry.id === panelId);
    const panel = column.panels.splice(panelIndex, 1)[0]!;
    if (column.activePanelId === panelId) {
      const sidePanels = column.panels.filter((entry) => entry.id !== layout.mainPanelId);
      column.activePanelId = sidePanels[Math.min(sideIndex, sidePanels.length - 1)]?.id ?? "";
    }
    return panel;
  }
  return null;
}

export function ensureSidebarConversation(layout: SidebarLayout): SidebarLayout {
  const next = cloneLayout(layout);
  const column = (next.columns[0] ??= createSidebarColumn());
  let conversation = column.panels.find((panel) => panel.slot === "conversation");
  if (!conversation) {
    conversation = { id: nextPanelId(next, "conversation"), slot: "conversation" };
    column.panels.push(conversation);
  }
  next.mainPanelId = sidebarMainPanel(next)?.id ?? conversation.id;
  if (column.activePanelId === next.mainPanelId) {
    column.activePanelId = sidebarSidePanels(next)[0]?.id ?? "";
  }
  return next;
}

export function promoteSidebarPanel(layout: SidebarLayout, panelId: string): SidebarLayout {
  const target = layout.columns[0]?.panels.find((panel) => panel.id === panelId);
  if (!target || sidebarMainPanel(layout)?.id === panelId) {
    return cloneLayout(layout);
  }
  const next = ensureSidebarConversation(layout);
  const previousMainId = next.mainPanelId!;
  next.mainPanelId = panelId;
  next.columns[0]!.activePanelId = previousMainId;
  next.open = true;
  next.expanded = false;
  return next;
}

export function openSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  const next = cloneLayout(layout);
  if ((sidebarMainPanel(next)?.slot ?? "conversation") === slot) {
    return next;
  }
  const existing = next.columns
    .flatMap((column) => column.panels)
    .find((panel) => panel.slot === slot);
  if (existing) {
    next.open = true;
    if (next.expanded) {
      next.expanded = false;
    }
    const column = next.columns.find((entry) => entry.panels.includes(existing));
    if (column) {
      column.activePanelId = existing.id;
    }
    return next;
  }
  const panel: SidebarPanel = { id: nextPanelId(next, slot), slot };
  const column = (next.columns[0] ??= createSidebarColumn());
  column.panels.push(panel);
  column.activePanelId = panel.id;
  next.open = true;
  if (next.expanded) {
    next.expanded = false;
  }
  return next;
}

export function closeSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  let next = cloneLayout(layout);
  const panel = next.columns
    .flatMap((column) => column.panels)
    .find((entry) => entry.slot === slot);
  if (panel) {
    if (slot === "conversation") {
      if (panel.id !== next.mainPanelId) {
        next.open = false;
      }
      return next;
    }
    if (panel.id === next.mainPanelId) {
      next = ensureSidebarConversation(next);
      next.mainPanelId = next.columns[0]!.panels.find((entry) => entry.slot === "conversation")!.id;
    }
    removePanel(next, panel.id);
    const column = next.columns[0];
    if (column && !sidebarActivePanel(next)) {
      column.activePanelId = sidebarSidePanels(next)[0]?.id ?? "";
    }
    if (sidebarSidePanels(next).length === 0) {
      next.open = false;
    }
  }
  if (next.columns.length === 0) {
    next.open = false;
  }
  return next;
}

export function activatePanel(layout: SidebarLayout, panelId: string): SidebarLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.panels.some((panel) => panel.id === panelId));
  if (column && panelId !== next.mainPanelId) {
    column.activePanelId = panelId;
    next.open = true;
    if (next.expanded) {
      next.expanded = false;
    }
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
  const next = cloneLayout(layout);
  if (open) {
    next.columns[0] ??= createSidebarColumn();
    if (next.expanded) {
      next.expanded = false;
    }
  }
  next.open = open;
  return next;
}

export function setSidebarExpanded(layout: SidebarLayout, expanded: boolean): SidebarLayout {
  // Restore split must reveal the side even when focus began with that panel closed.
  return { ...cloneLayout(layout), expanded, ...(expanded ? { open: true } : {}) };
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
