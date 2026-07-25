import type {
  CodexThread,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
} from "./app-server/protocol.js";

/** Read-only metadata for one Codex app-server thread. */
export type CodexSessionCatalogSession = {
  threadId: string;
  sessionId?: string;
  name?: string | null;
  /** Display-only fallback kept separate so title search never scans prompt previews. */
  fallbackName?: string;
  cwd?: string;
  status: string;
  activeFlags?: string[];
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  source?: string;
  modelProvider?: string;
  cliVersion?: string;
  gitBranch?: string;
  /** Existing locked OpenClaw chat already mapped to this native source thread. */
  sessionKey?: string;
  archived: boolean;
};

export type CodexSessionCatalogPage = {
  sessions: CodexSessionCatalogSession[];
  nextCursor?: string;
  backwardsCursor?: string;
};

export type CodexSessionCatalogPageParams = {
  cursor?: string;
  limit?: number;
  searchTerm?: string;
  cwd?: string;
};

export type CodexSessionCatalogControl = {
  clientId?: string;
  connectionFingerprint?: string;
  withPinnedConnection<T>(run: (control: CodexSessionCatalogControl) => Promise<T>): Promise<T>;
  listPage(params: CodexSessionCatalogPageParams): Promise<CodexSessionCatalogPage>;
  listDescendantPage(params: CodexThreadListParams): Promise<CodexThreadListResponse>;
  listTurnPage(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThread>;
  archiveThread(threadId: string): Promise<void>;
};

export type CodexSessionCatalogError = {
  code: string;
  message: string;
};

export type CodexSessionCatalogHost = {
  hostId: string;
  label: string;
  kind: "gateway" | "node";
  connected: boolean;
  nodeId?: string;
  canContinueCodex?: boolean;
  canOpenTerminalCodex?: boolean;
  sessions: CodexSessionCatalogSession[];
  nextCursor?: string;
  backwardsCursor?: string;
  error?: CodexSessionCatalogError;
};

export type CodexSessionCatalogResult = {
  hosts: CodexSessionCatalogHost[];
};

export type CodexSessionTranscriptPage = {
  hostId: string;
  label: string;
  threadId: string;
  items: import("./app-server/protocol.js").CodexThreadItem[];
  nextCursor?: string;
  backwardsCursor?: string;
};

export type CodexSessionCatalogParams = {
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
};
