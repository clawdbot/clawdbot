// Openshell type declarations define plugin contracts.
import type { RemoteShellSandboxHandle, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";

export type OpenShellFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

export type OpenShellSandboxBackend = SandboxBackendHandle &
  RemoteShellSandboxHandle & {
    mode: "mirror" | "remote";
    mkdirpRemotePath(remotePath: string, signal?: AbortSignal): Promise<void>;
    removeRemotePath(
      remotePath: string,
      params?: {
        recursive?: boolean;
        signal?: AbortSignal;
        ignoreMissing?: boolean;
      },
    ): Promise<void>;
    renameRemotePath(
      fromRemotePath: string,
      toRemotePath: string,
      signal?: AbortSignal,
    ): Promise<void>;
    syncLocalPathToRemote(localPath: string, remotePath: string): Promise<void>;
  };
