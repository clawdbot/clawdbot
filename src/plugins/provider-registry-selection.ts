import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { matchesDeclaredProviderOwner } from "./provider-owner-index.js";
import type { PluginProviderRegistration, ProviderPlugin } from "./provider-plugin.types.js";
import { matchesProviderRuntimePlugin } from "./provider-registry-shared.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";

/** Resolves the hook receiver with its authoritative registry-owned plugin id. */
export function findProviderRuntimePluginInRegistry(params: {
  registry: { providers: readonly PluginProviderRegistration[] };
  provider: string;
  ownerRefs: readonly string[];
  isOwnerEligible?: (pluginId: string) => boolean;
}): ProviderPlugin | undefined {
  const scope = getPluginRuntimeGatewayRequestScope();
  const owners =
    (scope?.pluginRegistry === params.registry ? scope.declaredProviderOwners : undefined) ??
    getPluginRuntimeLoadContextState(params.registry)?.declaredProviderOwners;
  const isOwnerEligible =
    params.isOwnerEligible ??
    ((id: string) => matchesDeclaredProviderOwner(owners, params.provider, id));
  const literalId = normalizeLowercaseStringOrEmpty(params.provider);
  // A registered provider owns its name; another provider's compatibility
  // alias must not replace its executable hooks in a shared generation.
  const entry =
    params.registry.providers.find(
      ({ pluginId, provider }) =>
        literalId &&
        normalizeLowercaseStringOrEmpty(provider.id) === literalId &&
        isOwnerEligible(pluginId),
    ) ??
    params.registry.providers.find(
      ({ pluginId, provider }) =>
        matchesProviderRuntimePlugin(provider, params.provider, params.ownerRefs) &&
        isOwnerEligible(pluginId),
    );
  return entry ? Object.assign({}, entry.provider, { pluginId: entry.pluginId }) : undefined;
}
