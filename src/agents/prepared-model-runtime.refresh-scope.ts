import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPluginMetadataWorkspaceSnapshot,
  withPluginMetadataCollectionScope,
} from "../plugins/plugin-metadata-collection.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
  listConfiguredOwnerInputs,
  normalizePreparedModelRuntimeInput,
  ownerKey,
} from "./prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeRefreshOptions,
} from "./prepared-model-runtime.types.js";

/** Whether a refresh scope must replace this owner rather than retain it. */
export function isPreparedModelRuntimeOwnerInRefreshScope(
  owner: PreparedModelRuntimeOwner,
  agentIds: ReadonlySet<string> | undefined,
): boolean {
  if (!agentIds) {
    return true;
  }
  // Standalone and read-only owners keep independent config identities, so only configured and
  // leased run owners participate in agent-scoped retention.
  if (owner.input.readOnly || (owner.provenance !== "configured" && owner.provenance !== "run")) {
    return true;
  }
  return !owner.input.agentId || agentIds.has(owner.input.agentId);
}

/** Builds configured inputs while preserving the startup-selected default workspace. */
export function listConfiguredRefreshInputs(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  owners: Map<string, PreparedModelRuntimeOwner>,
): PreparedModelRuntimeInput[] {
  const preservedWorkspaceByAgentDir = new Map<string, Map<string, string>>();
  for (const owner of owners.values()) {
    const { agentDir, agentId, preserveWorkspaceDirOnRefresh, workspaceDir } = owner.input;
    if (
      owner.provenance !== "configured" ||
      !agentId ||
      !preserveWorkspaceDirOnRefresh ||
      !workspaceDir
    ) {
      continue;
    }
    let workspacesByDir = preservedWorkspaceByAgentDir.get(agentId);
    if (!workspacesByDir) {
      workspacesByDir = new Map();
      preservedWorkspaceByAgentDir.set(agentId, workspacesByDir);
    }
    if (!workspacesByDir.has(agentDir)) {
      workspacesByDir.set(agentDir, workspaceDir);
    }
  }
  const listInputs = () =>
    listConfiguredOwnerInputs(
      config,
      options.defaultWorkspaceDir,
      options.allowGatewaySubagentBinding,
      preservedWorkspaceByAgentDir,
    ).map(normalizePreparedModelRuntimeInput);
  // Input planning can precede publication; it must consume the same captured
  // metadata as the build rather than the currently published Gateway generation.
  return options.pluginMetadata
    ? withPluginMetadataCollectionScope(options.pluginMetadata, listInputs, { config })
    : listInputs();
}

/** Invalidates scoped owners and optionally advances retained owners to a new config stamp. */
export function updateOwnersForScopedRefresh(
  owners: Map<string, PreparedModelRuntimeOwner>,
  agentIds: ReadonlySet<string> | undefined,
  staleError: Error,
  options: {
    retainedConfig?: OpenClawConfig;
    retireStandalone?: boolean;
    clearPending?: boolean;
    resetPluginGeneration?: boolean;
  } = {},
): void {
  for (const [key, owner] of owners) {
    if (!isPreparedModelRuntimeOwnerInRefreshScope(owner, agentIds)) {
      if (options.retainedConfig) {
        advancePreparedModelRuntimeOwnerConfig(owner, options.retainedConfig);
      }
      continue;
    }
    if (options.retireStandalone && owner.provenance === "standalone") {
      owner.generation += 1;
      owners.delete(key);
      continue;
    }
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    if (options.clearPending) {
      owner.pending = undefined;
    }
    if (options.resetPluginGeneration) {
      owner.pluginGeneration = undefined;
    }
  }
}

/** Keeps a requested scope only when every retained owner has identical prepared dependencies. */
export function resolveSafeRefreshAgentIds(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  owners: Map<string, PreparedModelRuntimeOwner>,
): ReadonlySet<string> | undefined {
  const requested = options.agentIds;
  if (!requested) {
    return undefined;
  }
  const inputs = new Map(
    listConfiguredRefreshInputs(config, options, owners).flatMap((input) =>
      input.agentId ? [[input.agentId, input] as const] : [],
    ),
  );
  for (const owner of owners.values()) {
    if (
      owner.provenance !== "configured" ||
      !owner.input.agentId ||
      requested.has(owner.input.agentId)
    ) {
      continue;
    }
    const input = inputs.get(owner.input.agentId);
    if (
      !input ||
      !owner.snapshot ||
      owner.needsRefresh ||
      owner.catalogMode !== (options.catalogMode ?? "live") ||
      (options.pluginMetadata &&
        owner.snapshot.metadataSnapshot !==
          getPluginMetadataWorkspaceSnapshot(options.pluginMetadata, {
            workspaceDir: input.workspaceDir,
          })) ||
      ownerKey({ ...owner.input, config: input.config }) !== ownerKey(input)
    ) {
      return undefined;
    }
  }
  return requested;
}
