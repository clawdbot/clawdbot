export type ChatSplitPane = { id: string; sessionKey: string };

export interface SessionSplitHost extends HTMLElement {
  readonly sessionSplitAvailable: boolean;
}

export type ChatSplitColumn = {
  id: string;
  panes: ChatSplitPane[];
  paneWeights: number[];
};

export type ChatSplitEdge = "left" | "right" | "up" | "down";

export type ChatSplitLayout = {
  columns: ChatSplitColumn[];
  columnWeights: number[];
  activePaneId: string;
};
