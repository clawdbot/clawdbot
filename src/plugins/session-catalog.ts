import type {
  SessionCatalogHost,
  SessionsCatalogArchiveParams,
  SessionsCatalogContinueParams,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";

export type SessionCatalogListProviderParams = {
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
};
export type SessionCatalogReadProviderParams = Omit<SessionsCatalogReadParams, "catalogId">;
export type SessionCatalogContinueProviderParams = Omit<SessionsCatalogContinueParams, "catalogId">;
export type SessionCatalogArchiveProviderParams = Omit<SessionsCatalogArchiveParams, "catalogId">;

export type SessionCatalogCreateTarget = {
  model: string;
  /** Concrete runtime pinned onto the created session so config reloads cannot retarget it. */
  agentRuntime: string;
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
  ) => Promise<{ sessionKey: string }>;
  archive?: (params: SessionCatalogArchiveProviderParams) => Promise<{ ok: true }>;
};
