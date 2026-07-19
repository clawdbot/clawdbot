/** Temporary board view contract. A stitch commit will point these at gateway-protocol. */

type BoardChatDock = "left" | "right" | "bottom" | "hidden";
type BoardGrantState = "none" | "pending" | "granted" | "rejected";
export type BoardGrantDecision = "granted" | "rejected";

export type BoardTab = {
  tabId: string;
  title: string;
  position: number;
  chatDock: BoardChatDock;
};

export type BoardWidget = {
  name: string;
  tabId: string;
  title?: string;
  contentKind: "html" | "mcp-app";
  sizeW: number;
  sizeH: number;
  position: number;
  grantState: BoardGrantState;
  revision: number;
};

export type BoardSnapshot = {
  sessionKey: string;
  revision: number;
  tabs: BoardTab[];
  widgets: BoardWidget[];
};

export type BoardOp =
  | { kind: "tab_create"; tabId: string; title: string; chatDock?: BoardChatDock }
  | {
      kind: "tab_update";
      tabId: string;
      title?: string;
      chatDock?: BoardChatDock;
      position?: number;
    }
  | { kind: "tab_delete"; tabId: string }
  | { kind: "tabs_reorder"; tabIds: string[] }
  | { kind: "widget_move"; name: string; tabId?: string; position?: number; after?: string }
  | { kind: "widget_resize"; name: string; sizeW: number; sizeH: number }
  | { kind: "widget_remove"; name: string };

export type BoardViewCallbacks = {
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  pinRequest?: never;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
