import type { TemplateResult } from "lit";
import type { SidebarSide, SidebarSlotId } from "../sidebar-layout.ts";

export type SidebarPanelTemplates = Partial<Record<SidebarSlotId, TemplateResult>>;

export type SidebarRegionCallbacks = {
  activatePanel: (panelId: string) => void;
  closeSlot: (slot: SidebarSlotId) => void;
  detachPanel: (panelId: string, side: SidebarSide, columnIndex: number) => void;
  mergePanel: (panelId: string, targetColumnId: string, panelIndex: number) => void;
  resizeColumn: (columnId: string, width: number) => void;
};
