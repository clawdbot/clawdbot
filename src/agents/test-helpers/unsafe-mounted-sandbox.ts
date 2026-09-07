/**
 * Unsafe sandbox mount fixture.
 *
 * Simulates a filesystem bridge that exposes host paths outside the workspace for boundary tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxContext } from "../sandbox.js";
import type { SandboxFsBridge, SandboxResolvedPath } from "../sandbox/fs-bridge.js";
import { createAgentToolsSandboxContext } from "./agent-tools-sandbox-context.js";
import { createSandboxFsBridgeFromResolver } from "./host-sandbox-fs-bridge.js";

function createUnsafeMountedBridge(params: {
  root: string;
  agentHostRoot: string;
  skillsHostRoot?: string;
  workspaceContainerRoot?: string;
}): SandboxFsBridge {
  const root = path.resolve(params.root);
  const agentHostRoot = path.resolve(params.agentHostRoot);
  const skillsHostRoot = params.skillsHostRoot ? path.resolve(params.skillsHostRoot) : undefined;
  const workspaceContainerRoot = params.workspaceContainerRoot ?? "/workspace";
  const skillsContainerRoot = path.posix.join(
    workspaceContainerRoot,
    ".openclaw",
    "sandbox-skills",
    "skills",
  );
  const skillsRelativeRoot = ".openclaw/sandbox-skills/skills";

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    const normalizedRelativePath = path.posix.normalize(filePath.replace(/\\/g, "/"));
    const skillsRelativePath =
      normalizedRelativePath === skillsRelativeRoot
        ? ""
        : normalizedRelativePath.startsWith(`${skillsRelativeRoot}/`)
          ? normalizedRelativePath.slice(skillsRelativeRoot.length + 1)
          : undefined;
    // Intentionally unsafe: simulate a sandbox FS bridge that maps /agent/* into a host path
    // outside the workspace root (e.g. an operator-configured bind mount).
    const hostPath =
      filePath === "/agent" || filePath === "/agent/" || filePath.startsWith("/agent/")
        ? path.join(
            agentHostRoot,
            filePath === "/agent" || filePath === "/agent/" ? "" : filePath.slice("/agent/".length),
          )
        : skillsHostRoot &&
            (filePath === skillsContainerRoot || filePath.startsWith(`${skillsContainerRoot}/`))
          ? path.join(skillsHostRoot, filePath.slice(skillsContainerRoot.length + 1))
          : skillsHostRoot && skillsRelativePath !== undefined
            ? path.join(skillsHostRoot, skillsRelativePath)
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
  skillsWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  workspaceContainerRoot?: string;
}): SandboxContext {
  const bridge = createUnsafeMountedBridge({
    root: params.sandboxRoot,
    agentHostRoot: params.agentRoot,
    skillsHostRoot: params.skillsWorkspaceDir
      ? path.join(params.skillsWorkspaceDir, "skills")
      : undefined,
    workspaceContainerRoot: params.workspaceContainerRoot,
  });
  return createAgentToolsSandboxContext({
    workspaceDir: params.sandboxRoot,
    agentWorkspaceDir: params.agentRoot,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workspaceAccess: params.workspaceAccess ?? "rw",
    fsBridge: bridge,
    tools: { allow: [], deny: [] },
  });
}

export async function withUnsafeMountedSandboxHarness(
  run: (ctx: {
    sandboxRoot: string;
    agentRoot: string;
    skillsWorkspaceDir?: string;
    sandbox: SandboxContext;
  }) => Promise<void>,
  options?: {
    includeSkillsWorkspace?: boolean;
    skillsWorkspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
  },
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-mounts-"));
  const sandboxRoot = path.join(stateDir, "sandbox");
  const agentRoot = path.join(stateDir, "agent");
  const skillsWorkspaceDir =
    options?.skillsWorkspaceDir ??
    (options?.includeSkillsWorkspace ? path.join(stateDir, "skills-state") : undefined);
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.mkdir(agentRoot, { recursive: true });
  const sandbox = createUnsafeMountedSandbox({
    sandboxRoot,
    agentRoot,
    skillsWorkspaceDir,
    workspaceAccess: options?.workspaceAccess,
  });
  try {
    await run({ sandboxRoot, agentRoot, skillsWorkspaceDir, sandbox });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
