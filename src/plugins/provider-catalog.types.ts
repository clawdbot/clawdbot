import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
} from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ProviderCatalogOrder = "simple" | "profile" | "paired" | "late";

export type ProviderCatalogContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: (
    providerId?: string,
    options?: {
      oauthMarker?: string;
    },
  ) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  };
};

export type ProviderCatalogResult =
  | { provider: ModelProviderConfig }
  | { providers: Record<string, ModelProviderConfig> }
  | null
  | undefined;

export type ProviderPluginCatalog = {
  order?: ProviderCatalogOrder;
  run: (ctx: ProviderCatalogContext) => Promise<ProviderCatalogResult>;
};

export type UnifiedModelCatalogProviderContext = ProviderCatalogContext & {
  signal?: AbortSignal;
  includeLive?: boolean;
  timeoutMs?: number;
};

export type UnifiedModelCatalogProviderPlugin = {
  provider: string;
  kinds: readonly UnifiedModelCatalogKind[];
  staticCatalog?: (
    ctx: UnifiedModelCatalogProviderContext,
  ) =>
    | readonly UnifiedModelCatalogEntry[]
    | Promise<readonly UnifiedModelCatalogEntry[] | null | undefined>
    | null
    | undefined;
  liveCatalog?: (
    ctx: UnifiedModelCatalogProviderContext,
  ) =>
    | readonly UnifiedModelCatalogEntry[]
    | Promise<readonly UnifiedModelCatalogEntry[] | null | undefined>
    | null
    | undefined;
};

/**
 * Built-in model suppression hook context.
 *
 * @deprecated Use manifest `modelCatalog.suppressions`. Runtime suppression
 * hooks are no longer called by model resolution.
 */
export type ProviderBuiltInModelSuppressionContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};

export type ProviderBuiltInModelSuppressionResult = {
  suppress: boolean;
  errorMessage?: string;
};

/**
 * Provider-owned "modern model" policy input.
 *
 * Live smoke/model-profile selection uses this to keep provider-specific
 * inclusion/exclusion rules out of core.
 */
export type ProviderModernModelPolicyContext = {
  provider: string;
  modelId: string;
};

/**
 * Final catalog augmentation hook.
 *
 * Runs after OpenClaw loads the discovered model catalog and merges configured
 * opt-in providers. Use this for forward-compat rows or vendor-owned synthetic
 * entries that should appear in `models list` and model pickers even when the
 * upstream registry has not caught up yet.
 */
export type ProviderAugmentModelCatalogContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey?: ProviderCatalogContext["resolveProviderApiKey"];
  entries: ModelCatalogEntry[];
};

/**
 * @deprecated Use ProviderCatalogOrder.
 */
export type ProviderDiscoveryOrder = ProviderCatalogOrder;

/**
 * @deprecated Use ProviderCatalogContext.
 */
export type ProviderDiscoveryContext = ProviderCatalogContext;

/**
 * @deprecated Use ProviderCatalogResult.
 */
export type ProviderDiscoveryResult = ProviderCatalogResult;

/**
 * @deprecated Use ProviderPluginCatalog.
 */
export type ProviderPluginDiscovery = ProviderPluginCatalog;
