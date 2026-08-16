export type SidebarWorkboardBoard = {
  id: string;
  name?: string;
  icon?: string;
  color?: string;
};

export type SidebarWorkboardSnapshot = {
  boards: readonly SidebarWorkboardBoard[];
  ready: boolean;
};

export type SidebarWorkboardRuntime = {
  sync: (
    client: import("../api/gateway.ts").GatewayBrowserClient | null,
    connected: boolean,
  ) => void;
  handleGatewayEvent: (event: string) => void;
  dispose: () => void;
};

export type SidebarWorkboardHost = {
  notify: () => void;
  setBoardsReady: (ready: boolean) => void;
  clearBoards: () => void;
};

export type SidebarWorkboardRenderers = {
  renderEntry: (params: {
    board: SidebarWorkboardBoard;
    basePath: string;
    active: boolean;
    onNavigate: (pathname: string) => void;
  }) => TemplateResult;
  renderCustomize: (
    boards: readonly SidebarWorkboardBoard[],
    sidebarEntries: readonly string[],
  ) => TemplateResult;
};

export type SidebarWorkboardRuntimeFactory = {
  createSidebarWorkboardRuntime: (
    onSnapshot: (snapshot: SidebarWorkboardSnapshot) => void,
    host: SidebarWorkboardHost,
  ) => SidebarWorkboardRuntime;
  renderSidebarWorkboardEntry: SidebarWorkboardRenderers["renderEntry"];
  renderSidebarWorkboardCustomize: SidebarWorkboardRenderers["renderCustomize"];
};

export const EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT: SidebarWorkboardSnapshot = {
  boards: [],
  ready: false,
};
import type { TemplateResult } from "lit";
