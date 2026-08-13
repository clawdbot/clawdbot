import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { SessionVisibility } from "../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionCreatedActor } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionAgentAttentionIconId } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionRunStatus } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import {
  normalizeCatalogProjectGrouping,
  type CatalogProjectGrouping,
} from "../lib/sessions/catalog-project-grouping.ts";
import {
  normalizeSidebarSessionsGrouping,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { CloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SessionPlacementState } from "./session-row-badges.ts";

export type SidebarSessionAttention =
  | { kind: "none" }
  | { kind: "question" }
  | { kind: "approval" }
  | { kind: "agent"; note: string; icon: SessionAgentAttentionIconId }
  | { kind: "error"; reason: string };

/** Client-owned attention that can name a session before its row is loaded. */
export type SidebarKnownSessionAttention = {
  sessionKey: string;
  attention: Extract<SidebarSessionAttention, { kind: "question" } | { kind: "approval" }>;
};

export const SIDEBAR_SESSION_NO_ATTENTION: SidebarSessionAttention = { kind: "none" };

export function sidebarSessionAttentionPriority(attention: SidebarSessionAttention): number {
  switch (attention.kind) {
    case "question":
    case "approval":
      return 3;
    case "agent":
      return 2;
    case "error":
      return 1;
    case "none":
      return 0;
    default:
      return attention satisfies never;
  }
}

export type SidebarRecentSession = {
  key: string;
  sessionId?: string;
  displayName?: string;
  incognito?: boolean;
  createdActor?: SessionCreatedActor;
  archivedBy?: SessionCreatedActor;
  label: string;
  /** Compact repo/branch/node line for work sessions. */
  subtitle?: string;
  href: string;
  active: boolean;
  visuallyActive: boolean;
  hasActiveRun: boolean;
  activeRunIds?: readonly string[];
  modelSelectionLocked: boolean;
  kind?: string;
  pinned: boolean;
  archived?: boolean;
  visibility?: SessionVisibility;
  draftOwnedBySelf?: boolean;
  category?: string;
  boardFace?: BoardFace;
  channel?: string;
  channelSession?: boolean;
  workSession?: boolean;
  /** ACP-backed harness session; lands in the Coding zone with work sessions. */
  acpSession?: boolean;
  worktreeId?: string;
  placementState?: SessionPlacementState;
  workspaceConflictCount?: number;
  cloudWorkerStopAction: CloudWorkerStopAction | null;
  hasAutomation: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  outboxCount?: number;
  hasComposerDraft?: boolean;
  unread: boolean;
  lastMessagePreview?: string;
  lastReadAt?: number;
  attention: SidebarSessionAttention;
  agentStatusNote?: string;
  observerDigest?: Pick<
    SessionObserverDigest,
    "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
  >;
  spawnedBy?: string;
  forkSource?: { sessionKey: string; sessionId: string; entryId?: string };
  status?: SessionRunStatus;
  startedAt?: number;
  updatedAt?: number | null;
  endedAt?: number;
  runtimeMs?: number;
  runtimeSampledAt?: number;
  childSessionKeys: readonly string[];
  children: readonly SidebarRecentSession[];
  isChild: boolean;
  loadingChildren: boolean;
  containsActiveDescendant: boolean;
  runningChildCount: number;
  failedChildCount: number;
};

export const enum RowVisibilityReason {
  Any,
  ActiveRun,
  Attention,
}

export function rowDemandsVisibility(
  row: SidebarRecentSession,
  reason: RowVisibilityReason = RowVisibilityReason.Any,
) {
  return reason === RowVisibilityReason.ActiveRun
    ? row.hasActiveRun
    : reason === RowVisibilityReason.Attention
      ? row.attention.kind !== "none"
      : row.visuallyActive ||
        row.containsActiveDescendant ||
        row.hasActiveRun ||
        row.runningChildCount > 0 ||
        row.attention.kind !== "none";
}

export type SidebarSessionMenuState = {
  session: SidebarRecentSession;
  x: number;
  y: number;
};

export type SidebarSessionGroupMenuState = {
  group: string;
  x: number;
  y: number;
};

export type SidebarSessionSortMode = "created" | "updated" | "people";
export type SidebarSessionStatusFilter = "active" | "archived" | "all";
export type SidebarSessionsScrollState = "none" | "top" | "middle" | "bottom";

export function resolveSidebarSessionsScrollState(
  element: HTMLElement,
): SidebarSessionsScrollState {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop <= 1) {
    return "none";
  }
  if (element.scrollTop <= 1) {
    return "top";
  }
  if (element.scrollTop >= maxScrollTop - 1) {
    return "bottom";
  }
  return "middle";
}
export type SidebarSectionDropTarget = {
  sectionId: string;
  position: "before" | "after";
};

export type SidebarSessionMutationScope = {
  epoch: number;
  context: ApplicationContext<RouteId>;
  gateway: ApplicationContext<RouteId>["gateway"];
  sessions: SessionCapability;
  client: GatewayBrowserClient;
  selectedAgentId: string;
};

export type SidebarSessionMutationResult = "completed" | "failed" | "stale";

export type SidebarSessionPatch = {
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
  label?: string | null;
  category?: string | null;
};

export const SIDEBAR_AGENT_SESSION_LIST_LIMIT = 60;
export const SIDEBAR_SESSION_PAGE_SIZE = 10;
export const SIDEBAR_SESSION_SEE_LESS_THRESHOLD = 30;

export function sidebarSessionMetaId(key: string): string {
  return `sidebar-session-meta-${encodeURIComponent(key)}`;
}

