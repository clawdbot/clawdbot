import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import type { SandboxResolvedPath } from "./fs-bridge.types.js";
import type { RemoteMountSource } from "./remote-fs-bridge-paths.js";

export type ResolvedRemotePath = SandboxResolvedPath & {
  writable: boolean;
  mountRootPath: string;
  source: RemoteMountSource;
};

/** Minimal remote shell contract used by the SSH filesystem bridge. */
export type RemoteShellSandboxHandle = {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
};
