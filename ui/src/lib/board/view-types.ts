import type { BoardOp, BoardSnapshot, BoardWidget } from "@openclaw/gateway-protocol";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";

export type BoardGrantDecision = "granted" | "rejected";
export type BoardWidgetAppViewState =
  | { status: "ready"; viewId: string; expiresAtMs: number }
  | { status: "stale"; error: string };

/** Native Control UI card, derived from session state rather than the board store. */
type BoardStoredWidget = BoardWidget & {
  builtin?: never;
  readOnly?: false | undefined;
};
type BoardBuiltinWidget = Omit<BoardWidget, "contentKind"> & {
  builtin: "observer" | "swarm";
  contentKind: "builtin";
  readOnly: true;
};
export type BoardViewWidget = BoardStoredWidget | BoardBuiltinWidget;
export type BoardViewSnapshot = Omit<BoardSnapshot, "widgets"> & {
  widgets: BoardViewWidget[];
};

export type BoardObserverContext = {
  activeRunId: string | null;
  digests: readonly SessionObserverDigest[];
  lastReadAt?: number;
};

export type BoardViewCallbacks = {
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  frameLoadFailed?: (name: string) => Promise<void>;
  widgetAppView?: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView?: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
