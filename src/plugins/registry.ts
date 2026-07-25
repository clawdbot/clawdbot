/** In-memory plugin registry builder and mutation API for plugin runtime registration. */
import { clearCodeModeNamespacesForPlugin } from "../agents/code-mode-namespaces.js";
import { clearContextEnginesForOwner } from "../context-engine/registry.js";
import { clearPluginCommandsForPlugin } from "./command-registry-state.js";
import { cleanupPluginSessionSchedulerJobs } from "./host-hook-runtime.js";
import { clearPluginInteractiveHandlersForPlugin } from "./interactive-registry.js";
import { createPluginApiFactory } from "./registry-api.js";
import { createPluginRegistrars } from "./registry-registrars.js";
import { createPluginRuntimeResolver } from "./registry-runtime.js";
import { createPluginRegistryState } from "./registry-state.js";
import type {
  PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration,
  PluginRegistryParams,
} from "./registry-types.js";
import type { OpenClawPluginGatewayRuntimeScopeSurface } from "./types.js";

export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};

export type { PluginRecord, PluginRegistry } from "./registry-types.js";
export { createEmptyPluginRegistry } from "./registry-empty.js";

/**
 * Compose the registry state, domain registrars, scoped runtime, and plugin API.
 * Domain modules own validation and mutation; this function owns lifecycle wiring only.
 */
export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const state = createPluginRegistryState(registryParams);
  const registrars = createPluginRegistrars(state);
  const runtimeResolver = createPluginRuntimeResolver(state);
  const { createApi, deactivatePluginSideEffectGuards } = createPluginApiFactory(
    state,
    registrars,
    runtimeResolver,
  );

  const rollbackPluginGlobalSideEffects = (pluginId: string) => {
    deactivatePluginSideEffectGuards(pluginId);
    if (registryParams.activateGlobalSideEffects === false) {
      return;
    }
    clearPluginCommandsForPlugin(pluginId);
    clearPluginInteractiveHandlersForPlugin(pluginId);
    clearCodeModeNamespacesForPlugin(pluginId);
    clearContextEnginesForOwner(`plugin:${pluginId}`);
    registrars.rollbackHooks(pluginId);

    // Roll back live session-scheduler records created during a failed registration.
    // registry.sessionSchedulerJobs metadata is restored by the snapshot above; this
    // removes the module-global live records and invokes their cleanup callbacks so
    // external plugin-owned work is cancelled at the rollback boundary.
    const schedulerRecords = state.registry.sessionSchedulerJobs.filter(
      (r) => r.pluginId === pluginId,
    );
    if (schedulerRecords.length > 0) {
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

  return {
    registry: state.registry,
    createApi,
    rollbackPluginGlobalSideEffects,
    pushDiagnostic: state.pushDiagnostic,
    registerTool: registrars.registerTool,
    registerChannel: registrars.registerChannel,
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