export function sidebarSessionStateId(key: string): string {
  return `sidebar-session-state-${encodeURIComponent(key)}`;
}

const SIDEBAR_SESSION_GROUPING_STORAGE_KEY = "openclaw:sidebar:sessions:grouping";
const SIDEBAR_SESSION_CATALOG_GROUPING_STORAGE_KEY = "openclaw:sidebar:sessions:catalog-grouping";
const SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY = "openclaw:sidebar:sessions:show-cron";
const SIDEBAR_SESSION_SHOW_SYSTEM_STORAGE_KEY = "openclaw:sidebar:sessions:show-system";
const SIDEBAR_SESSION_STATUS_FILTER_STORAGE_KEY = "openclaw:sidebar:sessions:status-filter";
const SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY =
  "openclaw:sidebar:sessions:collapsed-sections";
const SIDEBAR_HIDDEN_SESSION_CATALOGS_STORAGE_KEY = "openclaw:sidebar:sessions:hidden-catalogs";
export const SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT =
  "openclaw:sidebar-hidden-catalogs-changed";

export function limitSidebarSessionRows(rows: SidebarRecentSession[], limit: number) {
  const requiredCount = rows.filter((row) => row.active || row.pinned).length;
  let optionalSlots = Math.max(0, limit - requiredCount);
  // Active and pinned sessions remain reachable without changing their
  // relative order, even when their sort position falls outside the page.
  return rows.filter((row) => {
    if (row.active || row.pinned) {
      return true;
    }
    if (optionalSlots === 0) {
      return false;
    }
    optionalSlots -= 1;
    return true;
  });
}

export function loadStoredSidebarSessionsGrouping(): SidebarSessionsGrouping {
  return normalizeSidebarSessionsGrouping(
    getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY),
  );
}

export function loadStoredSidebarCatalogGrouping(): CatalogProjectGrouping {
  return normalizeCatalogProjectGrouping(
    getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_CATALOG_GROUPING_STORAGE_KEY),
  );
}

export function loadStoredSidebarSessionsShowCron(): boolean {
  return getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY) === "true";
}

export function loadStoredSidebarSessionsShowSystem(): boolean {
  return getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SHOW_SYSTEM_STORAGE_KEY) === "true";
}

export function loadStoredSidebarSessionStatusFilter(): SidebarSessionStatusFilter {
  const stored = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_STATUS_FILTER_STORAGE_KEY);
  return stored === "archived" || stored === "all" ? stored : "active";
}

export function loadStoredCollapsedSessionSections(): ReadonlySet<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY);
    if (raw == null) {
      // First run: the Coding zone starts collapsed so dev sessions stay muted
      // until the user opts in; expanding persists an empty entry for "work".
      return new Set(["work"]);
    }
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.flatMap((value) => (typeof value === "string" && value ? [value] : []))
        : [],
    );
  } catch {
    return new Set(["work"]);
  }
}

export function loadStoredHiddenSessionCatalogIds(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(
      getSafeLocalStorage()?.getItem(SIDEBAR_HIDDEN_SESSION_CATALOGS_STORAGE_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.flatMap((value) => (typeof value === "string" && value ? [value] : []))
        : [],
    );
  } catch {
    return new Set();
  }
}

export function storeSidebarSessionsGrouping(grouping: SidebarSessionsGrouping) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY, grouping);
}

export function storeSidebarCatalogGrouping(value: CatalogProjectGrouping) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_CATALOG_GROUPING_STORAGE_KEY, value);
}

export function storeSidebarSessionsShowCron(show: boolean) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY, String(show));
}

export function storeSidebarSessionsShowSystem(show: boolean) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_SHOW_SYSTEM_STORAGE_KEY, String(show));
}

export function storeSidebarSessionStatusFilter(value: SidebarSessionStatusFilter) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_STATUS_FILTER_STORAGE_KEY, value);
}

export function storeCollapsedSessionSections(sections: ReadonlySet<string>) {
  getSafeLocalStorage()?.setItem(
    SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY,
    JSON.stringify([...sections]),
  );
}

function storeHiddenSessionCatalogIds(ids: ReadonlySet<string>) {
  getSafeLocalStorage()?.setItem(
    SIDEBAR_HIDDEN_SESSION_CATALOGS_STORAGE_KEY,
    JSON.stringify([...ids]),
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT));
  }
}

/** Single owner for hide/show of one section: sidebar menu, undo, and Settings all
 * land here, so no caller re-derives the set from its own possibly stale copy. */
export function setStoredSessionCatalogHidden(catalogId: string, hidden: boolean) {
  const next = new Set(loadStoredHiddenSessionCatalogIds());
  if (hidden) {
    next.add(catalogId);
  } else {
    next.delete(catalogId);
  }
  storeHiddenSessionCatalogIds(next);
}

export const SIDEBAR_SESSION_SORT_OPTIONS = [
  { mode: "created", labelKey: "chat.sidebar.sortCreated" },
  { mode: "updated", labelKey: "chat.sidebar.sortUpdated" },
  { mode: "people", labelKey: "sessionsView.people" },
] as const satisfies ReadonlyArray<{
  mode: SidebarSessionSortMode;
  labelKey: "chat.sidebar.sortCreated" | "chat.sidebar.sortUpdated" | "sessionsView.people";
}>;

export const SIDEBAR_SESSION_STATUS_OPTIONS = [
  "active",
  "archived",
  "all",
] as const satisfies readonly SidebarSessionStatusFilter[];

export function sessionCatalogHostKey(catalogId: string, hostId: string): string {
  return `${catalogId}\u0000${hostId}`;
}
