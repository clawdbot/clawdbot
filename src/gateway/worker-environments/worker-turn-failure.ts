import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
  Partial<
    Pick<WorkerEnvironmentService, "resolveSshIdentity" | "supportsNodePortal" | "prepareComputer">
  >;

export type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

export class WorkerTurnExecutionError extends Error {}

// Journal-terminal launches get a short cleanup grace before failure is surfaced.
// This never limits a live launch or a turn still holding its claim.
const TERMINAL_WORKER_CLEANUP_GRACE_MS = 30_000;

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
  terminal?: {
    observedAtMs: number;
    registerRecovery(recover: () => string | undefined): void;
  };
}): Promise<void> {
  const failures = [workerTurnRecoveryError(params.error)];
  let drained: WorkerSessionPlacementRecord;
  try {
    drained = params.placements.startDrain({
      sessionId: params.placement.sessionId,
      environmentId: params.placement.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
      expectedGeneration: params.placement.generation,
    });
  } catch {
    const current = params.placements.get(params.placement.sessionId);
    const exactDrainOwner =
      current?.state === "draining" &&
      current.generation === params.placement.generation + 1 &&
      current.environmentId === params.placement.environmentId &&
      current.activeOwnerEpoch === params.placement.activeOwnerEpoch &&
      params.placements.validateTurnClaim(params.turnClaim);
    if (exactDrainOwner) {
      // Another lifecycle owner already closed admission for this exact turn.
      // Release its claim without stealing that owner's reconciliation or teardown.
      await releaseClaimIfOwned(params.placements, params.turnClaim);
    }
    // A different drain owner may belong to a replacement placement. Never
    // tear down an environment after losing the exact source-generation CAS.
    return;
  }
  if (drained.state !== "draining") {
    return;
  }
  const draining = drained;
  await releaseClaimIfOwned(params.placements, params.turnClaim);
  const isCurrentDrain = () => {
    const current = params.placements.get(draining.sessionId);
    return (
      current?.state === "draining" &&
      current.generation === draining.generation &&
      current.environmentId === draining.environmentId &&
      current.activeOwnerEpoch === draining.activeOwnerEpoch &&
      current.turnClaim === null
    );
  };
  const recordFailure = (): string | undefined => {
    if (!isCurrentDrain()) {
      return undefined;
    }
    try {
      const reconciling = params.placements.startReconcile({
        sessionId: draining.sessionId,
        environmentId: draining.environmentId,
        ownerEpoch: draining.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      const recoveryError = failures.join("; ");
      params.placements.fail({
        sessionId: reconciling.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError,
      });
      return recoveryError;
    } catch {
      // Leave the durable draining or reconciling row for startup reconciliation.
      return undefined;
    }
  };
  const terminalRecovery = params.terminal ? createDeferredCore() : undefined;
  if (params.terminal && terminalRecovery) {
    const observedAtMs = params.terminal.observedAtMs;
    params.terminal.registerRecovery(() => {
      if (Date.now() - observedAtMs < TERMINAL_WORKER_CLEANUP_GRACE_MS) {
        return undefined;
      }
      const recorded = recordFailure();
      if (recorded !== undefined) {
        terminalRecovery.resolve();
      }
      return recorded;
    });
  }
  const waitForCleanup = (operation: Promise<unknown>) =>
    terminalRecovery ? Promise.race([operation, terminalRecovery.promise]) : operation;
  if (!isCurrentDrain()) {
    return;
  }
  try {
    await waitForCleanup(
      params.environments.stopTunnel(
        params.placement.environmentId,
        params.placement.activeOwnerEpoch,
      ),
    );
  } catch (error) {
    failures.push(`tunnel stop: ${workerTurnRecoveryError(error)}`);
  }
  // Recovery may have recorded failure, or a replacement may own the session.
  // A late cleanup completion must never destroy that newer placement.
  if (!isCurrentDrain()) {
    return;
  }
  try {
    await waitForCleanup(params.environments.destroy(params.placement.environmentId));
  } catch (error) {
    failures.push(`environment destroy: ${workerTurnRecoveryError(error)}`);
  }
  recordFailure();
}
