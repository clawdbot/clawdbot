import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentHarness, AgentHarnessRegistrationOptions } from "../agents/harness/types.js";
import { getCoreEmbeddingProvider } from "./core-embedding-providers.js";
import type { EmbeddingProviderAdapter } from "./embedding-providers.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import { canClaimReservedCommandOwnership } from "./registry-registrars-operations.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginTextTransformsRegistration } from "./registry-types.js";
import type { CliBackendPlugin, ProviderPlugin, WorkerProvider } from "./types.js";
import { validateWorkerProviderContract } from "./worker-provider-registry.js";

type PluginOwnedProviderRegistration<T extends { id: string }> = {
  pluginId: string;
  pluginName?: string;
  provider: T;
  source: string;
  rootDir?: string;
};

export function createProviderRegistrars(state: PluginRegistryState) {
  const {
    registry,
    pushDiagnostic,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
    registerSynthesizedVoiceModelCatalogProvider,
  } = state;

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const normalizedProvider = normalizeRegisteredProvider({
      pluginId: record.id,
      source: record.source,
      provider,
      pushDiagnostic,
    });
    if (!normalizedProvider) {
      return;
    }
    const id = normalizedProvider.id;
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `provider already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    if (!record.providerIds.includes(id)) {
      record.providerIds.push(id);
    }
    registry.providers.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: normalizedProvider,
      source: record.source,
      rootDir: record.rootDir,
    });
    registerSynthesizedTextModelCatalogProvider({ record, provider: normalizedProvider });
  };

  const registerAgentHarness = (
    record: PluginRecord,
    harness: AgentHarness,
    options?: AgentHarnessRegistrationOptions,
  ) => {
    const id = normalizeOptionalString((harness as Partial<AgentHarness> | undefined)?.id) ?? "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent harness registration missing id",
      });
      return;
    }
    if (id === "openclaw") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: 'agent harness id "openclaw" is reserved for the built-in runtime',
      });
      return;
    }
    if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness "${id}" registration missing required runtime methods`,
      });
      return;
    }
    if (
      options?.nativeCompaction &&
      (!canClaimReservedCommandOwnership(record) ||
        id !== "codex" ||
        typeof options.nativeCompaction !== "function")
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: 'native compaction requires the registry-owned "codex" harness',
      });
      return;
    }
    const existing = registry.agentHarnesses.find((entry) => entry.harness.id === id);
    if (existing) {
      const ownerPluginId = "pluginId" in existing ? existing.pluginId : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    const normalizedHarness = { ...harness, id, pluginId: harness.pluginId ?? record.id };
    record.agentHarnessIds.push(id);
    registry.agentHarnesses.push({
      pluginId: record.id,
      pluginName: record.name,
      harness: normalizedHarness,
      ...(options?.nativeCompaction ? { nativeCompaction: options.nativeCompaction } : {}),
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCliBackend = (record: PluginRecord, backend: CliBackendPlugin) => {
    const id = backend.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli backend registration missing id",
      });
      return;
    }
    const existing = registry.cliBackends.find((entry) => entry.backend.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli backend already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    registry.cliBackends.push({
      pluginId: record.id,
      pluginName: record.name,
      builtWithOpenClawVersion: record.builtWithOpenClawVersion,
      backend: { ...backend, id },
      source: record.source,
      rootDir: record.rootDir,
    });
    record.cliBackendIds.push(id);
  };

  const registerTextTransforms = (
    record: PluginRecord,
    transforms: PluginTextTransformsRegistration["transforms"],
  ) => {
    if (
      (!transforms.input || transforms.input.length === 0) &&
      (!transforms.output || transforms.output.length === 0)
    ) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "text transform registration has no input or output replacements",
      });
      return;
    }
    registry.textTransforms.push({
      pluginId: record.id,
      pluginName: record.name,
      transforms,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerEmbeddingProvider = (record: PluginRecord, adapter: EmbeddingProviderAdapter) => {
    const id = adapter.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "embedding provider registration missing id",
      });
      return;
    }
    if (!(record.contracts?.embeddingProviders ?? []).includes(id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.embeddingProviders for adapter: ${id}`,
      });
      return;
    }
    const coreEntry = getCoreEmbeddingProvider(id);
    const existing =
      coreEntry ?? registry.embeddingProviders.find((entry) => entry.provider.id === id);
    if (existing) {
      const ownerPluginId =
        "ownerPluginId" in existing
          ? existing.ownerPluginId
          : "pluginId" in existing
            ? existing.pluginId
            : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `embedding provider already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    registry.embeddingProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: adapter,
      source: record.source,
      rootDir: record.rootDir,
    });
    if (!record.embeddingProviderIds.includes(id)) {
      record.embeddingProviderIds.push(id);
    }
  };

  const createProviderLikeRegistrar =
    <T extends { id: string }>(params: {
      kindLabel: string;
      registrations: Array<PluginOwnedProviderRegistration<T>>;
      ownedIds: (record: PluginRecord) => string[];
      onRegister?: (record: PluginRecord, provider: T) => void;
    }) =>
    (record: PluginRecord, provider: T): boolean | void => {
      const id = provider.id.trim();
      const { kindLabel } = params;
      if (!id) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `${kindLabel} registration missing id`,
        });
        return params.onRegister ? undefined : false;
      }
      const existing = params.registrations.find((entry) => entry.provider.id === id);
      if (existing) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `${kindLabel} already registered: ${id} (${existing.pluginId})`,
        });
        return params.onRegister ? undefined : false;
      }
      const ownedIds = params.ownedIds(record);
      if (!ownedIds.includes(id)) {
        ownedIds.push(id);
      }
      params.registrations.push({
        pluginId: record.id,
        pluginName: record.name,
        provider,
        source: record.source,
        rootDir: record.rootDir,
      });
      if (params.onRegister) {
        params.onRegister(record, provider);
        return;
      }
      return true;
    };

  const registerWorkerProvider = (record: PluginRecord, provider: WorkerProvider) => {
    const reject = (message: string) =>
      pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
    const validation = validateWorkerProviderContract(
      provider,
      record.contracts?.workerProviders ?? [],
    );
    if (!validation.ok) {
      reject(validation.message);
      return;
    }
    const { id } = validation;
    const existing = registry.workerProviders.get(id);
    if (existing) {
      reject(`worker provider already registered: ${id} (${existing.pluginId})`);
      return;
    }
    registry.workerProviders.set(id, {
      pluginId: record.id,
      pluginName: record.name,
      provider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSpeechProvider = createProviderLikeRegistrar({
    kindLabel: "speech provider",
    registrations: registry.speechProviders,
    ownedIds: (record) => record.speechProviderIds,
    onRegister: (record, provider) =>
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { tts: true },
        modes: ["tts"],
      }),
  });

  const registerRealtimeTranscriptionProvider = createProviderLikeRegistrar({
    kindLabel: "realtime transcription provider",
    registrations: registry.realtimeTranscriptionProviders,
    ownedIds: (record) => record.realtimeTranscriptionProviderIds,
    onRegister: (record, provider) =>
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_transcription: true },
        modes: ["realtime_transcription"],
      }),
  });

  const registerRealtimeVoiceProvider = createProviderLikeRegistrar({
    kindLabel: "realtime voice provider",
    registrations: registry.realtimeVoiceProviders,
    ownedIds: (record) => record.realtimeVoiceProviderIds,
    onRegister: (record, provider) =>
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_voice: true },
        modes: ["realtime_voice"],
      }),
  });

  const registerMediaUnderstandingProvider = createProviderLikeRegistrar({
    kindLabel: "media provider",
    registrations: registry.mediaUnderstandingProviders,
    ownedIds: (record) => record.mediaUnderstandingProviderIds,
  });

  const registerTranscriptSourceProvider = createProviderLikeRegistrar({
    kindLabel: "transcripts source provider",
    registrations: registry.transcriptSourceProviders,
    ownedIds: (record) => record.transcriptSourceProviderIds,
  });

  const registerImageGenerationProvider = createProviderLikeRegistrar({
    kindLabel: "image-generation provider",
    registrations: registry.imageGenerationProviders,
    ownedIds: (record) => record.imageGenerationProviderIds,
    onRegister: (record, provider) =>
      registerSynthesizedMediaModelCatalogProvider({ record, kind: "image_generation", provider }),
  });

  const registerVideoGenerationProvider = createProviderLikeRegistrar({
    kindLabel: "video-generation provider",
    registrations: registry.videoGenerationProviders,
    ownedIds: (record) => record.videoGenerationProviderIds,
    onRegister: (record, provider) =>
      registerSynthesizedMediaModelCatalogProvider({ record, kind: "video_generation", provider }),
  });

  const registerMusicGenerationProvider = createProviderLikeRegistrar({
    kindLabel: "music-generation provider",
    registrations: registry.musicGenerationProviders,
    ownedIds: (record) => record.musicGenerationProviderIds,
    onRegister: (record, provider) =>
      registerSynthesizedMediaModelCatalogProvider({ record, kind: "music_generation", provider }),
  });

  const registerWebFetchProvider = createProviderLikeRegistrar({
    kindLabel: "web fetch provider",
    registrations: registry.webFetchProviders,
    ownedIds: (record) => record.webFetchProviderIds,
  });

  const registerWebSearchProvider = createProviderLikeRegistrar({
    kindLabel: "web search provider",
    registrations: registry.webSearchProviders,
    ownedIds: (record) => record.webSearchProviderIds,
  });

  const registerMigrationProvider = createProviderLikeRegistrar({
    kindLabel: "migration provider",
    registrations: registry.migrationProviders,
    ownedIds: (record) => record.migrationProviderIds,
  });

  return {
    registerProvider,
    registerAgentHarness,
    registerCliBackend,
    registerTextTransforms,
    registerEmbeddingProvider,
    registerWorkerProvider,
    registerSpeechProvider,
    registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider,
    registerMediaUnderstandingProvider,
    registerTranscriptSourceProvider,
    registerImageGenerationProvider,
    registerVideoGenerationProvider,
    registerMusicGenerationProvider,
    registerWebFetchProvider,
    registerWebSearchProvider,
    registerMigrationProvider,
  };
}
