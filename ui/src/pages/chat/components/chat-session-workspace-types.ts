import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import type { ChatWorkspaceDock, UiSettings } from "../../../app/settings.ts";
import type { SessionCapability, SessionScopeHost } from "../../../lib/sessions/index.ts";
import type { SidebarContent, SidebarSelection } from "./chat-sidebar.ts";

export type SessionWorkspaceProps = {
  collapsed: boolean;
  sessionKey: string;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  error: string | null;
  activeId: string | null;
  dock: ChatWorkspaceDock;
  /** Pane too narrow for a side rail: presentation forces the bottom dock
   * (the persisted dock preference still applies once the pane widens). */
  narrowLayout: boolean;
  onToggleCollapsed: () => void;
  onSetDock: (dock: ChatWorkspaceDock) => void;
  onRefresh: () => void;
  onBrowsePath: (path: string) => void;
  onOpenFile: (path: string, origin: "session" | "workspace") => void;
  onSearch: (search: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onToggleTerminal?: () => void;
  onToggleBrowser?: () => void;
  onToggleDesktop?: () => void;
  onToggleCustodian?: () => void;
  /** Opens the session diff panel; absent until a usable checkout is known. */
  onOpenDiff?: () => void;
};

export type SessionWorkspaceState = {
  activeId: string | null;
  agentId: string;
  browserPath: string;
  browserSearch: string;
  browserSearchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  collapsed: boolean;
  connectionEpoch: number;
  dock: ChatWorkspaceDock;
  diffContent?: SidebarContent;
  error: string | null;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  pendingReload: boolean;
  sessionKey: string;
};

// Re-renders must preserve the document identity or the mounted diff panel
// treats its loader as new and requests sessions.diff again.
export type SessionWorkspaceHost = {
  sessionKey: string;
  sessions: SessionCapability;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch: number;
  hello: GatewayHelloOk | null;
  terminalAvailable?: boolean;
  browserPanelAvailable?: boolean;
  assistantAgentId?: string | null;
  agentsList?: SessionScopeHost["agentsList"];
  settings?: UiSettings;
  sessionWorkspaceState?: SessionWorkspaceState;
  sessionWorkspaceDraftScope?: string;
  sidebarContent: SidebarSelection | null;
  requestUpdate?: () => void;
  handleOpenSidebar: (content: SidebarSelection | null) => void;
};

/** Agent owning the pane's current session: explicit key scope first, then the
 * assistant/default agent. */
