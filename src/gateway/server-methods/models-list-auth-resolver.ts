import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "../../agents/auth-profiles/external-cli-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { isActivatedManifestOwner } from "../../plugins/manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveModelChoiceAgentRuntime } from "./models-list-public-projection.js";

function listEnabledSyntheticAuthProviderRefs(
  metadataSnapshot: PluginMetadataSnapshot,
): readonly string[] {
  return metadataSnapshot.index.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

export function createPreparedSyntheticCliRuntimeResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  metadataSnapshot: PluginMetadataSnapshot;
}): (entry: ModelCatalogEntry) => string | undefined {
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const activatedPluginIds = new Set(
    params.metadataSnapshot.plugins
      .filter((plugin) =>
        isActivatedManifestOwner({
          plugin,
          normalizedConfig: normalizedPluginConfig,
          rootConfig: params.cfg,
        }),
      )
      .map((plugin) => plugin.id),
  );
  return (entry) => {
    const runtime = normalizeProviderId(
      resolveModelChoiceAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
      })?.id ?? "",
    );
    if (!runtime || runtime === "openclaw") {
      return undefined;
    }
    const provider = normalizeProviderId(entry.provider);
    const providerOwners = new Set(params.metadataSnapshot.owners.providers.get(provider) ?? []);
    const owners = (params.metadataSnapshot.owners.cliBackends.get(runtime) ?? []).filter(
      (pluginId) =>
        providerOwners.has(pluginId) &&
        activatedPluginIds.has(pluginId) &&
        params.metadataSnapshot.byPluginId
          .get(pluginId)
          ?.syntheticAuthRefs?.some((candidate) => normalizeProviderId(candidate) === runtime),
    );
    return owners.length === 1 ? runtime : undefined;
  };
}

export function createModelsListAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  workspaceDir: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore: params.preparedAuthStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(params.metadataSnapshot),
    externalCliProviderIds: resolveExternalCliAuthScopeFromConfig(params.cfg)?.providerIds ?? [],
    preparedRuntimeAuthStore: params.preparedAuthStore,
    routeResolverFactory: params.routeResolverFactory,
  });
}
