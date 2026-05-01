import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxContext } from "../sandbox.js";
import type { SandboxFsBridge, SandboxResolvedPath } from "../sandbox/fs-bridge.js";
import { createSandboxFsBridgeFromResolver } from "./host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "./pi-tools-sandbox-context.js";

function createUnsafeMountedBridge(params: {
  root: string;
  agentHostRoot: string;
  workspaceContainerRoot?: string;
}): SandboxFsBridge {
  const root = path.resolve(params.root);
  const agentHostRoot = path.resolve(params.agentHostRoot);
  const workspaceContainerRoot = params.workspaceContainerRoot ?? "/workspace";

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    // Intentionally unsafe: simulate a sandbox FS bridge that maps /agent/* into a host path
    // outside the workspace root (e.g. an operator-configured bind mount).
    const hostPath =
      filePath === "/agent" || filePath === "/agent/" || filePath.startsWith("/agent/")
        ? path.join(
            agentHostRoot,
            filePath === "/agent" || filePath === "/agent/" ? "" : filePath.slice("/agent/".length),
          )
        : path.isAbsolute(filePath)
          ? filePath
          : path.resolve(cwd ?? root, filePath);

    const relFromRoot = path.relative(root, hostPath);
    const relativePath =
      relFromRoot && !relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot)
        ? relFromRoot.split(path.sep).filter(Boolean).join(path.posix.sep)
        : filePath.replace(/\\/g, "/");

    const containerPath = filePath.startsWith("/")
      ? filePath.replace(/\\/g, "/")
      : relativePath
        ? path.posix.join(workspaceContainerRoot, relativePath)
        : workspaceContainerRoot;

    return { hostPath, relativePath, containerPath };
  };

  return createSandboxFsBridgeFromResolver(resolvePath);
}

export function createUnsafeMountedSandbox(params: {
  sandboxRoot: string;
  agentRoot: string;
  workspaceContainerRoot?: string;
}): SandboxContext {
  const bridge = createUnsafeMountedBridge({
    root: params.sandboxRoot,
    agentHostRoot: params.agentRoot,
    workspaceContainerRoot: params.workspaceContainerRoot,
  });
  return createPiToolsSandboxContext({
    workspaceDir: params.sandboxRoot,
    agentWorkspaceDir: params.agentRoot,
    workspaceAccess: "rw",
    fsBridge: bridge,
    tools: { allow: [], deny: [] },
  });
}

export async function withUnsafeMountedSandboxHarness(
  run: (ctx: { sandboxRoot: string; agentRoot: string; sandbox: SandboxContext }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-mounts-"));
  const sandboxRoot = path.join(stateDir, "sandbox");
  const agentRoot = path.join(stateDir, "agent");
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.mkdir(agentRoot, { recursive: true });
  const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot });
  try {
    await run({ sandboxRoot, agentRoot, sandbox });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
