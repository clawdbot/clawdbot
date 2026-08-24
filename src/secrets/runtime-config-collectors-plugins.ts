/** Collects plugin config secret refs from runtime plugin metadata. */
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPluginConfigContractMatches,
  resolvePluginConfigContractsById,
} from "../plugins/config-contracts.js";
import { normalizePluginsConfig, resolveEnableState } from "../plugins/config-state.js";
import type { PluginManifestSecretInputPath } from "../plugins/manifest-types.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { runtimePluginManifestSecretOwnerId } from "./runtime-plugin-manifest-secret-owner.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

/**
 * Walk manifest-declared plugin config SecretRef surfaces and collect
 * assignments for runtime materialization. Plugin-owned metadata controls which
 * config paths support SecretRefs and whether bundled plugins stay inactive on
 * that surface until explicitly enabled.
 *
 * When `loadablePluginOrigins` is provided, entries whose ID is not in the map
 * are treated as inactive (stale config entries for plugins that are no longer
 * installed). This prevents resolution failures for SecretRefs belonging to
 * non-loadable plugins from blocking startup or preflight validation.
 */
/** Collects SecretRef assignments from plugin-owned config contract paths. */
export function collectPluginConfigAssignments(params: {
  /** Mutable config snapshot whose plugin config values will receive resolved secrets. */
  config: OpenClawConfig;
  /** Defaults from the source config, used while matching manifest-declared SecretInput paths. */
  defaults: SecretDefaults | undefined;
  /** Resolver context that receives assignments and inactive-surface warnings. */
  context: ResolverContext;
  /** Optional installed plugin roots; missing IDs are treated as stale inactive config. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void {
  const entries = params.config.plugins?.entries;
  if (!isRecord(entries)) {
    return;
  }

  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const manifestRegistry =
    params.context.manifestRegistry ??
    resolveConfigWidePluginManifestRegistry({
      config: params.config,
      env: params.context.env,
    });
  const bundledLoadablePluginIds = params.context.manifestRegistry
    ? []
    : [...(params.loadablePluginOrigins?.entries() ?? [])]
        .filter(([, origin]) => origin === "bundled")
        .map(([pluginId]) => pluginId);
  const pluginSecretInputs = new Map(
    [
      ...resolvePluginConfigContractsById({
        config: params.config,
        env: params.context.env,
        fallbackToBundledMetadata: true,
        fallbackToBundledMetadataForResolvedBundled: !params.context.manifestRegistry,
        fallbackBundledPluginIds: bundledLoadablePluginIds,
        pluginIds: Object.keys(entries),
        manifestRegistry,
      }).entries(),
    ].flatMap(([pluginId, metadata]) => {
      const secretInputs = metadata.configContracts.secretInputs;
      if (!secretInputs?.paths.length) {
        return [];
      }
      return [
        [
          pluginId,
          {
            origin: metadata.origin,
            bundledDefaultEnabled: secretInputs.bundledDefaultEnabled,
            paths: secretInputs.paths,
          },
        ] as const,
      ];
    }),
  );

  for (const [pluginId, entry] of Object.entries(entries)) {
    const secretInputs = pluginSecretInputs.get(pluginId);
    if (!secretInputs) {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const pluginConfig = entry.config;
    if (!isRecord(pluginConfig)) {
      continue;
    }

    const pluginOrigin = params.loadablePluginOrigins?.get(pluginId);
    if (params.loadablePluginOrigins && !pluginOrigin) {
      collectConfiguredPluginSecretAssignments({
        pluginId,
        pluginConfig,
        secretPaths: secretInputs.paths,
        active: false,
        inactiveReason: "plugin is not loadable (stale config entry).",
        defaults: params.defaults,
        context: params.context,
      });
      continue;
    }

    const resolvedOrigin = pluginOrigin ?? secretInputs.origin;
    const enableState = resolveEnableState(
      pluginId,
      resolvedOrigin,
      normalizedConfig,
      resolvedOrigin === "bundled" ? secretInputs.bundledDefaultEnabled : undefined,
    );
    collectConfiguredPluginSecretAssignments({
      pluginId,
      pluginConfig,
      secretPaths: secretInputs.paths,
      active: enableState.enabled,
      inactiveReason: enableState.reason ?? "plugin is disabled.",
      defaults: params.defaults,
      context: params.context,
    });
  }
}

function collectConfiguredPluginSecretAssignments(params: {
  pluginId: string;
  pluginConfig: Record<string, unknown>;
  secretPaths: ReadonlyArray<PluginManifestSecretInputPath>;
  active: boolean;
  inactiveReason: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const pluginConfigPath = /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(params.pluginId)
    ? `plugins.entries.${params.pluginId}.config`
    : `plugins.entries[${JSON.stringify(params.pluginId)}].config`;
  const seenPaths = new Set<string>();
  for (const secretPath of params.secretPaths) {
    for (const match of collectPluginConfigContractMatches({
      root: params.pluginConfig,
      pathPattern: secretPath.path,
    })) {
      const relativePath = match.path.startsWith("[") ? match.path : `.${match.path}`;
      const fullPath = `${pluginConfigPath}${relativePath}`;
      if (seenPaths.has(fullPath)) {
        continue;
      }
      seenPaths.add(fullPath);
      const ownerConfig = match.parent;

      // SecretInput allows both explicit objects and inline env-template refs
      // like `${MCP_API_KEY}`. Non-ref strings remain untouched because
      // collectRuntimeSecretInputAssignment ignores them.
      collectRuntimeSecretInputAssignment({
        value: match.value,
        path: fullPath,
        expected: secretPath.expected ?? "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: `plugin "${params.pluginId}": ${params.inactiveReason}`,
        ...(secretPath.ownerKind
          ? {
              owner: {
                ownerKind:
                  secretPath.ownerKind === "route"
                    ? "plugin-route"
                    : secretPath.ownerKind === "capability"
                      ? "plugin-capability"
                      : "plugin-provider",
                ownerId: runtimePluginManifestSecretOwnerId(
                  params.pluginId,
                  secretPath.ownerKind === "route" ? match.path : secretPath.ownerId,
                ),
                requiredForGateway: false,
                disposition: "isolate" as const,
                contract:
                  secretPath.ownerContractFields && isRecord(ownerConfig)
                    ? Object.fromEntries(
                        secretPath.ownerContractFields.flatMap((field) =>
                          Object.hasOwn(ownerConfig, field) ? [[field, ownerConfig[field]]] : [],
                        ),
                      )
                    : params.pluginConfig,
              },
            }
          : {}),
        apply: (value) => {
          if (Array.isArray(ownerConfig)) {
            ownerConfig[Number(match.key)] = value;
          } else {
            ownerConfig[match.key] = value;
          }
        },
      });
    }
  }
}
