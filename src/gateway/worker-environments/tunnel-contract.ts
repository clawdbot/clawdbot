import type { WorkerTunnelStatus } from "@openclaw/gateway-protocol";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../../infra/node-commands.js";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import type { NodeWorkerWorkspaceSeedInput } from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerWorkspaceTransferInput } from "../../worker/node-workspace-transfer-protocol.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type {
  WorkerWorkspaceApplyResult,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-reconcile.js";

export type { WorkerTunnelStatus };

/** A disconnected node cannot hide an unfinished or failed local sibling cleanup. */
export async function joinWorkerTunnelStops(operations: readonly (Promise<void> | undefined)[]) {
  const outcomes = await Promise.allSettled(
    operations.filter((operation) => operation !== undefined),
  );
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (
    errors.length === 1 ||
    (errors.length > 1 &&
      errors.every((error) => error instanceof WorkerTunnelOwnerDisconnectedError))
  ) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worker tunnel cleanup failed");
  }
}

export class WorkerTunnelOwnerDisconnectedError extends Error {
  constructor(message = "Worker tunnel owner is no longer connected") {
    super(message);
    this.name = "WorkerTunnelOwnerDisconnectedError";
  }
}

export class WorkerRunnerUnavailableError extends Error {
  readonly code = "runner-offline";

  constructor() {
    super(
      "The device runner is offline. Reconnect it, retry later, or bring the session back to this gateway.",
    );
    this.name = "WorkerRunnerUnavailableError";
  }
}

export class WorkerRunnerCapacityError extends Error {
  readonly code = NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE;

  constructor() {
    super("device worker capacity remained full");
    this.name = "WorkerRunnerCapacityError";
  }
}

export type WorkerTunnelRequest = {
  environmentId: string;
  ownerEpoch: number;
};

/** Provider teardown fences local work first; only its confirmed result releases physical ownership. */
export type WorkerTunnelStopReason = "provider-destroying" | "provider-destroyed";

export type WorkerWorkspaceCommand = {
  argv: readonly string[];
  transportRetry: "idempotent" | "never";
  /** Local owner guard revalidated after transport awaits, immediately before dispatch. */
  assertCurrent?: () => void;
  onDispatchReady?: () => void;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  transfer?: NodeWorkerWorkspaceTransferInput;
  seed?: NodeWorkerWorkspaceSeedInput;
};

export type WorkerWorkspaceSyncRequest = {
  localPath: string;
  sessionId: string;
  generation: number;
  gitAuthor?: { name?: string; email?: string };
  /** Immutable project identity from the owning environment's provisioning snapshot. */
  projectKey?: string;
};

export type WorkerWorkspaceSyncResult = {
  mode: "git" | "plain";
  remoteWorkspaceDir: string;
  manifestRef: string;
};

export type WorkerWorkspaceReconcileRequest = {
  localPath: string;
  remoteWorkspaceDir: string;
  baseManifestRef: string;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
  stagedResult?: {
    ref: string;
    record(ref: string): void;
  };
};

export type WorkerWorkspaceReconcileResult = {
  manifestRef: string;
  changed: boolean;
  /** Re-read the remote workspace after local acceptance, immediately before teardown. */
  verifyStable(): Promise<void>;
  /** Re-read the accepted local result after the remote stability fence. */
  verifyLocalStable(): Promise<void>;
  /** Apply the prepared candidate locally without making it restart-authoritative. */
  applyPreparedStagedResult?(): Promise<void>;
  /** Return the accepted local manifest and any keep-local conflicts after apply. */
  getAppliedWorkspaceResult?(): WorkerWorkspaceApplyResult | undefined;
  /** Publish the verified candidate for restart recovery. */
  publishStagedResult?(): Promise<void>;
  discardPreparedStagedResult?(): Promise<void>;
};

export type WorkerWorkspaceQuiescence = {
  /** Prove the watchdog lease still owns stopped processes and extend it through teardown. */
  assertActive(): Promise<void>;
  /** Resume only the remote processes stopped by this quiescence owner. */
  resume(): Promise<void>;
};

type WorkerTurnLaunchRequest = {
  plan: WorkerLaunchPlan;
  turnClaim: WorkerSessionTurnClaim;
  timeoutMs?: number;
  // Expiry of the minted admission credential; launch adapters cap admission
  // re-arms so no advertised retry can outlive it.
  credentialExpiresAtMs?: number;
  signal?: AbortSignal;
  onDispatchReady?: () => void;
};

export type WorkerWorkspaceTunnelHandle = {
  environmentId: string;
  ownerEpoch: number;
  launchTurn?: never;
  measureLaunchTurn?: never;
  runWorkspaceCommand(command: WorkerWorkspaceCommand): Promise<SpawnResult>;
  stageAttachments?(request: {
    localPath: string;
    isAuthorized: () => boolean;
    signal: AbortSignal;
  }): Promise<void>;
  quiesceWorkspace(remoteWorkspaceDir: string): Promise<WorkerWorkspaceQuiescence>;
  syncWorkspace(request: WorkerWorkspaceSyncRequest): Promise<WorkerWorkspaceSyncResult>;
  reconcileWorkspace(
    request: WorkerWorkspaceReconcileRequest,
  ): Promise<WorkerWorkspaceReconcileResult>;
  stop(): Promise<void>;
};

export type WorkerTurnTunnelHandle = Omit<
  WorkerWorkspaceTunnelHandle,
  "launchTurn" | "measureLaunchTurn"
> & {
  measureLaunchTurn(plan: WorkerLaunchPlan, claim: WorkerSessionTurnClaim): number;
  launchTurn(request: WorkerTurnLaunchRequest): Promise<SpawnResult>;
};

export type WorkerTunnelHandle = WorkerWorkspaceTunnelHandle | WorkerTurnTunnelHandle;
