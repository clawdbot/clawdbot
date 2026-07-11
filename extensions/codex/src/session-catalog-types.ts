/** Read-only metadata for one Codex app-server thread. */
export type CodexSessionCatalogSession = {
  threadId: string;
  sessionId?: string;
  name?: string | null;
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
  openClawSessionKey?: string;
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
  sessions: CodexSessionCatalogSession[];
  nextCursor?: string;
  backwardsCursor?: string;
  error?: CodexSessionCatalogError;
};

export type CodexSessionCatalogResult = {
  hosts: CodexSessionCatalogHost[];
};

export type CodexSessionCatalogParams = {
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
};
