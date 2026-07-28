import type { registerInternalHook } from "../hooks/internal-hooks.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { createModelCatalogRegistrationHandlers } from "./model-catalog-registration.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistryParams } from "./registry-types.js";
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
  const coreGatewayMethodNames = Array.from(
    new Set([
      ...(registryParams.coreGatewayMethodNames ?? []),
      ...Object.keys(registryParams.coreGatewayHandlers ?? {}),
    ]),
  ).toSorted();
  registry.coreGatewayMethodNames = coreGatewayMethodNames;

  const pushDiagnostic = (diagnostic: PluginDiagnostic) => {
    registry.diagnostics.push(diagnostic);
  };
  const modelCatalogRegistrars = createModelCatalogRegistrationHandlers({
    registry,
    pushDiagnostic,
  });

  return {
    registry,
    registryParams,
    coreGatewayMethods: new Set(coreGatewayMethodNames),
    getHostCronService: () => registryParams.hostServices?.cron,
    pluginHookRollback: new Map<
      string,
      Array<{
        name: string;
        previousRegistrations: Array<{
          event: string;
          handler: Parameters<typeof registerInternalHook>[1];
        }>;
      }>
    >(),
    pluginsWithChannelRegistrationConflict: new Set<string>(),
    pluginSideEffectGuards: new Map<string, Set<PluginSideEffectGuard>>(),
    pushDiagnostic,
    ...modelCatalogRegistrars,
  };
}

export type PluginRegistryState = ReturnType<typeof createPluginRegistryState>;
