export type SidebarSlotId =
  | "browser"
  | "chat"
  | "companion"
  | "desktop"
  | "detail"
  | "discussion"
  | "tasks"
  | "terminal"
  | "workspace";
export type SidebarPanel = { id: string; slot: SidebarSlotId };
export type SidebarDock = "bottom" | "right";
export type SidebarColumn = {
  id: string;
  side: "right";
  panels: SidebarPanel[];
  activePanelId: string;
  height: number;
  width: number;
};
export type SidebarLayout = {
  columns: SidebarColumn[];
  dock?: SidebarDock;
  open?: boolean;
  expanded?: boolean;
};
