import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";

// Public catalog row shape shared by browse/search/provider-auth code. Keep this
// narrow: fields here are the stable model facts consumers can render or filter.
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
