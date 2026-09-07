import type { PluginDiagnostic } from "./manifest-types.js";
import { createModelCatalogRegistrationHandlers } from "./model-catalog-registration.js";
import { createNativeSessionCatalogGate } from "./native-session-catalog-registration.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistryParams } from "./registry-types.js";
import type { PluginHookName } from "./types.js";

export type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
  allowConversationAccess?: boolean;
  timeoutMs?: number;
  timeouts?: Record<string, number>;
};

export type PluginSideEffectGuard = {
  active: boolean;
};

type PluginRegistrationCapabilities = {
  /** Broad registry writes that discovery and live activation both need. */
  capabilityHandlers: boolean;
  /** Setup-runtime may publish pre-listen gateway surfaces without full activation. */
  setupRuntimeHandlers: boolean;
  /** Runtime channel registration is suppressed for setup-only and tool discovery loads. */
  runtimeChannel: boolean;
};

/** Decode the public mode once so domain registrars do not repeat string checks. */
export function resolvePluginRegistrationCapabilities(
  mode: import("./types.js").PluginRegistrationMode,
): PluginRegistrationCapabilities {
  const capabilityHandlers = mode === "full" || mode === "discovery" || mode === "tool-discovery";
  return {
    capabilityHandlers,
    setupRuntimeHandlers: mode === "setup-runtime",
    runtimeChannel: mode !== "setup-only" && mode !== "tool-discovery",
  };
}

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function resolveTypedHookTimeoutMs(params: {
  hookName: PluginHookName;
  opts?: { timeoutMs?: number };
  policy?: PluginTypedHookPolicy;
}): number | undefined {
  return (
    normalizeHookTimeoutMs(params.policy?.timeouts?.[params.hookName]) ??
    normalizeHookTimeoutMs(params.policy?.timeoutMs) ??
    normalizeHookTimeoutMs(params.opts?.timeoutMs)
  );
}

export function createPluginRegistryState(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const nativeCatalogGates = new WeakMap<
    PluginRecord,
    ReturnType<typeof createNativeSessionCatalogGate>
  >();
  const getNativeCatalogGate = (record: PluginRecord) => {
    if (!record.nativeSessionCatalog) {
      return undefined;
    }
    let gate = nativeCatalogGates.get(record);
    if (!gate) {
      gate = createNativeSessionCatalogGate({
        pluginId: record.id,
        getConfig: () => registryParams.runtime.config.current(),
      });
      nativeCatalogGates.set(record, gate);
    }
    return gate;
  };
  bindPluginRegistryRuntime(registry, registryParams.runtime);
  const coreGatewayMethods = new Set(registryParams.coreGatewayMethodNames);
  for (const name of Object.keys(registryParams.coreGatewayHandlers ?? {})) {
    coreGatewayMethods.add(name);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- This array is separate from the membership index.
  registry.coreGatewayMethodNames = Array.from(coreGatewayMethods).sort();

  const pushDiagnostic = (diagnostic: PluginDiagnostic) => {
    registry.diagnostics.push(diagnostic);
  };
  const reportRegistrationError = (record: PluginRecord, message: string) => {
    pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
  };
  const reportRegistrationWarning = (record: PluginRecord, message: string) => {
    pushDiagnostic({ level: "warn", pluginId: record.id, source: record.source, message });
  };
  const modelCatalogRegistrars = createModelCatalogRegistrationHandlers({
    registry,
    pushDiagnostic,
  });

  return {
    registry,
    registryParams,
    getNativeCatalogGate,
    allowProcessHomeSessionCatalogs: registryParams.allowProcessHomeSessionCatalogs ?? true,
    coreGatewayMethods,
    getHostCronService: () => registryParams.hostServices?.cron,
    pluginsWithChannelRegistrationConflict: new Set<string>(),
    pluginSideEffectGuards: new Map<string, Set<PluginSideEffectGuard>>(),
    pushDiagnostic,
    reportRegistrationError,
    reportRegistrationWarning,
    ...modelCatalogRegistrars,
  };
}

export type PluginRegistryState = ReturnType<typeof createPluginRegistryState>;
