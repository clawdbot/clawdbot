import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelCompatConfig } from "../config/types.models.js";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Omit<Model<Api>, "compat"> & {
  compat?: ModelCompatConfig;
  contextTokens?: number;
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
};
