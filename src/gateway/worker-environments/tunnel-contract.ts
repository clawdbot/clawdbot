import type { SpawnResult } from "../../process/exec.js";

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

export type WorkerTunnelHandle = {
  environmentId: string;
  ownerEpoch: number;
  remoteSocketPath: string;
  runWorkspaceCommand(command: WorkerWorkspaceCommand): Promise<SpawnResult>;
  syncWorkspace(request: WorkerWorkspaceSyncRequest): Promise<WorkerWorkspaceSyncResult>;
  stop(): Promise<void>;
};
