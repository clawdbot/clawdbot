export type SidebarSlotId =
  | "browser"
  | "chat"
  | "companion"
  | "desktop"
  | "detail"
  | "discussion"
  | "tasks"
  | "terminal"
  | "trajectory"
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
  /** The panel may stay open as a type picker after its last tab closes. */
  open?: boolean;
  expanded?: boolean;
};
