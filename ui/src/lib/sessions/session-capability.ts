import type { GatewaySessionMessageSubscription } from "@openclaw/gateway-client/browser";
import type {
  PreservedSessionWorktree,
  SessionOwner,
  SessionsAssignOwnerParams,
  SessionsDeleteResult,
  SessionsRecoverResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionBranch,
  SessionCompactionCheckpoint,
  SessionsBranchesSwitchResult,
  SessionsCompactionBranchResult,
  SessionsCompactionRestoreResult,
  SessionsForkResult,
  SessionsListResult,
  SessionsRewindResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
  SessionWorkspaceSetResult,
} from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import type { GatewayConnectionScope } from "../gateway-connection-lifecycle.ts";
import type { SessionCreateOutcome, SessionCreateParams } from "./create.ts";
import type { SessionGroupSettings } from "./custom-groups.ts";
import type { GitHubPublicationPresentationBinding } from "./github-publication-controller.ts";
import type { SessionArchivedFilter } from "./navigation.ts";
import type { SessionPatchRoute } from "./patch.ts";
import type {
  SessionChangedResult,
  SessionReconcileOptions,
  SessionRunTerminal,
} from "./reconcile.ts";

export type SessionState = {
  result: SessionsListResult | null;
  agentId: string | null;
  modelOverrides: Readonly<Record<string, string | null>>;
  loading: boolean;
  error: string | null;
  deletedSessions: readonly SessionDeletionFact[];
  /** Gateway-owned custom group catalog in display order. */
  groups: readonly string[];
  /** New Session defaults associated with each gateway-owned group. */
  groupSettings: readonly SessionGroupSettings[];
  /** Gateway-owned sidebar section order; pinned is intentionally absent. */
  sectionOrder: readonly string[];
};

type SessionDeletionFact = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

export type SessionGroupMutationResult = "completed" | "stale";
export type SessionGroupDefaultsStatus = "idle" | "loading" | "ready" | "unavailable";

export type SessionListOptions = {
  agentId?: string;
  spawnedBy?: string;
  boardFace?: "chat" | "dashboard";
  hasBoard?: boolean;
  activeMinutes?: number;
  search?: string;
  ownerId?: string;
  ownerFirst?: boolean;
  involvingMe?: boolean;
  offset?: number;
  limit?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  configuredAgentsOnly?: boolean;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  archivedFilter?: SessionArchivedFilter;
  append?: boolean;
};

export type SessionRefreshOptions = SessionListOptions & {
  force?: boolean;
  // Sidebar startup hydration must not block session creation or drop the open session.
  backgroundHydrate?: boolean;
};

export type SessionListScope = Readonly<Omit<SessionListOptions, "offset" | "append">>;

export type SessionListSnapshot = Pick<SessionState, "result" | "agentId" | "loading" | "error">;

export type SessionDeleteOptions = {
  agentId?: string;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  archivedOnly?: boolean;
};

export type SessionDeleteTarget = SessionDeleteOptions & {
  key: string;
};

export type SessionDeleteOutcome = Pick<SessionsDeleteResult, "deleted" | "worktreePreserved">;

export type SessionDeleteBatchResult = {
  deleted: string[];
  errors: string[];
  preservedWorktrees: PreservedSessionWorktree[];
};

export type SessionCompactResult = {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
  result?: { tokensBefore?: number; tokensAfter?: number };
};

export type SessionResetOptions = {
  agentId?: string | null;
};

export type SessionResetResult = "completed" | "not-started" | "uncertain";

export type SessionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    phase: ApplicationGatewayPhase;
    hello: GatewayHelloOk | null;
    assistantAgentId?: string | null;
    sessionKey?: string;
    selfUser?: AuthenticatedUser | null;
  };
  subscribe: (listener: (snapshot: SessionGateway["snapshot"]) => void) => () => void;
  subscribeEvents: (listener: (event: GatewayEventFrame) => void) => () => void;
};

export type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

export type SessionConnectionScope = GatewayConnectionScope;

export type SessionConnectionOwner = {
  capture: () => SessionConnectionScope | null;
  isCurrent: (scope: SessionConnectionScope) => boolean;
};

export type SessionCreateReconciliation = "blocking" | "background";

export type SessionMessageSubscription = GatewaySessionMessageSubscription;
export type SessionArchiveVisibility = "pending" | "archived";

export type GitHubPublicationBinding = GitHubPublicationPresentationBinding & {
  matches: (row: GatewaySessionRow) => boolean;
};

