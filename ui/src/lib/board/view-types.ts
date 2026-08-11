import type { BoardOp } from "@openclaw/gateway-protocol";

export type BoardGrantDecision = "granted" | "rejected";
export type BoardWidgetAppViewState =
  | { status: "ready"; viewId: string; expiresAtMs: number }
  | { status: "stale"; error: string };

export type BoardViewCallbacks = {
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  frameLoadFailed?: (name: string) => Promise<void>;
  widgetAppView?: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView?: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
