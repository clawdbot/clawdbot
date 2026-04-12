import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Model<Api> & {
  contextTokens?: number;
};
