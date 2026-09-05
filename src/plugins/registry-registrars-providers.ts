import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentHarness, AgentHarnessRegistrationOptions } from "../agents/harness/types.js";
import { getCoreEmbeddingProvider } from "./core-embedding-providers.js";
import type { EmbeddingProviderAdapter } from "./embedding-providers.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import { canClaimReservedCommandOwnership } from "./registry-registrars-operations.js";
import type { PluginRegistryState } from "./registry-state.js";
import type {
  PluginOwnedProviderRegistration,
  PluginRecord,
  PluginTextTransformsRegistration,
} from "./registry-types.js";
import type { CliBackendPlugin, ProviderPlugin, WorkerProvider } from "./types.js";
import { validateWorkerProviderContract } from "./worker-provider-registry.js";

export function createProviderRegistrars(state: PluginRegistryState) {
  const {
    registry,
    createRegistration,
    pushDiagnostic,
    reportRegistrationError,
    reportRegistrationWarning,
    registerModelCatalogProvider,
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
      reportRegistrationError(record, `provider already registered: ${id} (${existing.pluginId})`);
      return;
    }
    if (!record.providerIds.includes(id)) {
      record.providerIds.push(id);
    }
    registry.providers.push(
      createRegistration(record, {
        provider: normalizedProvider,
      }),
    );
    // Reserve catalog ownership without duplicating the discovery-owned model row builders.
    if (normalizedProvider.catalog || normalizedProvider.staticCatalog) {
      registerModelCatalogProvider(record, {
        provider: normalizedProvider.id,
        kinds: ["text"],
      });
    }
  };

  const registerAgentHarness = (
    record: PluginRecord,
    harness: AgentHarness,
    options?: AgentHarnessRegistrationOptions,
  ) => {
    const id = normalizeOptionalString((harness as Partial<AgentHarness> | undefined)?.id) ?? "";
    if (!id) {
      reportRegistrationError(record, "agent harness registration missing id");
      return;
    }
    if (id === "openclaw") {
      reportRegistrationError(
        record,
        'agent harness id "openclaw" is reserved for the built-in runtime',
      );
      return;
    }
    if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
      reportRegistrationError(
        record,
        `agent harness "${id}" registration missing required runtime methods`,
      );
      return;
    }
    if (
      options?.nativeCompaction &&
      (!canClaimReservedCommandOwnership(record) ||
        id !== "codex" ||
        typeof options.nativeCompaction !== "function")
    ) {
      reportRegistrationError(
        record,
        'native compaction requires the registry-owned "codex" harness',
      );
      return;
    }
    const existing = registry.agentHarnesses.find((entry) => entry.harness.id === id);
    if (existing) {
      const ownerPluginId = "pluginId" in existing ? existing.pluginId : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      reportRegistrationError(record, `agent harness already registered: ${id}${ownerDetail}`);
      return;
    }
    const normalizedHarness = { ...harness, id, pluginId: harness.pluginId ?? record.id };
    record.agentHarnessIds.push(id);
    registry.agentHarnesses.push(
      createRegistration(record, {
        harness: normalizedHarness,
        ...(options?.nativeCompaction ? { nativeCompaction: options.nativeCompaction } : {}),
      }),
    );
  };

  const registerCliBackend = (record: PluginRecord, backend: CliBackendPlugin) => {
    const id = backend.id.trim();
    if (!id) {
      reportRegistrationError(record, "cli backend registration missing id");
      return;
    }
    const existing = registry.cliBackends.find((entry) => entry.backend.id === id);
    if (existing) {
      reportRegistrationError(
        record,
        `cli backend already registered: ${id} (${existing.pluginId})`,
      );
      return;
    }
    registry.cliBackends.push(
      createRegistration(record, {
        builtWithOpenClawVersion: record.builtWithOpenClawVersion,
        backend: { ...backend, id },
      }),
    );
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
      reportRegistrationWarning(
        record,
        "text transform registration has no input or output replacements",
      );
      return;
    }
    registry.textTransforms.push(
      createRegistration(record, {
        transforms,
      }),
    );
  };

  const registerEmbeddingProvider = (record: PluginRecord, adapter: EmbeddingProviderAdapter) => {
    const id = adapter.id.trim();
    if (!id) {
      reportRegistrationError(record, "embedding provider registration missing id");
      return;
    }
    if (!(record.contracts?.embeddingProviders ?? []).includes(id)) {
      reportRegistrationError(
        record,
        `plugin must declare contracts.embeddingProviders for adapter: ${id}`,
      );
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
      reportRegistrationError(record, `embedding provider already registered: ${id}${ownerDetail}`);
      return;
    }
    registry.embeddingProviders.push(
      createRegistration(record, {
        provider: adapter,
      }),
    );
    if (!record.embeddingProviderIds.includes(id)) {
      record.embeddingProviderIds.push(id);
    }
  };

  const createProviderLikeRegistrar =
    <T extends { id: string }>(params: {
      kindLabel: string;
      registrations: Array<PluginOwnedProviderRegistration<T>>;
      ownedIds: (record: PluginRecord) => string[];
      catalogKinds?: Parameters<typeof registerModelCatalogProvider>[1]["kinds"];
    }) =>
    (record: PluginRecord, provider: T): boolean | void => {
      const id = provider.id.trim();
      const { kindLabel } = params;
      if (!id) {
        reportRegistrationError(record, `${kindLabel} registration missing id`);
        return params.catalogKinds ? undefined : false;
      }
      const existing = params.registrations.find((entry) => entry.provider.id === id);
      if (existing) {
        reportRegistrationError(
          record,
          `${kindLabel} already registered: ${id} (${existing.pluginId})`,
        );
        return params.catalogKinds ? undefined : false;
      }
      const ownedIds = params.ownedIds(record);
      if (!ownedIds.includes(id)) {
        ownedIds.push(id);
      }
      params.registrations.push(
        createRegistration(record, {
          provider,
        }),
      );
      if (params.catalogKinds) {
        registerModelCatalogProvider(record, { provider: provider.id, kinds: params.catalogKinds });
        return;
      }
      return true;
    };

  const registerWorkerProvider = (record: PluginRecord, provider: WorkerProvider) => {
    const reject = (message: string) => reportRegistrationError(record, message);
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
    registry.workerProviders.set(
      id,
      createRegistration(record, {
        provider,
      }),
    );
  };

  const registerSpeechProvider = createProviderLikeRegistrar({
    kindLabel: "speech provider",
    registrations: registry.speechProviders,
    ownedIds: (record) => record.speechProviderIds,
    catalogKinds: ["voice"],
  });

  const registerRealtimeTranscriptionProvider = createProviderLikeRegistrar({
    kindLabel: "realtime transcription provider",
    registrations: registry.realtimeTranscriptionProviders,
    ownedIds: (record) => record.realtimeTranscriptionProviderIds,
    catalogKinds: ["voice"],
  });

  const registerRealtimeVoiceProvider = createProviderLikeRegistrar({
    kindLabel: "realtime voice provider",
    registrations: registry.realtimeVoiceProviders,
    ownedIds: (record) => record.realtimeVoiceProviderIds,
    catalogKinds: ["voice"],
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
    catalogKinds: ["image_generation"],
  });

  const registerVideoGenerationProvider = createProviderLikeRegistrar({
    kindLabel: "video-generation provider",
    registrations: registry.videoGenerationProviders,
    ownedIds: (record) => record.videoGenerationProviderIds,
    catalogKinds: ["video_generation"],
  });

  const registerMusicGenerationProvider = createProviderLikeRegistrar({
    kindLabel: "music-generation provider",
    registrations: registry.musicGenerationProviders,
    ownedIds: (record) => record.musicGenerationProviderIds,
    catalogKinds: ["music_generation"],
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
