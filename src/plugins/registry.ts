/** In-memory plugin registry builder and mutation API for plugin runtime registration. */
import { cleanupPluginSessionSchedulerJobs } from "./host-hook-runtime.js";
import { createPluginApiFactory } from "./registry-api.js";
import { createPluginRegistrars } from "./registry-registrars.js";
import { createPluginRuntimeResolver } from "./registry-runtime.js";
import { createPluginRegistryState } from "./registry-state.js";
import type {
  PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration,
  PluginRecord as RegistryPluginRecord,
  PluginRegistryParams,
} from "./registry-types.js";
import type { OpenClawPluginGatewayRuntimeScopeSurface } from "./types.js";

export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};

export type { PluginRecord, PluginRegistry } from "./registry-types.js";
export { createEmptyPluginRegistry } from "./registry-empty.js";

function clonePluginRecord(record: RegistryPluginRecord): RegistryPluginRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as RegistryPluginRecord;
}

function restorePluginRecord(record: RegistryPluginRecord, snapshot: RegistryPluginRecord): void {
  Object.keys(record).forEach((key) => Reflect.deleteProperty(record, key));
  Object.assign(record, snapshot);
}

/**
 * Compose the registry state, domain registrars, scoped runtime, and plugin API.
 * Domain modules own validation and mutation; this function owns lifecycle wiring only.
 */
