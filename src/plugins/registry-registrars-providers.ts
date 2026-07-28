import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getRegisteredAgentHarness,
  registerAgentHarness as registerGlobalAgentHarness,
} from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import {
  getRegisteredEmbeddingProvider,
  registerEmbeddingProvider as registerGlobalEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginTextTransformsRegistration } from "./registry-types.js";
import type {
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MigrationProviderPlugin,
  MusicGenerationProviderPlugin,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  TranscriptSourceProvider,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
  WorkerProvider,
} from "./types.js";
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
    registryParams,
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

  const registerAgentHarness = (record: PluginRecord, harness: AgentHarness) => {
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
    if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness "${id}" registration missing required runtime methods`,
      });
      return;
    }
    const existing =
      registryParams.activateGlobalSideEffects === false
        ? registry.agentHarnesses.find((entry) => entry.harness.id === id)
        : getRegisteredAgentHarness(id);
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
        message: `agent harness already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    const normalizedHarness = { ...harness, id, pluginId: harness.pluginId ?? record.id };
    if (registryParams.activateGlobalSideEffects !== false) {
      registerGlobalAgentHarness(normalizedHarness, { ownerPluginId: record.id });
    }
    record.agentHarnessIds.push(id);
    registry.agentHarnesses.push({
      pluginId: record.id,
      pluginName: record.name,
      harness: normalizedHarness,
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
    const existing =
      registryParams.activateGlobalSideEffects === false
        ? registry.embeddingProviders.find((entry) => entry.provider.id === id)
        : getRegisteredEmbeddingProvider(id);
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
    if (registryParams.activateGlobalSideEffects !== false) {
      registerGlobalEmbeddingProvider(adapter, { ownerPluginId: record.id });
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

  const registerUniqueProviderLike = <T extends { id: string }>(params: {
    record: PluginRecord;
    provider: T;
    kindLabel: string;
    registrations: Array<PluginOwnedProviderRegistration<T>>;
    ownedIds: string[];
  }): boolean => {
    const id = params.provider.id.trim();
    const { record, kindLabel } = params;
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `${kindLabel} registration missing id`,
      });
      return false;
    }
    const existing = params.registrations.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `${kindLabel} already registered: ${id} (${existing.pluginId})`,
      });
      return false;
    }
    if (!params.ownedIds.includes(id)) {
      params.ownedIds.push(id);
    }
    params.registrations.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: params.provider,
      source: record.source,
      rootDir: record.rootDir,
    });
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

  const registerSpeechProvider = (record: PluginRecord, provider: SpeechProviderPlugin) => {
    if (
      registerUniqueProviderLike({
        record,
        provider,
        kindLabel: "speech provider",
        registrations: registry.speechProviders,
        ownedIds: record.speechProviderIds,
      })
    ) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { tts: true },
        modes: ["tts"],
      });
    }
  };

  const registerRealtimeTranscriptionProvider = (
    record: PluginRecord,
    provider: RealtimeTranscriptionProviderPlugin,
  ) => {
    if (
      registerUniqueProviderLike({
        record,
        provider,
        kindLabel: "realtime transcription provider",
        registrations: registry.realtimeTranscriptionProviders,
        ownedIds: record.realtimeTranscriptionProviderIds,
      })
    ) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_transcription: true },
        modes: ["realtime_transcription"],
      });
    }
  };

  const registerRealtimeVoiceProvider = (
    record: PluginRecord,
    provider: RealtimeVoiceProviderPlugin,
  ) => {
    if (
      registerUniqueProviderLike({
        record,
        provider,
        kindLabel: "realtime voice provider",
        registrations: registry.realtimeVoiceProviders,
        ownedIds: record.realtimeVoiceProviderIds,
      })
    ) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_voice: true },
        modes: ["realtime_voice"],
      });
    }
  };

  const registerMediaUnderstandingProvider = (
    record: PluginRecord,
    provider: MediaUnderstandingProviderPlugin,
  ) =>
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "media provider",
      registrations: registry.mediaUnderstandingProviders,
      ownedIds: record.mediaUnderstandingProviderIds,
    });

  const registerTranscriptSourceProvider = (
    record: PluginRecord,
    provider: TranscriptSourceProvider,
  ) =>
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "transcripts source provider",
      registrations: registry.transcriptSourceProviders,
      ownedIds: record.transcriptSourceProviderIds,
    });

  const registerImageGenerationProvider = (
    record: PluginRecord,
    provider: ImageGenerationProviderPlugin,
  ) => {
    if (
      registerUniqueProviderLike({
        record,
        provider,
        kindLabel: "image-generation provider",
        registrations: registry.imageGenerationProviders,
        ownedIds: record.imageGenerationProviderIds,
      })
    ) {
      registerSynthesizedMediaModelCatalogProvider({ record, kind: "image_generation", provider });
    }
  };

  const registerVideoGenerationProvider = (
    record: PluginRecord,
    provider: VideoGenerationProviderPlugin,
  ) => {
    if (
      registerUniqueProviderLike({
        record,
        provider,
        kindLabel: "video-generation provider",
        registrations: registry.videoGenerationProviders,
        ownedIds: record.videoGenerationProviderIds,
      })
    ) {
      registerSynthesizedMediaModelCatalogProvider({ record, kind: "video_generation", provider });
    }
  };

  const registerMusicGenerationProvider = (
    record: PluginRecord,
    provider: MusicGenerationProviderPlugin,
  ) => {
    if (
      registerUniqueProviderLike({
        record,
        provider,
        kindLabel: "music-generation provider",
        registrations: registry.musicGenerationProviders,
        ownedIds: record.musicGenerationProviderIds,
      })
    ) {
      registerSynthesizedMediaModelCatalogProvider({ record, kind: "music_generation", provider });
    }
  };

  const registerWebFetchProvider = (record: PluginRecord, provider: WebFetchProviderPlugin) =>
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "web fetch provider",
      registrations: registry.webFetchProviders,
      ownedIds: record.webFetchProviderIds,
    });

  const registerWebSearchProvider = (record: PluginRecord, provider: WebSearchProviderPlugin) =>
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "web search provider",
      registrations: registry.webSearchProviders,
      ownedIds: record.webSearchProviderIds,
    });

  const registerMigrationProvider = (record: PluginRecord, provider: MigrationProviderPlugin) =>
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "migration provider",
      registrations: registry.migrationProviders,
      ownedIds: record.migrationProviderIds,
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
