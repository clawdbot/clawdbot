/**
 * Shared model catalog row types.
 * Used by discovery, browsing, visibility, and provider-auth code so renderers
 * and filters agree on stable model metadata.
 */
import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";

/** Input modalities a catalog entry can advertise. */
export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

/** Normalized model metadata exposed by the agent model catalog. */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  api?: ModelApi;
  /** Private transport provenance for route matching; never project directly to clients. */
  baseUrl?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  params?: Record<string, unknown>;
  compat?: ModelCompatConfig;
  mediaInput?: ModelMediaInputConfig;
};

/** Logical catalog rows plus the physical variants used for route selection. */
export type ModelCatalogSnapshot = {
  entries: ModelCatalogEntry[];
  routeVariants: ModelCatalogEntry[];
};
