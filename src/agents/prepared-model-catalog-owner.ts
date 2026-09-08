import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import type {
  PublishedModelCatalogOwnerCandidate,
  ResolvedPublishedModelCatalogOwner,
} from "./prepared-model-catalog.types.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

class PublishedModelCatalogOwnerResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedModelCatalogOwnerResolutionError";
  }
}

export function preparePublishedModelCatalogOwnerIdentity(
  input: PreparedModelRuntimeInput,
): PublishedModelCatalogOwnerCandidate["catalogOwner"] {
  const env = input.env ?? process.env;
  const configuredAgentIds = listAgentIds(input.config);
  const directoryAgentIds = input.agentId
    ? []
    : configuredAgentIds.filter(
        (candidate) => resolveAgentDir(input.config, candidate, env) === input.agentDir,
      );
  const agentId = input.agentId
    ? configuredAgentIds.find(
        (candidate) => normalizeAgentId(candidate) === normalizeAgentId(input.agentId),
      )
    : directoryAgentIds.length === 1
      ? directoryAgentIds[0]
      : undefined;
  if (!agentId || resolveAgentDir(input.config, agentId, env) !== input.agentDir) {
    return undefined;
  }
  const workspaceDir = input.workspaceDir ?? resolveAgentWorkspaceDir(input.config, agentId, env);
  return workspaceDir ? Object.freeze({ agentId, workspaceDir }) : undefined;
}

export function resolvePublishedModelCatalogOwner(
  snapshot: PublishedModelCatalogOwnerCandidate,
): ResolvedPublishedModelCatalogOwner {
  const { catalogOwner } = snapshot;
  if (!catalogOwner) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner did not identify one configured agent (${snapshot.agentDir})`,
    );
  }
  const { agentId, workspaceDir } = catalogOwner;
  const authStore = snapshot.authStore ?? getPreparedModelRuntimeAuthStore(snapshot);
  if (!authStore) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner is missing prepared auth state (${agentId})`,
    );
  }
  return Object.freeze({
    catalogOwner,
    agentId,
    agentDir: snapshot.agentDir,
    workspaceDir,
    config: snapshot.config,
    observationConfig: snapshot.observationConfig,
    authModes: snapshot.authModes,
    authStore,
    metadataSnapshot: snapshot.metadataSnapshot,
    pluginRegistry: snapshot.pluginRegistry,
    isCurrent: snapshot.isCurrent,
    modelCatalog: snapshot.modelCatalog,
  });
}

export function publishedModelCatalogOwnerMatchesAgent(
  owner: Pick<ResolvedPublishedModelCatalogOwner, "agentId">,
  agentId: string,
): boolean {
  return owner.agentId === normalizeAgentId(agentId);
}
