export type SidebarSlotId = "chat" | "discussion" | "detail";
export type SidebarSide = "left" | "right";
export type SidebarPanel = { id: string; slot: SidebarSlotId };
export type SidebarColumn = {
  id: string;
  side: SidebarSide;
  panels: SidebarPanel[];
  activePanelId: string;
  width: number;
};
export type SidebarLayout = { columns: SidebarColumn[] };
