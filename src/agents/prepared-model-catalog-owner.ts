import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import type {
  PublishedModelCatalogOwnerCandidate,
  ResolvedPublishedModelCatalogOwner,
} from "./prepared-model-catalog.types.js";

class PublishedModelCatalogOwnerResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedModelCatalogOwnerResolutionError";
  }
}

export function resolvePublishedModelCatalogOwner(
  snapshot: PublishedModelCatalogOwnerCandidate,
): ResolvedPublishedModelCatalogOwner {
  const configuredAgentIds = listAgentIds(snapshot.config);
  const directoryAgentIds = configuredAgentIds.filter(
    (candidate) => resolveAgentDir(snapshot.config, candidate) === snapshot.agentDir,
  );
  const agentId = snapshot.agentId
    ? configuredAgentIds.find(
        (candidate) => normalizeAgentId(candidate) === normalizeAgentId(snapshot.agentId),
      )
    : directoryAgentIds.length === 1
      ? directoryAgentIds[0]
      : undefined;
  if (!agentId || resolveAgentDir(snapshot.config, agentId) !== snapshot.agentDir) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner did not identify one configured agent (${snapshot.agentDir})`,
    );
  }
  const workspaceDir = snapshot.workspaceDir ?? resolveAgentWorkspaceDir(snapshot.config, agentId);
  if (!workspaceDir) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner did not identify a workspace (${agentId})`,
    );
  }
  return Object.freeze({
    agentId,
    agentDir: snapshot.agentDir,
    workspaceDir,
    config: snapshot.config,
    modelCatalog: snapshot.modelCatalog,
  });
}

export function publishedModelCatalogOwnerMatchesAgent(
  owner: Pick<ResolvedPublishedModelCatalogOwner, "agentId">,
  agentId: string,
): boolean {
  return owner.agentId === normalizeAgentId(agentId);
}
