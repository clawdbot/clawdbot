import { formatErrorMessage } from "../infra/errors.js";
import { createGitHubPublicationTranscriptReporter } from "./github-publication-transcript.js";
import { createGitHubPublicationCoordinator } from "./github-publication.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function createGitHubPublicationRuntime(params: {
  placements: WorkerSessionPlacementStore;
  loadSessionRuntime: Parameters<typeof createGitHubPublicationTranscriptReporter>[0];
  warn: (message: string) => void;
}) {
  const coordinator = createGitHubPublicationCoordinator({ placements: params.placements });
  const report = createGitHubPublicationTranscriptReporter(params.loadSessionRuntime, coordinator);
  const reportDeferred = async (publication: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    result: Parameters<typeof report>[0]["result"];
  }) => {
    try {
      await report(publication);
    } catch (error) {
      params.warn(
        `GitHub publication result reporting deferred for ${publication.sessionId}: ${formatErrorMessage(error)}`,
      );
    }
  };
  const prepareAcceptedWorkspacePublication = async (claim: WorkerSessionTurnClaim) => {
    try {
      await coordinator.prepareClaimWorkspace(claim);
    } catch (error) {
      coordinator.failClaimPreparation(claim, error);
    }
  };
  const publishAcceptedWorkspace = async (claim: WorkerSessionTurnClaim) => {
    const placement = params.placements.get(claim.sessionId);
    if (!placement) {
      params.warn(`GitHub publication deferred because placement ${claim.sessionId} disappeared.`);
      return;
    }
    let results;
    try {
      results = await coordinator.processClaim(claim);
    } catch (error) {
      params.warn(
        `GitHub publication deferred for ${claim.sessionId}: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    for (const result of results) {
      await reportDeferred({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        result,
      });
    }
  };
  const reconcilePublications = async () => {
    try {
      await coordinator.resumeLocalRequests();
    } catch (error) {
      params.warn(`GitHub publication recovery deferred: ${formatErrorMessage(error)}`);
    }
    const attempted = new Set<string>();
    for (const publication of coordinator.failOrphanedRequests()) {
      attempted.add(publication.result.requestId);
      await reportDeferred(publication);
    }
    for (const publication of coordinator.listUnreportedResults()) {
      if (!attempted.has(publication.result.requestId)) {
        await reportDeferred(publication);
      }
    }
  };
  return {
    coordinator,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
    reconcilePublications,
  };
}
