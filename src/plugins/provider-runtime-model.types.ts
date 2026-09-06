// Defines runtime model metadata supplied by provider plugins.
import type { ModelCatalogContextWindowOption } from "@openclaw/model-catalog-core/model-catalog-types";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";
import type { ProviderThinkingProfile } from "./provider-thinking.types.js";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Omit<Model, "compat"> & {
  compat?: ModelCompatConfig;
  contextWindows?: ModelCatalogContextWindowOption[];
  contextWindowDefault?: string;
  contextTokens?: number;
  /** Host-resolved provenance for the top-level wire output cap. */
  maxTokensSource?: "configured" | "discovered";
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
  /** Provider/host-prepared tool discovery preference for this attempt; never persisted. */
  toolSearchMode?: "tools" | false;
  /** Provider-prepared default for embedded compaction; explicit compaction config wins. */
  compactionThinkingDefault?: NonNullable<ProviderThinkingProfile["defaultLevel"]>;
  mediaInput?: ModelMediaInputConfig;
};
