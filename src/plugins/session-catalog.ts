import type {
  SessionCatalogHost,
  SessionsCatalogArchiveParams,
  SessionsCatalogContinueParams,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";

export type SessionCatalogListProviderParams = {
  /** Trimmed, non-empty search capped at 500 UTF-16 code units by the gateway. */
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
};
export type SessionCatalogReadProviderParams = Omit<SessionsCatalogReadParams, "catalogId">;
export type SessionCatalogContinueProviderParams = Omit<
  SessionsCatalogContinueParams,
  "catalogId"
> & {
  /** Caller's gateway scopes so providers can gate high-authority continues up front. */
  clientScopes?: readonly string[];
};
export type SessionCatalogArchiveProviderParams = Omit<SessionsCatalogArchiveParams, "catalogId">;

export type SessionCatalogTerminalPlan =
  | {
      kind: "local";
      argv: string[];
      cwd?: string;
      title?: string;
      /** PATH that resolved argv[0], needed by env-based script interpreters. */
      pathEnv?: string;
    }
  | {
      kind: "node";
      nodeId: string;
      command: string;
      paramsJSON: string;
      cwd?: string;
      title?: string;
    };

export type SessionCatalogCreateTarget = {
  model: string;
  /** Concrete runtime pinned onto the created session so config reloads cannot retarget it. */
  agentRuntime: string;
};

export type SessionUpstreamJsonValue =
  | null
  | boolean
  | number
  | string
  | SessionUpstreamJsonValue[]
  | { [key: string]: SessionUpstreamJsonValue };

export type SessionUpstreamKind = "claude-cli" | "codex-app-server";

export type SessionUpstreamProbe = {
  sessionKey: string;
  agentId: string;
  threadId: string;
  hostId: string;
  upstreamKind: SessionUpstreamKind;
  upstreamRef: SessionUpstreamJsonValue;
  marker: SessionUpstreamJsonValue | null;
  ownRecentUserTexts: string[];
};

export type SessionUpstreamActivity =
  | {
      kind: "activity";
      sessionKey: string;
      humanTurns: number;
      nextMarker: SessionUpstreamJsonValue;
      occurredAt?: number;
      dedupeId?: string;
    }
  | { kind: "missing"; sessionKey: string };

export type SessionCatalogContinueProviderResult = {
  sessionKey: string;
  /** Plugin binding installed for this authenticated Control UI session. */
  conversationBinding?: {
    summary?: string;
    detachHint?: string;
    data?: Record<string, unknown>;
  };
  /** Publishes provider state only after the requested binding is durable. */
  afterConversationBound?: () => Promise<void>;
  /** Upstream link seed so the monitor can detect direct external activity. */
  upstream?: {
    kind: SessionUpstreamKind;
    ref: SessionUpstreamJsonValue;
    marker: SessionUpstreamJsonValue;
  };
};

type SessionCatalogCreateParams = {
  /** Agent whose model/runtime policy must authorize the catalog target. */
  agentId?: string;
};

export type SessionCatalogProvider = {
  id: string;
  label: string;
  /** Resolves the current core new-session target for the requested agent. */
  resolveCreateSession?: (
    params: SessionCatalogCreateParams,
  ) => SessionCatalogCreateTarget | undefined;
  list: (params: SessionCatalogListProviderParams) => Promise<SessionCatalogHost[]>;
  read: (params: SessionCatalogReadProviderParams) => Promise<SessionsCatalogReadResult>;
  continueSession?: (
    params: SessionCatalogContinueProviderParams,
  ) => Promise<SessionCatalogContinueProviderResult>;
  checkUpstreamActivity?: (probes: SessionUpstreamProbe[]) => Promise<SessionUpstreamActivity[]>;
  archive?: (params: SessionCatalogArchiveProviderParams) => Promise<{ ok: true }>;
  openTerminal?: (request: {
    hostId: string;
    threadId: string;
  }) => Promise<SessionCatalogTerminalPlan>;
};
