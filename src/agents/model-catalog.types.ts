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
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  compat?: ModelCompatConfig;
  mediaInput?: ModelMediaInputConfig;
};
