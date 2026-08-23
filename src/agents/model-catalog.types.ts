/**
 * Shared model catalog row types.
 * Used by discovery, browsing, visibility, and provider-auth code so renderers
 * and filters agree on stable model metadata.
 */
import type { ModelCatalogStatus } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";

/** Input modalities a catalog entry can advertise. */
export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

type ModelContextWindowOption = {
  id: string;
  label: string;
  contextWindow: number;
};

/** Normalized model metadata exposed by the agent model catalog. */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  /** Provider-owned strongest-first picker order; internal and never projected to clients. */
  providerOrder?: number;
  alias?: string;
  api?: ModelApi;
  /** Private transport provenance for route matching; never project directly to clients. */
  baseUrl?: string;
  contextWindow?: number;
  contextWindows?: ModelContextWindowOption[];
  contextWindowDefault?: string;
  contextTokens?: number;
  reasoning?: boolean;
  /** Config-authored reasoning override; internal provenance, never project to clients. */
  configuredReasoning?: boolean;
  /** Concrete runtime owner of thinking policy; internal and never project to clients. */
  thinkingPolicyProvider?: string;
  input?: ModelInputType[];
  params?: Record<string, unknown>;
  compat?: ModelCompatConfig;
  mediaInput?: ModelMediaInputConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
};

/** Logical catalog rows plus the physical variants used for route selection. */
export type ModelCatalogSnapshot = {
  entries: ModelCatalogEntry[];
  routeVariants: ModelCatalogEntry[];
  /** Provider-owned outcome of each live catalog request in this generation. */
  providerOutcomes?: readonly ProviderCatalogOutcome[];
  /** Static provider-hook rows captured alongside the full lifecycle generation. */
  staticEntries?: ModelCatalogEntry[];
  /**
   * `false` only when this snapshot came from a degraded load (discovery threw,
   * static or empty fallback). Absent/`true` means authoritative — consumers that
   * destroy durable state (e.g. resetting a pinned model override) must treat only
   * an explicit `false` as degraded, so unrelated hand-built snapshots stay safe.
   */
  authoritative?: boolean;
};
