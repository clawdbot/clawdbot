import { nothing, type TemplateResult } from "lit";
import type { SidebarDock, SidebarSlotId } from "../sidebar-layout.ts";

export type SidebarPanelTemplates = Partial<Record<SidebarSlotId, TemplateResult | typeof nothing>>;

export type SidebarPanelDefinition = {
  slot: SidebarSlotId;
  label: string;
  icon: TemplateResult;
  shortcut?: string;
  available: boolean;
  content: TemplateResult | typeof nothing | null;
  empty: {
    description: string;
    action?: TemplateResult;
  };
};

export type SidebarRegionCallbacks = {
  activatePanel: (panelId: string) => void;
  closeSlot: (slot: SidebarSlotId) => void;
  openSlot: (slot: SidebarSlotId) => void;
  reorderPanel: (panelId: string, targetPanelId: string, placement: "before" | "after") => void;
  resizePanel: (columnId: string, size: number) => void;
  setDock: (dock: SidebarDock) => void;
  setExpanded: (expanded: boolean) => void;
  setOpen: (open: boolean) => void;
};
