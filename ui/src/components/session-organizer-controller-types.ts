import type { ReactiveControllerHost } from "lit";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
} from "../../../packages/gateway-protocol/src/index.js";
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
    | "resetSessionList"
    | "sessionMutationError"
  >;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsShowPreview: boolean;
  sessionsShowSystem: boolean;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  listSessionGroupFolders(path?: string): Promise<FsListDirResult>;
  inspectSessionGroupRepository(path?: string): Promise<WorktreeRepositoryStatus>;
  sessionGroupDefaults(name: string): { cwd: string; worktree: boolean } | null;
  knownSessionCatalogIds(): string[];
  knownSectionOrder(): string[];
  pruneSidebarSessionEntry(key: string): void;
  reconciledSidebarZone(): { sidebarEntries: readonly string[] };
  selectSession(sessionKey: string): void;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}
