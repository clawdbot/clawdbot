export const MODEL_CATALOG_MIN_MODELS: 200;
export const OPENROUTER_MODELS_URL: "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICING_URL: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type ModelCatalogManifestInput = {
  pluginId: string;
  manifestPath: string;
  manifest: {
    modelCatalog?: {
      providers?: Record<string, unknown>;
    };
    modelPricing?: {
      providers?: Record<string, unknown>;
    };
  };
};

export type PublishModelCatalogArgs = {
  dryRun: boolean;
  pricing: boolean;
  out?: string;
};

export type ModelCatalogBundleSummary = {
  providers: number;
  models: number;
  costModels: number;
  pricingEntries: number;
};

export type PublishedModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  tieredPricing?: Array<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    range: [number] | [number, number];
  }>;
};

export type PublishedModelCatalogBundle = {
  schemaVersion: 1;
  generatedAt: number;
  minVersion?: string;
  sourceCommit: string;
  providers: Record<
    string,
    {
      models: Array<{ id: string; cost?: Record<string, unknown>; [key: string]: unknown }>;
      [key: string]: unknown;
    }
  >;
  pricing?: Record<string, PublishedModelPricing>;
};

export function parsePublishModelCatalogArgs(args: string[]): PublishModelCatalogArgs;
export function readModelCatalogManifests(options?: {
  rootDir?: string;
}): ModelCatalogManifestInput[];
export function assembleModelCatalogBundle(options: {
  manifests: ModelCatalogManifestInput[];
  generatedAt: number;
  sourceCommit: string;
  minVersion?: string;
  validateBundle?: (bundle: unknown) => PublishedModelCatalogBundle;
}): Promise<PublishedModelCatalogBundle>;
export function summarizeModelCatalogBundle(
  bundle: PublishedModelCatalogBundle,
): ModelCatalogBundleSummary;
export function enrichModelCatalogPricing(options: {
  bundle: PublishedModelCatalogBundle;
  manifests: ModelCatalogManifestInput[];
  fetchImpl?: typeof fetch;
  validateBundle?: (bundle: unknown) => PublishedModelCatalogBundle;
}): Promise<{ modelsEnriched: number; pricingEntries: number }>;
export function serializeModelCatalogBundle(bundle: PublishedModelCatalogBundle): string;
