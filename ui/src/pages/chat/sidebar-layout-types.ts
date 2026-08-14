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
export type SidebarColumn = {
  id: string;
  side: "right";
  panels: SidebarPanel[];
  activePanelId: string;
  width: number;
};
export type SidebarLayout = {
  columns: SidebarColumn[];
  /** The panel may stay open as a type picker after its last tab closes. */
  open?: boolean;
  expanded?: boolean;
};
