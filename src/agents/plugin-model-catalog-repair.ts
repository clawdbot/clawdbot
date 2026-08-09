/** Pure repair rules for OpenClaw-generated plugin model catalogs. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const PLUGIN_MODEL_CATALOG_GENERATED_BY = "openclaw-plugin-model-catalog-v1";
export const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

type PluginModelCatalogRepair = {
  contents: string;
  removedModelCount: number;
};

function hasCatalogApi(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

export function isGeneratedPluginModelCatalog(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY;
}

/** Recognizes canonical catalogs and recoverable atomic Doctor migration claims. */
export function isPluginModelCatalogMigrationFile(filename: string): boolean {
  return (
    filename === PLUGIN_MODEL_CATALOG_FILE ||
    filename.startsWith(`${PLUGIN_MODEL_CATALOG_FILE}.doctor-importing-`)
  );
}

/** Decodes the plugin id from a canonical generated catalog path. */
export function decodePluginModelCatalogRelativePathPluginId(
  relativePath: string,
): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  if (
    path.isAbsolute(relativePath) ||
    parts.length !== 3 ||
    parts[0] !== "plugins" ||
    !parts[1] ||
    parts[1] === "." ||
    parts[1] === ".." ||
    parts[2] !== PLUGIN_MODEL_CATALOG_FILE
  ) {
    return undefined;
  }
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return undefined;
  }
}

/** Removes model rows whose transport API cannot be derived without inventing semantics. */
export function repairPluginModelCatalogTransportMetadata(
  contents: string,
): PluginModelCatalogRepair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { contents, removedModelCount: 0 };
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed.providers)) {
    return { contents, removedModelCount: 0 };
  }

  let removedModelCount = 0;
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models) || hasCatalogApi(provider.api)) {
      providers[providerId] = provider;
      continue;
    }
    const models = provider.models.filter((model) => isRecord(model) && hasCatalogApi(model.api));
    removedModelCount += provider.models.length - models.length;
    providers[providerId] =
      models.length === provider.models.length ? provider : { ...provider, models };
  }
  if (removedModelCount === 0) {
    return { contents, removedModelCount };
  }
  const trailingNewline = contents.endsWith("\n") ? "\n" : "";
  return {
    contents: `${JSON.stringify({ ...parsed, providers }, null, 2)}${trailingNewline}`,
    removedModelCount,
  };
}
