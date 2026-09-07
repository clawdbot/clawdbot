import { randomUUID } from "node:crypto";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { isCurrentActiveWorkerEnvironment } from "./placement-dispatch-failure.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerWorkspaceReconcileRequest,
  type WorkerSessionWorkspace,
} from "./session-workspace.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  createWorkspaceResultJournal,
  settleStagedWorkspaceResult,
} from "./workspace-result-finalize.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

export function createRepositoryWorkspaceMutationService(options: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get" | "startTunnel">;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
}) {
  const { placements, environments } = options;
  return {
    async mutate<T>(
      params: WorkerSessionPlacementIdentity & {
        assertCurrent: () => void;
        mutate: (assertCurrent: () => void) => Promise<{ changed: boolean; value: T }>;
      },
    ): Promise<T> {
      params.assertCurrent();
      const placement = placements.get(params.sessionId);
      if (placement?.state !== "active") {
        throw new Error("Repository workspace editing requires an active cloud placement");
      }
      return await options.workspaceOperations.run(placement.environmentId, async () => {
        params.assertCurrent();
        const workspace = await options.resolveWorkspace(params);
        if (workspace.kind !== "repository") {
          throw new Error("Session no longer owns a cloud repository workspace");
        }
        const environment = environments.get(placement.environmentId);
        if (!isCurrentActiveWorkerEnvironment(placement, environment)) {
          throw new Error("Repository workspace environment is no longer current");
        }
        const storePath = resolveSessionStorePathForScope(params);
        const assertOwner = () => {
          params.assertCurrent();
          const entry = loadSessionEntryReadOnly({ ...params, storePath });
          const current = placements.get(params.sessionId);
          const currentEnvironment = environments.get(placement.environmentId);
          if (
            entry?.sessionId !== params.sessionId ||
            entry.repositoryWorkspaceId !== workspace.repository.workspaceId ||
            workspace.repository.agentId !== params.agentId ||
            workspace.repository.sessionKey !== params.sessionKey ||
            current?.state !== "active" ||
            current.agentId !== params.agentId ||
            current.sessionKey !== params.sessionKey ||
            current.generation !== placement.generation ||
            current.environmentId !== placement.environmentId ||
            current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
            current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
            !isCurrentActiveWorkerEnvironment(current, currentEnvironment) ||
            currentEnvironment?.leaseId !== environment?.leaseId
          ) {
            throw new Error("Repository workspace edit lost its exact session placement owner");
          }
        };
        assertOwner();
        const claim = placements.claimWorkspaceMutationResult({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          claimId: `workspace-mutation-${randomUUID()}`,
          owner: placementTurnOwner(placement),
        });
        const assertCurrent = () => {
          assertOwner();
          if (!placements.validateWorkspaceResultClaim(claim)) {
            throw new Error("Repository workspace edit lost its result custody");
          }
        };
        try {
          assertCurrent();
          const result = await params.mutate(assertCurrent);
          assertCurrent();
          if (!result.changed) {
            placements.acceptWorkspaceResult(claim);
            placements.completeWorkspaceResultAndReleaseTurn(claim);
            return result.value;
          }
          const tunnel = await environments.startTunnel({
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          });
          assertCurrent();
          if (
            tunnel.environmentId !== placement.environmentId ||
            tunnel.ownerEpoch !== placement.activeOwnerEpoch
          ) {
            throw new Error("Repository workspace capture tunnel owner changed");
          }
          const quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir);
          let resumed = false;
          try {
            assertCurrent();
            const stagedResultRef = workerWorkspaceResultRef(claim.claimId);
            const journal = createWorkspaceResultJournal({
              placement,
              placements,
              turnClaim: claim,
            });
            const reconciliation = await tunnel.reconcileWorkspace(
              createWorkerWorkspaceReconcileRequest({
                workspace,
                remoteWorkspaceDir: placement.remoteWorkspaceDir,
                baseManifestRef: placement.workspaceBaseManifestRef,
                journal: journal.adapter,
                stagedResult: {
                  ref: stagedResultRef,
                  record: (ref) =>
                    placements.recordStagedWorkspaceResult(
                      claim,
                      ref,
                      workspace.repository.workspaceId,
                    ),
                },
                assertCurrent,
              }),
            );
            await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
            assertCurrent();
            if (!journal.wasAccepted()) {
              throw new Error("Repository workspace edit was not durably accepted");
            }
            placements.acceptWorkspaceResult(claim);
            await settleStagedWorkspaceResult({
              placements,
              turnClaim: claim,
              workspace,
              stagedResultRef,
              conflictRetained: false,
              beforeComplete: async () => {
                await quiescence.resume();
                resumed = true;
                assertCurrent();
              },
            });
            return result.value;
          } finally {
            if (!resumed) {
              await quiescence.resume();
            }
          }
        } catch (error) {
          // The remote write may have completed before transport or capture failed.
          // Retain its custody so ordinary result recovery can capture it safely.
          if (placements.validateWorkspaceResultClaim(claim)) {
            placements.handoffWorkspaceResultRecovery(claim);
          }
          throw error;
        }
      });
    },
  };
}
