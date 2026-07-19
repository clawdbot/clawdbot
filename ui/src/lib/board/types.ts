export type BoardTab = {
  tabId: string;
  title: string;
  position: number;
  chatDock: "left" | "right" | "bottom" | "hidden";
};

export type BoardWidget = {
  name: string;
  tabId: string;
  title?: string;
  contentKind: "html" | "mcp-app";
  sizeW: number;
  sizeH: number;
  position: number;
  grantState: "none" | "pending" | "granted" | "rejected";
  revision: number;
};

export type BoardSnapshot = {
  sessionKey: string;
  revision: number;
  tabs: BoardTab[];
  widgets: BoardWidget[];
};

export type BoardOp =
  | { kind: "tab_create"; tabId: string; title: string; chatDock?: BoardTab["chatDock"] }
  | {
      kind: "tab_update";
      tabId: string;
      title?: string;
      chatDock?: BoardTab["chatDock"];
      position?: number;
    }
  | { kind: "tab_delete"; tabId: string }
  | { kind: "tabs_reorder"; tabIds: string[] }
  | { kind: "widget_move"; name: string; tabId?: string; position?: number; after?: string }
  | { kind: "widget_resize"; name: string; sizeW: number; sizeH: number }
  | { kind: "widget_remove"; name: string };
