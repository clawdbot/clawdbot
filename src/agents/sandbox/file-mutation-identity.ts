import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

export async function resolveSandboxFileMutationQueueKey(params: {
  bridge: SandboxFsBridge;
  root: string;
  filePath: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  let identity: string;
  if (params.bridge.resolveFileIdentity) {
    identity = await params.bridge.resolveFileIdentity({
      filePath: params.filePath,
      cwd: params.cwd,
      signal: params.signal,
    });
  } else {
    // Shipped plugin bridges may predate physical identity support. Their resolved bridge path
    // preserves the prior SDK contract while current bridges canonicalize aliases.
    const resolved = params.bridge.resolvePath({ filePath: params.filePath, cwd: params.cwd });
    identity = resolved.hostPath
      ? resolveIdentityPathViaExistingAncestorSync(resolved.hostPath)
      : resolved.containerPath;
  }
  return `${params.root}\0${identity}`;
}
