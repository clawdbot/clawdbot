import type { ReactiveControllerHost } from "lit";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type {
  SidebarRecentSession,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export interface SessionOrganizerControllerHost extends ReactiveControllerHost {
  readonly sessionData: Pick<
    SessionDataController,
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "publishSessionMutationError"
    | "refreshSidebarSessions"
    | "resetForStatusFilter"
    | "sessionMutationError"
  >;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsShowSystem: boolean;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  listSessionGroupFolders(path?: string): Promise<FsListDirResult>;
  sessionGroupDefaults(name: string): { cwd: string; worktree: boolean } | null;
  knownSessionCatalogIds(): string[];
  knownSectionOrder(): string[];
  pruneSidebarSessionEntry(key: string): void;
  reconciledSidebarZone(): { sidebarEntries: readonly string[] };
  replaceCurrentSession(sessionKey: string): void;
  selectSession(sessionKey: string): void;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}
