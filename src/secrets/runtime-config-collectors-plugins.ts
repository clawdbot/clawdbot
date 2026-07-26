/** Collects plugin config secret refs from runtime plugin metadata. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPluginConfigContractMatches,
  resolvePluginConfigContractsById,
} from "../plugins/config-contracts.js";
import { normalizePluginsConfig, resolveEnableState } from "../plugins/config-state.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

function parsePluginConfigArrayIndex(segment: string): number | undefined {
  return parseConfigPathArrayIndex(segment);
}

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
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
    params.context.env,
  );
  const bundledLoadablePluginIds = [...(params.loadablePluginOrigins?.entries() ?? [])]
    .filter(([, origin]) => origin === "bundled")
    .map(([pluginId]) => pluginId);
  const pluginSecretInputs = new Map(
    [
      ...resolvePluginConfigContractsById({
        config: params.config,
        workspaceDir,
        env: params.context.env,
        fallbackToBundledMetadata: true,
        fallbackToBundledMetadataForResolvedBundled: true,
        fallbackBundledPluginIds: bundledLoadablePluginIds,
        pluginIds: Object.keys(entries),
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
  secretPaths: ReadonlyArray<{ path: string; expected?: "string"; ownerKind?: "route" }>;
  active: boolean;
  inactiveReason: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const seenPaths = new Set<string>();
  for (const secretPath of params.secretPaths) {
    for (const match of collectPluginConfigContractMatches({
      root: params.pluginConfig,
      pathPattern: secretPath.path,
    })) {
      const fullPath = `plugins.entries.${params.pluginId}.config.${match.path}`;
      if (seenPaths.has(fullPath)) {
        continue;
      }
      seenPaths.add(fullPath);

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
                ownerKind: secretPath.ownerKind,
                ownerId: fullPath,
                requiredForGateway: false,
                disposition: "isolate" as const,
                contract: params.pluginConfig,
              },
            }
          : {}),
        apply: createPluginConfigAssignmentApply(params.pluginConfig, match.path),
      });
    }
  }
}

function createPluginConfigAssignmentApply(
  pluginConfig: Record<string, unknown>,
  relativePath: string,
): (value: unknown) => void {
  return (value) => {
    // Manifest paths use dotted/bracket notation; assignment writes need concrete object/array steps.
    const segments = normalizeStringEntries(relativePath.replace(/\[(\d+)\]/g, ".$1").split("."));
    if (segments.length === 0) {
      return;
    }
    let current: unknown = pluginConfig;
    for (const segment of segments.slice(0, -1)) {
      if (Array.isArray(current)) {
        const index = parsePluginConfigArrayIndex(segment);
        current = index !== undefined && index < current.length ? current[index] : undefined;
        continue;
      }
      current = isRecord(current) ? current[segment] : undefined;
    }
    const finalSegment = segments.at(-1);
    if (!finalSegment) {
      return;
    }
    if (Array.isArray(current)) {
      const index = parsePluginConfigArrayIndex(finalSegment);
      if (index !== undefined && index < current.length) {
        current[index] = value;
      }
      return;
    }
    if (isRecord(current)) {
      current[finalSegment] = value;
    }
  };
}
