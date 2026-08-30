/** Resolves agent runtime config, including SecretRef materialization for agent command use. */
import {
  getAgentRuntimeCommandSecretTargetIds,
  getAgentRuntimeOptionalCommandSecretPaths,
  getScopedChannelsCommandSecretTargets,
} from "../cli/command-secret-targets.js";
import { getRuntimeConfig, readConfigFileSnapshotForWrite } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import { preparePluginMetadata } from "../plugins/plugin-metadata-collection.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { RuntimeEnv } from "../runtime.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { listAgentEntries } from "./agent-scope.js";
import { measureAgentStartup } from "./startup-timing.js";

/** Loads runtime/source config and resolves command SecretRefs when the agent path needs them. */
export async function resolveAgentRuntimeConfig(
  runtime: RuntimeEnv,
  params?: {
    runtimeTargetsChannelSecrets?: boolean;
    runtimeChannelSecretScope?: { channel: string; accountId?: string };
  },
): Promise<{
  loadedRaw: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  cfg: OpenClawConfig;
}> {
  const loadedRaw = getRuntimeConfig();
  const includeChannelTargets = params?.runtimeTargetsChannelSecrets === true;
  const channelSecretScope = params?.runtimeChannelSecretScope;
  const hasRuntimeSecretRefs = hasAgentRuntimeSecretRefs({
    config: loadedRaw,
    includeChannelTargets,
    channel: channelSecretScope?.channel,
  });
  const secretsRuntime = await measureAgentStartup(
    "secrets-runtime-import",
    () => import("../secrets/runtime.js"),
    { config: loadedRaw },
  );
  const activeSecretsRuntimeSnapshot = secretsRuntime.getActiveSecretsRuntimeSnapshot();
  let pluginMetadata: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry"> | undefined;
  const sourceConfig = activeSecretsRuntimeSnapshot
    ? activeSecretsRuntimeSnapshot.sourceConfig
    : await measureAgentStartup(
        "config-source",
        async () => {
          try {
            const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
            if (snapshot.valid) {
              pluginMetadata = writeOptions.basePluginMetadata;
              return snapshot.resolved;
            }
          } catch {
            // Fall back to runtime-loaded config when source snapshot is unavailable.
          }
          pluginMetadata = preparePluginMetadata({ config: loadedRaw });
          return loadedRaw;
        },
        { config: loadedRaw },
      );
  const cfg = hasRuntimeSecretRefs
    ? await (async () => {
        const runtimeSecretTargets = resolveAgentRuntimeSecretTargets({
          config: loadedRaw,
          includeChannelTargets,
          channelSecretScope,
        });
        return (
          await (
            await import("../cli/command-config-resolution.runtime.js")
          ).resolveCommandConfigWithSecrets({
            config: loadedRaw,
            commandName: "agent",
            targetIds: runtimeSecretTargets.targetIds,
            ...(runtimeSecretTargets.allowedPaths
              ? { allowedPaths: runtimeSecretTargets.allowedPaths }
              : {}),
            ...(runtimeSecretTargets.optionalActivePaths.size > 0
              ? { optionalActivePaths: runtimeSecretTargets.optionalActivePaths }
              : {}),
            runtime,
          })
        ).resolvedConfig;
      })()
    : loadedRaw;
  if (activeSecretsRuntimeSnapshot && cfg !== loadedRaw) {
    // Gateway activation already published loadedRaw with this source config. Republishing the
    // same object here would advance its lifecycle revision and evict revision-keyed hot caches.
    setRuntimeConfigSnapshot(cfg, sourceConfig);
  } else if (!activeSecretsRuntimeSnapshot) {
    // Standalone local agent commands have no Gateway-owned snapshot. Materialize
    // auth-profile refs too; resolving only config refs leaves selected credentials unusable.
    const snapshot = await measureAgentStartup(
      "secrets-snapshot",
      () =>
        secretsRuntime.prepareSecretsRuntimeSnapshot({
          config: sourceConfig,
          assignmentConfig: cfg,
          includeConfigRefs: false,
          ...(pluginMetadata ? { pluginMetadataSnapshot: pluginMetadata } : {}),
        }),
      { config: cfg },
    );
    secretsRuntime.activateSecretsRuntimeSnapshot(snapshot);
  }
  return {
    loadedRaw,
    sourceConfig,
    cfg,
  };
}

function hasNestedSecretRef(value: unknown): boolean {
  if (isSecretRef(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasNestedSecretRef(entry));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((entry) => hasNestedSecretRef(entry));
}

function hasAgentRuntimeSecretRefs(params: {
  config: OpenClawConfig;
  includeChannelTargets: boolean;
  channel?: string;
}): boolean {
  const { config } = params;
  if (hasNestedSecretRef(config.models?.providers)) {
    return true;
  }
  if (hasNestedSecretRef(config.memory?.search?.remote)) {
    return true;
  }
  if (
    listAgentEntries(config).some((agent) =>
      hasNestedSecretRef({
        memoryRemote: agent.memory?.search?.remote,
        ttsProviders: agent.tts?.providers,
      }),
    )
  ) {
    return true;
  }
  if (hasNestedSecretRef(config.tts?.providers)) {
    return true;
  }
  if (hasNestedSecretRef(config.skills?.entries)) {
    return true;
  }
  if (hasNestedSecretRef(config.tools?.web?.search)) {
    return true;
  }
  if (
    config.plugins?.entries &&
    Object.values(config.plugins.entries).some((entry) =>
      hasNestedSecretRef({
        webSearch: entry?.config?.webSearch,
        webFetch: entry?.config?.webFetch,
      }),
    )
  ) {
    return true;
  }
  if (params.includeChannelTargets) {
    return hasNestedSecretRef(config.channels);
  }
  if (!params.channel) {
    return false;
  }
  return hasNestedSecretRef(
    (config.channels as Record<string, unknown> | undefined)?.[params.channel],
  );
}

function resolveAgentRuntimeSecretTargets(params: {
  config: OpenClawConfig;
  includeChannelTargets: boolean;
  channelSecretScope?: { channel: string; accountId?: string };
}): {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
  optionalActivePaths: Set<string>;
} {
  const baseTargetIds = getAgentRuntimeCommandSecretTargetIds({
    config: params.config,
    includeChannelTargets: params.includeChannelTargets,
  });
  const optionalActivePaths = getAgentRuntimeOptionalCommandSecretPaths(params.config);
  if (params.includeChannelTargets || !params.channelSecretScope) {
    return { targetIds: baseTargetIds, optionalActivePaths };
  }
  const channelTargets = getScopedChannelsCommandSecretTargets({
    config: params.config,
    channel: params.channelSecretScope.channel,
    accountId: params.channelSecretScope.accountId,
    defaultAccountWhenMissing: true,
  });
  const targetIds = new Set(baseTargetIds);
  for (const targetId of channelTargets.targetIds) {
    targetIds.add(targetId);
  }
  if (!channelTargets.allowedPaths) {
    return { targetIds, optionalActivePaths };
  }

  // Account scoping must not exclude the agent's model/tool secrets from the same resolution.
  const allowedPaths = new Set(channelTargets.allowedPaths);
  for (const target of discoverConfigSecretTargetsByIds(params.config, baseTargetIds)) {
    allowedPaths.add(target.path);
  }
  return { targetIds, allowedPaths, optionalActivePaths };
}
