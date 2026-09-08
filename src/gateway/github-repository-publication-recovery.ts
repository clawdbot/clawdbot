import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { formatErrorMessage } from "../infra/errors.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease.js";
import { exactClaimForPlacement } from "./github-publication-coordinator-methods.js";
import {
  bindRepositoryGitHubPublicationCheckpoint,
  deferRepositoryGitHubPublicationClaims,
  failStaleRepositoryGitHubPublication,
  listRepositoryGitHubPublications,
  requireRepositoryGitHubPublication,
  terminalRepositoryGitHubPublication,
  type RepositoryGitHubPublicationRow,
} from "./github-repository-publication-store.js";
import {
  captureCheckpoint,
  resolveReceiptOwner,
  type PreparedRepositoryPublicationSnapshot,
} from "./github-repository-publication-workspace.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import { SessionWorkspaceReservationBusyError } from "./worker-environments/placement-workspace-reservation.js";

export function matchesRepositoryGitHubPublicationClaim(
  row: RepositoryGitHubPublicationRow,
  claim: WorkerSessionTurnClaim,
): boolean {
  return (
    row.environment_id !== null &&
    row.owner_epoch !== null &&
    row.session_id === claim.sessionId &&
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

export function createRepositoryGitHubPublicationRecovery(params: {
  placements: WorkerSessionPlacementStore;
  isExecuting: (requestId: string) => boolean;
  execute: (
    row: RepositoryGitHubPublicationRow,
    assertCurrent: () => void,
    prepared?: PreparedRepositoryPublicationSnapshot,
  ) => Promise<SessionGitHubPublicationResult>;
}) {
  const { placements } = params;
  return {
    async resumeSessionRequests(): Promise<void> {
      const failures: Error[] = [];
      for (let row of listRepositoryGitHubPublications({ ownerProfileId: null, pending: true })) {
        try {
          if (placements.get(row.session_id)?.turnClaim || params.isExecuting(row.request_id)) {
            continue;
          }
          await placements.withRepositoryWorkspaceReservation(
            { sessionId: row.session_id, sessionKey: row.session_key, agentId: row.agent_id },
            async (assertCurrent) => {
              row = requireRepositoryGitHubPublication(row.request_id);
              if (terminalRepositoryGitHubPublication(row)) {
                return;
              }
              // The execution holds this same exclusion until its awaited effect
              // observation is recorded. Only then may recovery retire its authority.
              const owner = resolveReceiptOwner(row);
              if (!owner) {
                failStaleRepositoryGitHubPublication(row, () => Boolean(resolveReceiptOwner(row)));
                return;
              }
              if (!row.checkpoint_ref && !owner.workspace.checkpointRef) {
                return;
              }
              if (!row.checkpoint_ref) {
                return await captureCheckpoint(row, assertCurrent, async (facts, prepared) => {
                  row = bindRepositoryGitHubPublicationCheckpoint(row, facts, assertCurrent);
                  await params.execute(row, assertCurrent, prepared);
                });
              }
              await params.execute(row, assertCurrent);
            },
          );
        } catch (error) {
          if (
            error instanceof SessionWorkspaceReservationBusyError ||
            (error instanceof OpenClawStateLeaseError &&
              error.code === "OPENCLAW_STATE_LEASE_TIMEOUT")
          ) {
            continue;
          }
          failures.push(
            new Error(`Publication ${row.request_id}: ${formatErrorMessage(error)}`, {
              cause: error,
            }),
          );
        }
      }
      // One temporarily blocked session must not starve unrelated receipts; hard
      // failures still reach the runtime's warning after every eligible owner runs.
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
      }
    },
    deferOrphanedRequests(): void {
      const pending = placements.listPendingWorkspaceResults();
      deferRepositoryGitHubPublicationClaims(
        listRepositoryGitHubPublications({ ownerProfileId: null, pending: true })
          .filter((row) => {
            if (!row.claim_id) {
              return false;
            }
            const placement = placements.get(row.session_id);
            const claim = placement ? exactClaimForPlacement(placement) : undefined;
            return (
              !(claim && matchesRepositoryGitHubPublicationClaim(row, claim)) &&
              !pending.some(
                (result) =>
                  result.sessionId === row.session_id &&
                  result.claimId === row.claim_id &&
                  result.runId === row.run_id,
              )
            );
          })
          .map((row) => row.request_id),
      );
    },
  };
}
