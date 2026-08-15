import { nothing, type TemplateResult } from "lit";
import type { SidebarSlotId } from "../sidebar-layout.ts";

export type SidebarPanelTemplates = Partial<Record<SidebarSlotId, TemplateResult | typeof nothing>>;

export type SidebarRegionCallbacks = {
  activatePanel: (panelId: string) => void;
  closeSlot: (slot: SidebarSlotId) => void;
  openSlot: (slot: SidebarSlotId) => void;
  reorderPanel: (panelId: string, targetPanelId: string, placement: "before" | "after") => void;
  resizeColumn: (columnId: string, width: number) => void;
  setExpanded: (expanded: boolean) => void;
  setOpen: (open: boolean) => void;
};
