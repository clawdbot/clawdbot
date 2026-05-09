import {
  synthesizeMediaGenerationCatalogEntries,
  type MediaGenerationCatalogKind,
  type MediaGenerationCatalogProvider,
} from "../media-generation/catalog.js";
import type { UnifiedModelCatalogEntry } from "../model-catalog/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type {
  ProviderCatalogResult,
  ProviderPlugin,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "./types.js";

function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  if (!params.result) {
    return [];
  }
  const providers =
    "provider" in params.result
      ? { [params.providerId]: params.result.provider }
      : params.result.providers;
  const rows: UnifiedModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    for (const model of providerConfig.models ?? []) {
      rows.push({
        kind: "text",
        provider: providerId,
        model: model.id,
        ...(model.name ? { label: model.name } : {}),
        source: params.source,
      });
    }
  }
  return rows;
}

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
    const normalizedKinds = [...new Set(provider.kinds)];
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
        kinds: [...new Set([...samePluginOverlapping.provider.kinds, ...normalizedKinds])],
        staticCatalog: provider.staticCatalog ?? samePluginOverlapping.provider.staticCatalog,
        liveCatalog: provider.liveCatalog ?? samePluginOverlapping.provider.liveCatalog,
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

  const registerSynthesizedTextModelCatalogProvider = (registration: {
    record: PluginRecord;
    provider: ProviderPlugin;
  }) => {
    if (!registration.provider.catalog && !registration.provider.staticCatalog) {
      return;
    }
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: ["text"],
      ...(registration.provider.staticCatalog
        ? {
            staticCatalog: async (ctx: UnifiedModelCatalogProviderContext) =>
              projectProviderCatalogResultToUnifiedTextRows({
                providerId: registration.provider.id,
                result: await registration.provider.staticCatalog!.run(ctx),
                source: "static",
              }),
          }
        : {}),
      ...(registration.provider.catalog
        ? {
            liveCatalog: async (ctx: UnifiedModelCatalogProviderContext) =>
              projectProviderCatalogResultToUnifiedTextRows({
                providerId: registration.provider.id,
                result: await registration.provider.catalog!.run(ctx),
                source: "live",
              }),
          }
        : {}),
    });
  };

  const registerSynthesizedMediaModelCatalogProvider = <TCapabilities>(registration: {
    record: PluginRecord;
    kind: MediaGenerationCatalogKind;
    provider: MediaGenerationCatalogProvider<TCapabilities>;
  }) => {
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: [registration.kind],
      staticCatalog: () =>
        synthesizeMediaGenerationCatalogEntries({
          kind: registration.kind,
          provider: registration.provider,
        }),
    });
  };

  return {
    registerModelCatalogProvider,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
  };
}