export type SessionCapability = {
  readonly githubPublication: {
    attach: (row: GatewaySessionRow, changed: () => void) => GitHubPublicationBinding | null;
  };
  readonly state: SessionState;
  /** Advances only when a canonical sessions.list result is published. */
  readonly canonicalListRevision: number;
  /** Captures the current Gateway connection generation for read-only requests. */
  captureConnectionScope: () => SessionConnectionScope | null;
  /** Whether a captured read-only request still belongs to the active connection. */
  isConnectionScopeCurrent: (scope: SessionConnectionScope) => boolean;
  list: (options?: SessionListOptions) => Promise<SessionsListResult | null>;
  listSnapshot: (scope: SessionListScope) => SessionListSnapshot;
  subscribeList: (
    scope: SessionListScope,
    listener: (snapshot: SessionListSnapshot) => void,
  ) => () => void;
  /** Observes an independent query; refresh rejects after failure, retirement or disposal. */
  observeList: (
    scope: SessionListScope,
    listener: (snapshot: SessionListSnapshot) => void,
  ) => { refresh: () => Promise<void>; dispose: () => void };
  refreshList: (options?: SessionRefreshOptions) => Promise<void>;
  /** Admits history through the deletion fence, even when outside the shared roster. */
  reconcile: (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions & { sourceCanonicalListRevision?: number },
  ) => boolean;
  reconcileChanged: (payload: unknown, options?: SessionReconcileOptions) => SessionChangedResult;
  reconcileRunTerminal: (terminal: SessionRunTerminal) => boolean;
  refresh: (options?: SessionRefreshOptions) => Promise<void>;
  /** Forces the remembered roster query; null means the attempt retired or failed. */
  refreshReplacement: (agentId?: string | null) => Promise<SessionsListResult | null>;
  createResult: (
    params?: SessionCreateParams,
    options?: { reconciliation?: SessionCreateReconciliation },
  ) => Promise<SessionCreateOutcome | null>;
  create: (params?: SessionCreateParams) => Promise<string | null>;
  recover: (params: { key: string; agentId?: string }) => Promise<SessionsRecoverResult | null>;
  patch: SessionPatchRoute;
  archiveVisibility: (key: string) => SessionArchiveVisibility | undefined;
  setArchivePending: (key: string, pending: boolean) => void;
  assignOwner: (
    key: string,
    owner: SessionsAssignOwnerParams["owner"],
    options?: { agentId?: string | null },
  ) => Promise<SessionOwner | null>;
  retireModelOverride: (key: string) => void;
  think: (key: string, agentId?: string | null) => string | undefined;
  /** Keep optimistic row changes in the published snapshot through later publishes. */
  patchRowLocal: (key: string, patch: Partial<GatewaySessionRow>) => void;
  /** True while a just-created work session awaits its canonical placement row. */
  isPreparedWorkSession: (key: string) => boolean;
  pullRequestSummary: (key: string) => SessionCatalogPullRequestSummary | undefined;
  capturePullRequestEpoch: (key: string) => object;
  setPullRequestSummary: (
    key: string,
    summary: SessionCatalogPullRequestSummary | undefined,
    epoch?: object,
  ) => void;
  deletionState: (
    key: string,
    agentId?: string | null,
    sessionId?: string,
  ) => "pending" | "confirmed" | undefined;
  delete: (key: string, options?: SessionDeleteOptions) => Promise<SessionDeleteOutcome>;
  deleteMany: (targets: readonly SessionDeleteTarget[]) => Promise<SessionDeleteBatchResult>;
  reset: (key: string, options?: SessionResetOptions) => Promise<SessionResetResult>;
  compact: (key: string, options?: { agentId?: string | null }) => Promise<SessionCompactResult>;
  listFiles: (
    key: string,
    options?: { agentId?: string | null; path?: string; search?: string },
  ) => Promise<SessionWorkspaceListResult | null>;
  getFile: (
    key: string,
    path: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionWorkspaceGetResult | null>;
  setFile: (
    key: string,
    path: string,
    content: string,
    options: { agentId?: string | null; expectedHash: string },
  ) => Promise<SessionWorkspaceSetResult | null>;
  subscribeMessages: (
    key: string,
    options?: { agentId?: string | null; includeApprovals?: boolean },
  ) => Promise<SessionMessageSubscription>;
  unsubscribeMessages: (subscription: SessionMessageSubscription) => Promise<void>;
  listCheckpoints: (
    key: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionCompactionCheckpoint[]>;
  branchCheckpoint: (
    key: string,
    checkpointId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsCompactionBranchResult>;
  restoreCheckpoint: (
    key: string,
    checkpointId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsCompactionRestoreResult>;
  rewind: (
    key: string,
    entryId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsRewindResult>;
  forkAtMessage: (
    key: string,
    entryId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsForkResult>;
  listBranches: (key: string, options?: { agentId?: string | null }) => Promise<SessionBranch[]>;
  switchBranch: (
    key: string,
    leafEntryId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsBranchesSwitchResult>;
  /** Loads one connection-owned group catalog; null means the attempt retired or failed. */
  groupsLoad: () => Promise<readonly SessionGroupSettings[] | null>;
  /** Generation of the catalog/defaults snapshot used by group-target routes. */
  groupsGeneration: () => number;
  /** Whether group defaults are current enough for a group-target route. */
  groupsStatus: () => SessionGroupDefaultsStatus;
  /** Invalidates the connection-owned group catalog before an explicit route retry. */
  groupsInvalidate: () => void;
  /** Replaces the group catalog; stale means the initiating connection retired. */
  groupsPut: (
    names: readonly string[],
    sectionOrder?: readonly string[],
  ) => Promise<SessionGroupMutationResult>;
  /** Renames a group; stale means the initiating connection retired before reconciliation. */
  groupsRename: (from: string, to: string) => Promise<SessionGroupMutationResult>;
  /** Updates the New Session defaults for one group. */
  groupsUpdate: (
    name: string,
    defaults: { cwd: string | null; worktree: boolean },
  ) => Promise<SessionGroupMutationResult>;
  /** Deletes a group; stale means the initiating connection retired before reconciliation. */
  groupsDelete: (name: string) => Promise<SessionGroupMutationResult>;
  subscribeCreated: (listener: (key: string) => void) => () => void;
  subscribe: (listener: (state: SessionState) => void) => () => void;
  dispose: () => void;
};
