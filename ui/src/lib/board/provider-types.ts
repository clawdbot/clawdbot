import type { BoardCommandEvent, BoardOp, BoardSnapshot } from "@openclaw/gateway-protocol";
import type { BoardEventStream, BoardSnapshotSignal } from "./provider-signals.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";

type BoardPinPlacement = {
  title?: string;
  name?: string;
  tabId?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  after?: string;
};

type BoardPinWidgetInput = BoardPinPlacement & { docId: string };
type BoardPinMcpAppInput = BoardPinPlacement & { viewId: string };

export type BoardProvider = {
  readonly sessionKey: string;
  readonly canMutate: boolean;
  readonly canGrant: boolean;
  readonly canPinWidgets: boolean;
  readonly canPinMcpApps: boolean;
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  applyOps(ops: BoardOp[]): Promise<void>;
  grant(name: string, decision: "granted" | "rejected"): Promise<void>;
  pinWidget(input: BoardPinWidgetInput): Promise<void>;
  pinMcpApp(input: BoardPinMcpAppInput): Promise<void>;
  widgetFrameUrl(name: string, revision: number): string;
  refreshWidgetFrame(name: string): Promise<void>;
  widgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState>;
  readonly events: BoardEventStream<BoardCommandEvent>;
};
