// Registers plugin-provided models into the model catalog.
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogSource,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { uniqueValues } from "../../packages/normalization-core/src/string-normalization.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type { UnifiedModelCatalogProviderPlugin } from "./types.js";

type UnifiedModelCatalogHook = NonNullable<UnifiedModelCatalogProviderPlugin["staticCatalog"]>;

function mergeCatalogHookResults(
  source: UnifiedModelCatalogSource,
  left: readonly UnifiedModelCatalogEntry[] | null | undefined,
  right: readonly UnifiedModelCatalogEntry[] | null | undefined,
): readonly UnifiedModelCatalogEntry[] | null {
  const rows = [...(left ?? []), ...(right ?? [])];
  if (rows.length === 0) {
    return null;
  }
  const mergedRows: UnifiedModelCatalogEntry[] = [];
  for (const row of rows) {
    mergedRows.push({ ...row, source });
  }
  return mergedRows;
}

function mergeModelCatalogHooks(
  source: UnifiedModelCatalogSource,
  left: UnifiedModelCatalogHook | undefined,
  right: UnifiedModelCatalogHook | undefined,
): UnifiedModelCatalogHook | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return async (ctx) => {
    const [leftRows, rightRows] = await Promise.all([left(ctx), right(ctx)]);
    return mergeCatalogHookResults(source, leftRows, rightRows);
  };
}

/** Creates handlers that register plugin model catalog providers into a registry. */
export function createModelCatalogRegistrationHandlers(params: {
  registry: PluginRegistry;
  pushDiagnostic: (diagnostic: PluginDiagnostic) => void;
}) {
  const registerModelCatalogProvider = (
    record: PluginRecord,
    provider: UnifiedModelCatalogProviderPlugin,
  ) => {
    const providerId = normalizeOptionalString(provider.provider) ?? "";
    if (!providerId) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "model catalog provider registration missing provider",
      });
      return;
    }
    if (!provider.kinds || provider.kinds.length === 0) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration missing kinds`,
      });
      return;
    }
    const existing = params.registry.modelCatalogProviders.find(
      (entry) => entry.provider.provider === providerId && entry.pluginId !== record.id,
    );
    if (existing) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider already registered: ${providerId} (${existing.pluginId})`,
      });
      return;
    }
    const normalizedKinds = uniqueValues(provider.kinds);
    const samePluginOverlapping = params.registry.modelCatalogProviders.find(
      (entry) =>
        entry.provider.provider === providerId &&
        entry.pluginId === record.id &&
        entry.provider.kinds.some((kind) => normalizedKinds.includes(kind)),
    );
    if (samePluginOverlapping) {
      samePluginOverlapping.provider = {
        ...samePluginOverlapping.provider,
        ...provider,
        provider: providerId,
        kinds: uniqueValues([...samePluginOverlapping.provider.kinds, ...normalizedKinds]),
        staticCatalog: mergeModelCatalogHooks(
          "static",
          samePluginOverlapping.provider.staticCatalog,
          provider.staticCatalog,
        ),
        liveCatalog: mergeModelCatalogHooks(
          "live",
          samePluginOverlapping.provider.liveCatalog,
          provider.liveCatalog,
        ),
      };
      return;
    }
    params.registry.modelCatalogProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: {
        ...provider,
        provider: providerId,
        kinds: normalizedKinds,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  return {
    registerModelCatalogProvider,
  };
}
