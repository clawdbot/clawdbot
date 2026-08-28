import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionPlacementDiskSpace } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { SessionVisibility } from "../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type {
  SessionObserverDigest,
  SessionCreatedActor,
  SessionOwner,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionAgentAttentionIconId } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionRunStatus } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import type { SessionWorkContext } from "../lib/session-display.ts";
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
  owner?: SessionOwner;
  participants?: SessionParticipant[];
  participantCount?: number;
  archivedBy?: SessionCreatedActor;
  label: string;
  /**
   * Stored user label, undecorated. `label` above is the resolved display name
   * and can carry a derived account or channel; rename edits this one so a
   * derived string never lands back in persisted state.
   */
  userLabel?: string;
  /** Compact repo/branch/node line for work sessions. */
  subtitle?: string;
  workContext?: SessionWorkContext;
  href: string;
  active: boolean;
  visuallyActive: boolean;
  hasActiveRun: boolean;
  /** Raw Gateway liveness used for operations even when display status is terminal. */
  gatewayHasActiveRun?: boolean;
  activeRunIds?: readonly string[];
  modelSelectionLocked: boolean;
  kind?: string;
  pinned: boolean;
  archived?: boolean;
  visibility?: SessionVisibility;
  draftOwnedBySelf?: boolean;
  category?: string;
  icon?: string;
  channelAvatarUrl?: string;
  boardFace?: BoardFace;
  channel?: string;
  channelSession?: boolean;
  workSession?: boolean;
  /** ACP-backed harness session; lands in the Coding zone with work sessions. */
  acpSession?: boolean;
  worktreeId?: string;
  execNode?: string;
  placementState?: SessionPlacementState;
  diskSpaceStatus?: SessionPlacementDiskSpace["status"];
  workspaceConflictCount?: number;
  cloudWorkerStopAction: CloudWorkerStopAction | null;
  hasAutomation: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  outboxAttentionCount?: number;
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
  createdAt?: number;
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

export type SidebarSessionHovercardRow = Pick<
  SidebarRecentSession,
  | "createdActor"
  | "createdAt"
  | "channelAvatarUrl"
  | "endedAt"
  | "label"
  | "lastMessagePreview"
  | "participantCount"
  | "participants"
  | "status"
  | "startedAt"
  | "updatedAt"
  | "workContext"
>;

export const enum RowVisibilityReason {
  Any = 0,
  ActiveRun = 1,
  Attention = 2,
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
export type SidebarSessionOwnerFilter = {
  ownerId: string | null;
  involvingMe: boolean;
};
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
  // Owner-scoped abort signal for this epoch's destructive confirmations. A
  // retired epoch aborts it so any open dialog dismisses itself instead of
  // surviving a reconnect; scopes built outside SessionDataController may
  // leave this unset and keep their own stale-guard behavior.
  signal?: AbortSignal;
};

export type SidebarSessionMutationResult = "completed" | "failed" | "stale";

export type SidebarSessionPatch = {
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
  label?: string | null;
  icon?: string | null;
  category?: string | null;
};

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
const SIDEBAR_SESSION_SHOW_PREVIEW_STORAGE_KEY = "openclaw:sidebar:sessions:show-preview";
const SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY = "openclaw:sidebar:sessions:show-cron";
const SIDEBAR_SESSION_SHOW_SYSTEM_STORAGE_KEY = "openclaw:sidebar:sessions:show-system";
const SIDEBAR_SESSION_STATUS_FILTER_STORAGE_KEY = "openclaw:sidebar:sessions:status-filter";
const SIDEBAR_SESSION_SORT_MODE_STORAGE_KEY = "openclaw:sidebar:sessions:sort-mode";
const SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY =
  "openclaw:sidebar:sessions:collapsed-sections";
const SIDEBAR_HIDDEN_SESSION_CATALOGS_STORAGE_KEY = "openclaw:sidebar:sessions:hidden-catalogs";
const SIDEBAR_SESSION_OWNER_FILTER_STORAGE_PREFIX =
  "openclaw.control.sidebarSessionOwnerFilter.v1:";
export const SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT =
  "openclaw:sidebar-hidden-catalogs-changed";

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

export function loadStoredSidebarSessionsShowPreview(): boolean {
  return getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SHOW_PREVIEW_STORAGE_KEY) === "true";
}

