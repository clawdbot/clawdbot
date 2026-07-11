import type { SpawnResult } from "../../process/exec.js";

export type WorkerTunnelStatus = "stopped" | "connecting" | "connected" | "reconnecting";

export type WorkerTunnelRequest = {
  environmentId: string;
  ownerEpoch: number;
  gateway: { host: "127.0.0.1" | "::1"; port: number };
};

export type WorkerWorkspaceCommand = {
  argv: readonly string[];
  input?: string;
  timeoutMs?: number;
};

export type WorkerTunnelHandle = {
  environmentId: string;
  ownerEpoch: number;
  remoteSocketPath: string;
  runWorkspaceCommand(command: WorkerWorkspaceCommand): Promise<SpawnResult>;
  stop(): Promise<void>;
};
