import type { WorkerTunnelStatus } from "@openclaw/gateway-protocol";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../../infra/node-commands.js";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import type { NodeWorkerWorkspaceTransferInput } from "../../worker/node-workspace-transfer-protocol.js";
import type {
  WorkerWorkspaceApplyResult,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-reconcile.js";

export type { WorkerTunnelStatus };

export class WorkerTunnelOwnerDisconnectedError extends Error {
  constructor() {
    super("Worker tunnel owner is no longer connected");
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

export class WorkerWorkspaceOperatorRecoveryError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "WorkerWorkspaceOperatorRecoveryError";
  }
}

export function findWorkerWorkspaceOperatorRecoveryError(
  error: unknown,
): WorkerWorkspaceOperatorRecoveryError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof WorkerWorkspaceOperatorRecoveryError) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

export type WorkerTunnelRequest = {
  environmentId: string;
  ownerEpoch: number;
};

export type WorkerRecoveryTunnelRequest = WorkerTunnelRequest & {
  workerBuild: "current" | "installed";
};

export type WorkerWorkspaceCommand = {
  argv: readonly string[];
  transportRetry: "idempotent" | "never";
  onDispatchReady?: () => void;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  transfer?: NodeWorkerWorkspaceTransferInput;
};

export type WorkerWorkspaceSyncRequest = {
  localPath: string;
  sessionId: string;
  generation: number;
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
  placementGeneration: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDispatchReady?: () => void;
};

export type WorkerTunnelHandle = {
  environmentId: string;
  ownerEpoch: number;
  launchTurn(request: WorkerTurnLaunchRequest): Promise<SpawnResult>;
  runWorkspaceCommand(command: WorkerWorkspaceCommand): Promise<SpawnResult>;
  quiesceWorkspace(remoteWorkspaceDir: string): Promise<WorkerWorkspaceQuiescence>;
  syncWorkspace(request: WorkerWorkspaceSyncRequest): Promise<WorkerWorkspaceSyncResult>;
  reconcileWorkspace(
    request: WorkerWorkspaceReconcileRequest,
  ): Promise<WorkerWorkspaceReconcileResult>;
  stop(): Promise<void>;
};

export type WorkerWorkspaceRecoveryTunnelHandle = Omit<WorkerTunnelHandle, "launchTurn">;