export function loadStoredSidebarSessionsShowSystem(): boolean {
  return getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SHOW_SYSTEM_STORAGE_KEY) === "true";
}

export function loadStoredSidebarSessionStatusFilter(): SidebarSessionStatusFilter {
  const stored = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_STATUS_FILTER_STORAGE_KEY);
  return stored === "archived" || stored === "all" ? stored : "active";
}

function sidebarSessionOwnerFilterStorageKey(gatewayUrl: string, selfUserId: string): string {
  return `${SIDEBAR_SESSION_OWNER_FILTER_STORAGE_PREFIX}${gatewayOriginScope(gatewayUrl)}:${encodeURIComponent(selfUserId)}`;
}

export function loadStoredSidebarSessionOwnerFilter(
  gatewayUrl: string,
  selfUserId: string,
): SidebarSessionOwnerFilter {
  try {
    const stored = getSafeLocalStorage()?.getItem(
      sidebarSessionOwnerFilterStorageKey(gatewayUrl, selfUserId),
    );
    const ownerId = stored?.startsWith("owner:") ? stored.slice("owner:".length).trim() : "";
    return {
      ownerId: stored === "involving-me" ? null : ownerId || null,
      involvingMe: stored === "involving-me",
    };
  } catch {
    // Privacy mode or a disabled store should not break sidebar rendering.
    return { ownerId: null, involvingMe: false };
  }
}

export function loadStoredSidebarSessionSortMode(): SidebarSessionSortMode {
  const stored = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SORT_MODE_STORAGE_KEY);
  // "people" stays readable here even when the gateway later hides the
  // capability; effectiveSessionSortMode() downgrades it at render time.
  return stored === "updated" || stored === "people" ? stored : "created";
}

export function loadStoredCollapsedSessionSections(): ReadonlySet<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY);
    if (raw == null) {
      // First run: Coding stays muted while Online preserves its expanded
      // default until the user explicitly collapses it.
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

export function storeSidebarSessionsShowPreview(show: boolean) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_SHOW_PREVIEW_STORAGE_KEY, String(show));
}

export function storeSidebarSessionsShowSystem(show: boolean) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_SHOW_SYSTEM_STORAGE_KEY, String(show));
}

export function storeSidebarSessionStatusFilter(value: SidebarSessionStatusFilter) {
  getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_STATUS_FILTER_STORAGE_KEY, value);
}

export function storeSidebarSessionOwnerFilter(
  gatewayUrl: string,
  selfUserId: string,
  filter: SidebarSessionOwnerFilter,
): void {
  try {
    const storage = getSafeLocalStorage();
    const key = sidebarSessionOwnerFilterStorageKey(gatewayUrl, selfUserId);
    const value = filter.involvingMe
      ? "involving-me"
      : filter.ownerId
        ? `owner:${filter.ownerId}`
        : null;
    if (value === null) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, value);
    }
  } catch {
    // Keep the in-memory filter when persistence is unavailable.
  }
}

/** People collapses to Created only where the gateway has authoritatively
 *  denied the capability; an undefined capability (reconnect) keeps the mode. */
export function resolveSidebarSessionSortMode(
  mode: SidebarSessionSortMode,
  keepPeople: boolean,
): SidebarSessionSortMode {
  return mode === "people" && !keepPeople ? "created" : mode;
}

/** Persists the resolved mode, never the rejected request, so a reload cannot
 *  restore a People sort the gateway already refused. Returns what was stored. */
export function storeSidebarSessionSortMode(
  mode: SidebarSessionSortMode,
  peopleCapability: boolean | undefined,
): SidebarSessionSortMode {
  const resolved = resolveSidebarSessionSortMode(mode, peopleCapability !== false);
  try {
    getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_SORT_MODE_STORAGE_KEY, resolved);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
  return resolved;
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
  { mode: "people", labelKey: "sessionsView.owners" },
] as const satisfies ReadonlyArray<{
  mode: SidebarSessionSortMode;
  labelKey: "chat.sidebar.sortCreated" | "chat.sidebar.sortUpdated" | "sessionsView.owners";
}>;

export const SIDEBAR_SESSION_STATUS_OPTIONS = [
  "active",
  "archived",
  "all",
] as const satisfies readonly SidebarSessionStatusFilter[];

export function sessionCatalogHostKey(catalogId: string, hostId: string): string {
  return `${catalogId}\u0000${hostId}`;
}
