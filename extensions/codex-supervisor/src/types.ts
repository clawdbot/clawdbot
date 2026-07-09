/**
 * Public Codex Supervisor endpoint, session, and JSON-RPC connection types.
 */
/** Configured transport target for a Codex app-server endpoint. */
export type CodexSupervisorEndpoint =
  | {
      id: string;
      label?: string;
      transport: "stdio-proxy";
      command?: string;
      args?: string[];
      cwd?: string;
    }
  | {
      id: string;
      label?: string;
      transport: "websocket";
      url: string;
      authTokenEnv?: string;
    };

/** Send behavior requested by supervisor write tools. */
export type CodexSupervisorTurnMode = "auto" | "start" | "steer";

/** App-server thread status string, preserved for forward compatibility. */
export type CodexSupervisorThreadStatus = string;

/** Normalized session summary returned by supervisor list operations. */
export type CodexSupervisorSession = {
  endpointId: string;
  threadId: string;
  sessionId?: string;
  cwd?: string;
  preview?: string;
  name?: string | null;
  source?: string;
  status: CodexSupervisorThreadStatus;
  updatedAt?: number;
  humanAttached?: boolean;
};

/** Result returned after starting or steering a Codex turn. */
export type CodexSupervisorSendResult = {
  endpointId: string;
  threadId: string;
  mode: "start" | "steer";
  turnId?: string;
  status?: string;
};

/** Minimal JSON-RPC connection contract used by the supervisor. */
export type CodexJsonRpcConnection = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
};

/** Health result for one configured supervisor endpoint. */
export type CodexSupervisorEndpointHealth = {
  endpointId: string;
  ok: boolean;
  detail?: string;
};

/** Session list plus endpoint errors for tool-friendly structured output. */
export type CodexSupervisorSessionListResult = {
  sessions: CodexSupervisorSession[];
  errors: CodexSupervisorEndpointHealth[];
};

/** Read-only metadata for one Codex app-server thread. */
export type CodexSessionCatalogSession = {
  threadId: string;
  sessionId?: string;
  name?: string | null;
  cwd?: string;
  status: CodexSupervisorThreadStatus;
  activeFlags?: string[];
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  source?: string;
  modelProvider?: string;
  cliVersion?: string;
  gitBranch?: string;
  archived: boolean;
};

/** One page returned by a node-local Codex app-server catalog command. */
export type CodexSessionCatalogPage = {
  sessions: CodexSessionCatalogSession[];
  nextCursor?: string;
  backwardsCursor?: string;
};

/** Parameters accepted by the node-local Codex app-server catalog command. */
export type CodexSessionCatalogPageParams = {
  cursor?: string;
  limit?: number;
  archived?: boolean;
  searchTerm?: string;
  cwd?: string;
};

/** Per-origin error exposed by the read-only session catalog. */
export type CodexSessionCatalogError = {
  code: string;
  message: string;
};

/** Gateway-local or paired-node session catalog origin. */
export type CodexSessionCatalogHost = {
  hostId: string;
  label: string;
  kind: "gateway" | "node";
  connected: boolean;
  nodeId?: string;
  endpointId?: string;
  sessions: CodexSessionCatalogSession[];
  nextCursor?: string;
  backwardsCursor?: string;
  error?: CodexSessionCatalogError;
};

/** Host-grouped result returned by the Gateway session catalog method. */
export type CodexSessionCatalogResult = {
  hosts: CodexSessionCatalogHost[];
};

/** Parameters accepted by the Gateway session catalog method. */
export type CodexSessionCatalogParams = {
  search?: string;
  archived?: boolean;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
};
