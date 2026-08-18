import type {
  SessionCreatedActor,
  SessionsAssignOwnerParams,
} from "../../packages/gateway-protocol/src/index.js";

/** Agent identity fields returned by gateway session listing APIs. */
type GatewayAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

/** Model summary returned for an agent/session row. */
type GatewayAgentModel = {
  primary?: string;
  fallbacks?: string[];
};

/** Runtime selection metadata for an agent row. */
export type GatewayAgentRuntime = {
  id: string;
  fallback?: "openclaw" | "none";
  cloudPlacementSupported?: boolean;
  source:
    | "env"
    | "agent"
    | "defaults"
    | "model"
    | "provider"
    | "implicit"
    | "session"
    | "session-key";
};

/** Thinking-level option exposed to UI clients. */
export type GatewayThinkingLevelOption = {
  id: string;
  label: string;
};

export type GatewayAgentKind = "agent" | "system";

/** Assignable identity returned by the complete session-owner facet. */
export type SessionOwnerFacetIdentity = SessionsAssignOwnerParams["owner"] &
  Pick<SessionCreatedActor, "label" | "avatarUrl">;

/** Per-session Control UI face preference carried by session list rows. */
export type SessionBoardFace = "chat" | "dashboard";

/** Common agent row shape used by session list responses. */
export type GatewayAgentRow = {
  id: string;
  kind?: GatewayAgentKind;
  name?: string;
  identity?: GatewayAgentIdentity;
  workspace?: string;
  workspaceGit?: boolean;
  model?: GatewayAgentModel;
  agentRuntime?: GatewayAgentRuntime;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

/** Generic base for paged session-list responses. */
export type SessionsListResultBase<TDefaults, TRow> = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  /** Complete owner facet for the filtered result, independent of pagination. */
  owners?: SessionOwnerFacetIdentity[];
  defaults: TDefaults;
  sessions: TRow[];
};

/** Generic base for successful session patch responses. */
export type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