export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const state = createPluginRegistryState(registryParams);
  const registrars = createPluginRegistrars(state);
  const runtimeResolver = createPluginRuntimeResolver(state);
  const { createApi: createPluginApi, deactivatePluginSideEffectGuards } = createPluginApiFactory(
    state,
    registrars,
    runtimeResolver,
  );
  const registrationRecordSnapshots = new WeakMap<RegistryPluginRecord, RegistryPluginRecord>();
  const createApi: typeof createPluginApi = (record, params) => {
    registrationRecordSnapshots.set(record, clonePluginRecord(record));
    return createPluginApi(record, params);
  };

  const rollbackPluginGlobalSideEffects = (pluginId: string, record?: RegistryPluginRecord) => {
    deactivatePluginSideEffectGuards(pluginId);
    runtimeResolver.revokePluginRuntimeRecord(pluginId, record);
    const schedulerRecords = state.registry.sessionSchedulerJobs.filter(
      (r) => r.pluginId === pluginId,
    );
    const gatewayMethods = state.registry.gatewayMethodDescriptors
      .filter((entry) => entry.owner.kind === "plugin" && entry.owner.pluginId === pluginId)
      .map((entry) => entry.name);
    for (const [registryKey, value] of Object.entries(state.registry)) {
      // Plugin records and diagnostics are operator-visible load outcomes, not registrations.
      if (registryKey === "plugins" || registryKey === "diagnostics") {
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const entry = value[index] as
            | { pluginId?: string; ownerPluginId?: string; owner?: { pluginId?: string } }
            | undefined;
          if (
            entry?.pluginId === pluginId ||
            entry?.ownerPluginId === pluginId ||
            entry?.owner?.pluginId === pluginId
          ) {
            value.splice(index, 1);
          }
        }
      } else if (value instanceof Map) {
        for (const [key, entry] of value) {
          const owner = entry as { pluginId?: string; owner?: string } | undefined;
          if (owner?.pluginId === pluginId || owner?.owner === `plugin:${pluginId}`) {
            value.delete(key);
          }
        }
      }
    }
    for (const method of gatewayMethods) {
      delete state.registry.gatewayHandlers[method];
    }
    for (const key of state.registry.pluginRuntimeArtifacts.keys()) {
      if ((JSON.parse(key) as unknown[])[0] === pluginId) {
        state.registry.pluginRuntimeArtifacts.delete(key);
      }
    }
    const recordSnapshot = record ? registrationRecordSnapshots.get(record) : undefined;
    if (record && recordSnapshot) {
      restorePluginRecord(record, recordSnapshot);
      registrationRecordSnapshots.delete(record);
    }

    // Scheduler jobs still have a live process registration; contribution rollback
    // drops registry rows above, then cancels external work created before register threw.
    if (registryParams.activateGlobalSideEffects !== false && schedulerRecords.length > 0) {
      void cleanupPluginSessionSchedulerJobs({
        pluginId,
        reason: "disable",
        records: schedulerRecords,
        cleanupOwnerRegistry: state.registry,
      }).then((failures) => {
        for (const failure of failures) {
          state.pushDiagnostic({
            level: "warn",
            pluginId: failure.pluginId,
            message: `scheduler job cleanup failed during rollback: ${failure.hookId}`,
          });
        }
      });
    }
  };

  // Discovery resolves after this builder exists, so the loader supplies the plan-derived
  // suppression set through this narrow filler rather than through construction params.
  const setSupersededChannelClaims = (claims: ReadonlySet<string>) => {
    for (const key of claims) {
      state.supersededChannelClaims.add(key);
    }
  };

  return {
    registry: state.registry,
    createApi,
    rollbackPluginGlobalSideEffects,
    setSupersededChannelClaims,
    pushDiagnostic: state.pushDiagnostic,
    registerTool: registrars.registerTool,
    registerChannel: registrars.registerChannel,
    restoreUnservedSuppressedChannelClaims: registrars.restoreUnservedSuppressedChannelClaims,
    registerHostedMediaResolver: registrars.registerHostedMediaResolver,
    registerMcpServerConnectionResolver: registrars.registerMcpServerConnectionResolver,
    registerProvider: registrars.registerProvider,
    registerWorkerProvider: registrars.registerWorkerProvider,
    registerModelCatalogProvider: registrars.registerModelCatalogProvider,
    registerAgentHarness: registrars.registerAgentHarness,
    registerCliBackend: registrars.registerCliBackend,
    registerTextTransforms: registrars.registerTextTransforms,
    registerEmbeddingProvider: registrars.registerEmbeddingProvider,
    registerSpeechProvider: registrars.registerSpeechProvider,
    registerRealtimeTranscriptionProvider: registrars.registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider: registrars.registerRealtimeVoiceProvider,
    registerMediaUnderstandingProvider: registrars.registerMediaUnderstandingProvider,
    registerTranscriptSourceProvider: registrars.registerTranscriptSourceProvider,
    registerImageGenerationProvider: registrars.registerImageGenerationProvider,
    registerVideoGenerationProvider: registrars.registerVideoGenerationProvider,
    registerMusicGenerationProvider: registrars.registerMusicGenerationProvider,
    registerWebSearchProvider: registrars.registerWebSearchProvider,
    registerMigrationProvider: registrars.registerMigrationProvider,
    registerGatewayMethod: registrars.registerGatewayMethod,
    registerSessionCatalog: registrars.registerSessionCatalog,
    registerCli: registrars.registerCli,
    registerReload: registrars.registerReload,
    registerNodeHostCommand: registrars.registerNodeHostCommand,
    registerSecurityAuditCollector: registrars.registerSecurityAuditCollector,
    registerService: registrars.registerService,
    registerCommand: registrars.registerCommand,
    registerSessionExtension: registrars.registerSessionExtension,
    registerTrustedToolPolicy: registrars.registerTrustedToolPolicy,
    registerToolMetadata: registrars.registerToolMetadata,
    registerControlUiDescriptor: registrars.registerControlUiDescriptor,
    registerRuntimeLifecycle: registrars.registerRuntimeLifecycle,
    registerAgentEventSubscription: registrars.registerAgentEventSubscription,
    registerSessionSchedulerJob: registrars.registerSessionSchedulerJob,
    registerSessionAction: registrars.registerSessionAction,
    registerHook: registrars.registerHook,
    registerTypedHook: registrars.registerTypedHook,
  };
}
