import {
  synthesizeVoiceModelCatalogEntries,
  type VoiceModelCapabilities,
  type VoiceModelProvider,
} from "../../packages/speech-core/voice-models.js";
import {
  synthesizeMediaGenerationCatalogEntries,
  type MediaGenerationCatalogKind,
  type MediaGenerationCatalogProvider,
} from "../media-generation/catalog.js";
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogSource,
} from "../model-catalog/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { uniqueValues } from "../shared/string-normalization.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { projectProviderCatalogResultToUnifiedTextRows } from "./provider-catalog-unified-text.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type {
  ProviderPlugin,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "./types.js";

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

  const registerSynthesizedVoiceModelCatalogProvider = (registration: {
    record: PluginRecord;
    provider: VoiceModelProvider;
    capabilities: VoiceModelCapabilities;
    modes?: readonly string[];
  }) => {
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: ["voice"],
      staticCatalog: () =>
        synthesizeVoiceModelCatalogEntries({
          provider: registration.provider,
          capabilities: registration.capabilities,
          modes: registration.modes,
        }),
    });
  };

  return {
    registerModelCatalogProvider,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
    registerSynthesizedVoiceModelCatalogProvider,
  };
}
