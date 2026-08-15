import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { releaseClaimIfOwned } from "./worker-turn-admission.js";

export type WorkerTurnEnvironmentService = Pick<
  WorkerEnvironmentService,
  | "acknowledgeCredentialDelivery"
  | "acquireTurnCredential"
  | "destroy"
  | "get"
  | "startTunnel"
  | "stopTunnel"
> &
  Partial<Pick<WorkerEnvironmentService, "resolveSshIdentity">>;

export type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

export class WorkerTurnExecutionError extends Error {}

function workerTurnRecoveryError(error: unknown): string {
  const message = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(message || "cloud worker turn failed", 1_024);
}

export async function failHandedOffTurn(params: {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  placement: ActiveWorkerPlacement;
  turnClaim: WorkerSessionTurnClaim;
  error: unknown;
}): Promise<void> {
  const failures = [workerTurnRecoveryError(params.error)];
  let draining: WorkerSessionPlacementRecord;
  try {
    draining = params.placements.startDrain({
      sessionId: params.placement.sessionId,
      environmentId: params.placement.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
      expectedGeneration: params.placement.generation,
    });
  } catch {
    // Exact drain ownership failed. Do not tear down an environment that may
    // now belong to a newer placement generation.
    return;
  }
  if (draining.state !== "draining") {
    return;
  }
  await releaseClaimIfOwned(params.placements, params.turnClaim);
  try {
    await params.environments.stopTunnel(
      params.placement.environmentId,
      params.placement.activeOwnerEpoch,
    );
  } catch (error) {
    failures.push(`tunnel stop: ${workerTurnRecoveryError(error)}`);
  }
  try {
    await params.environments.destroy(params.placement.environmentId);
  } catch (error) {
    failures.push(`environment destroy: ${workerTurnRecoveryError(error)}`);
  }
  try {
    const reconciling = params.placements.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    if (reconciling.state !== "reconciling") {
      return;
    }
    params.placements.fail({
      sessionId: reconciling.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: failures.join("; "),
    });
  } catch {
    // Leave the durable draining or reconciling row for startup reconciliation.
  }
}
