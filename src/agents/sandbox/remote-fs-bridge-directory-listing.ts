import path from "node:path";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
import { parseSandboxDirectoryEntries } from "./fs-bridge.discovery.js";
import { relativePathEscapesContainerRoot } from "./path-utils.js";
import type { RemoteCanonicalPath } from "./remote-fs-bridge-canonical-path.js";
import type { ResolvedRemotePath } from "./remote-fs-bridge.types.js";

type RemoteDirectoryListingOwner = {
  resolveTarget(params: { filePath: string; cwd?: string }): ResolvedRemotePath;
  resolveCanonicalPath(params: {
    containerPath: string;
    mountRootPath: string;
    action: string;
    signal?: AbortSignal;
  }): Promise<RemoteCanonicalPath>;
  runMutation(params: {
    args: string[];
    signal?: AbortSignal;
  }): Promise<SandboxBackendCommandResult>;
};

export async function listRemoteSandboxDirectory(
  owner: RemoteDirectoryListingOwner,
  params: { filePath: string; cwd?: string; signal?: AbortSignal },
) {
  const target = owner.resolveTarget(params);
  const { canonicalPath, canonicalMountRoot } = await owner.resolveCanonicalPath({
    containerPath: target.containerPath,
    mountRootPath: target.mountRootPath,
    action: "list directories",
    signal: params.signal,
  });
  const relativePath = path.posix.relative(canonicalMountRoot, canonicalPath);
  if (relativePathEscapesContainerRoot(relativePath)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot list directories: ${target.containerPath}`,
    );
  }
  const result = await owner.runMutation({
    args: ["list", canonicalMountRoot, relativePath === "." ? "" : relativePath],
    signal: params.signal,
  });
  return parseSandboxDirectoryEntries(result.stdout);
}
