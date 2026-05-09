import type { ModelApi, ModelCompatConfig } from "../config/types.models.js";

export type ModelCatalogInput = "text" | "image" | "document";
export type ModelCatalogDiscovery = "static" | "refreshable" | "runtime";
export type ModelCatalogStatus = "available" | "preview" | "deprecated" | "disabled";
export type ModelCatalogSource =
  | "manifest"
  | "provider-index"
  | "cache"
  | "config"
  | "runtime-refresh";

export type UnifiedModelCatalogKind =
  | "text"
  | "image_generation"
  | "video_generation"
  | "music_generation";

export type UnifiedModelCatalogSource =
  | "manifest"
  | "provider-index"
  | "static"
  | "live"
  | "cache"
  | "configured"
  | "runtime-refresh";

export type UnifiedModelCatalogEntry<TCapabilities = unknown> = {
  kind: UnifiedModelCatalogKind;
  provider: string;
  model: string;
  label?: string;
  source: UnifiedModelCatalogSource;
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};

export type ModelCatalogTieredCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  range: [number, number] | [number];
};

export type ModelCatalogCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tieredPricing?: ModelCatalogTieredCost[];
};

export type ModelCatalogModel = {
  id: string;
  name?: string;
  api?: ModelApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  input?: ModelCatalogInput[];
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;
  compat?: ModelCompatConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};

export type ModelCatalogProvider = {
  baseUrl?: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  models: ModelCatalogModel[];
};

export type ModelCatalogAlias = {
  provider: string;
  api?: ModelApi;
  baseUrl?: string;
};

export type ModelCatalogSuppression = {
  provider: string;
  model: string;
  reason?: string;
  when?: {
    baseUrlHosts?: string[];
    providerConfigApiIn?: string[];
  };
};

export type ModelCatalog = {
  providers?: Record<string, ModelCatalogProvider>;
  aliases?: Record<string, ModelCatalogAlias>;
  suppressions?: ModelCatalogSuppression[];
  discovery?: Record<string, ModelCatalogDiscovery>;
};

export type NormalizedModelCatalogRow = {
  provider: string;
  id: string;
  ref: string;
  mergeKey: string;
  name: string;
  source: ModelCatalogSource;
  input: ModelCatalogInput[];
  reasoning: boolean;
  status: ModelCatalogStatus;
  api?: ModelApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;
  compat?: ModelCompatConfig;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};
