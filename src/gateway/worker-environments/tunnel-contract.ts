import type { SpawnResult } from "../../process/exec.js";
import type { WorkerWorkspaceReconciliationJournalAdapter } from "./workspace-reconcile.js";

export type WorkerTunnelStatus = "stopped" | "connecting" | "connected" | "reconnecting";

export type WorkerTunnelRequest = {
  environmentId: string;
  ownerEpoch: number;
};

export type WorkerWorkspaceCommand = {
  argv: readonly string[];
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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

export type WorkerTunnelHandle = {
  environmentId: string;
  ownerEpoch: number;
  remoteSocketPath: string;
  runWorkspaceCommand(command: WorkerWorkspaceCommand): Promise<SpawnResult>;
  quiesceWorkspace(remoteWorkspaceDir: string): Promise<WorkerWorkspaceQuiescence>;
  syncWorkspace(request: WorkerWorkspaceSyncRequest): Promise<WorkerWorkspaceSyncResult>;
  reconcileWorkspace(
    request: WorkerWorkspaceReconcileRequest,
  ): Promise<WorkerWorkspaceReconcileResult>;
  stop(): Promise<void>;
};
