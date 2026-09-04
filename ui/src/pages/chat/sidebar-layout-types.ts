export type SidebarSlotId =
  | "browser"
  | "companion"
  | "conversation"
  | "dashboard"
  | "desktop"
  | "detail"
  | "discussion"
  | "tasks"
  | "terminal"
  | "workspace"
  | `plugin:${string}/${string}`;
export type SidebarPanel = { id: string; slot: SidebarSlotId };
export type SidebarDock = "bottom" | "left" | "right";
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
  mainPanelId?: string;
  dock?: SidebarDock;
  open?: boolean;
  expanded?: boolean;
};
