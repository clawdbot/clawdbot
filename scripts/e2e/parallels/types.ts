export type Provider = "openai" | "anthropic" | "minimax";
export type Mode = "fresh" | "upgrade" | "both";
export type Platform = "macos" | "windows" | "linux";

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  check?: boolean;
  quiet?: boolean;
}

export interface ProviderAuth {
  authChoice: string;
  authKeyFlag: string;
  apiKeyEnv: string;
  apiKeyValue: string;
  modelId: string;
}

export interface SnapshotInfo {
  id: string;
  state: string;
  name: string;
}

export interface PackageArtifact {
  path: string;
  version?: string;
  buildCommit?: string;
  buildCommitShort?: string;
}

export interface HostServer {
  hostIp: string;
  port: number;
  urlFor(filePath: string): string;
  stop(): Promise<void>;
}
