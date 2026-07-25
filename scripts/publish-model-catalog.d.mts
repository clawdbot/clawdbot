export const MODEL_CATALOG_MIN_VERSION: "2026.7.0";
export const MODEL_CATALOG_MIN_MODELS: 200;
export const MODEL_CATALOG_R2_OBJECT_KEY: "models/v1/catalog.json";

export type ModelCatalogManifestInput = {
  pluginId: string;
  manifestPath: string;
  manifest: {
    modelCatalog?: {
      providers?: Record<string, unknown>;
    };
  };
};

export type PublishModelCatalogArgs = {
  dryRun: boolean;
  out?: string;
  bucket?: string;
};

export type ModelCatalogBundleSummary = {
  providers: number;
  models: number;
};

export type PublishedModelCatalogBundle = {
  schemaVersion: 1;
  generatedAt: number;
  minVersion?: string;
  sourceCommit: string;
  providers: Record<string, { models: unknown[]; [key: string]: unknown }>;
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
export function runPublishModelCatalog(options?: {
  args?: string[];
  rootDir?: string;
  now?: () => number;
  sourceCommit?: string;
  env?: NodeJS.ProcessEnv;
  spawnSyncImpl?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      encoding: string;
      env: NodeJS.ProcessEnv;
    },
  ) => { status: number | null; stdout?: string; stderr?: string };
}): Promise<{
  bundle: PublishedModelCatalogBundle;
  summary: ModelCatalogBundleSummary;
  wrote: boolean;
  uploaded: boolean;
}>;
