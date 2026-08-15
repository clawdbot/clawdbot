import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";

export type MxcWorkspaceAccess = "none" | "ro" | "rw";

export type MxcReadOnlySkillMount = {
  hostPath: string;
  containerPath: string;
};

const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS = [".openclaw", "sandbox-skills"] as const;

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function resolveMaterializedSandboxSkillsWorkspaceDir(rootDir: string): string {
  return path.join(rootDir, ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS);
}

function isExistingMxcSkillMountSource(params: { rootDir: string; hostPath: string }): boolean {
  try {
    if (!lstatSync(params.hostPath).isDirectory()) {
      return false;
    }
    return isPathInside(
      realpathSync(path.resolve(params.rootDir)),
      realpathSync(path.resolve(params.hostPath)),
    );
  } catch {
    return false;
  }
}

export function resolveMxcReadOnlySkillMounts(params: {
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: MxcWorkspaceAccess;
}): readonly MxcReadOnlySkillMount[] {
  if (params.workspaceAccess !== "rw") {
    return [];
  }

  const materializedSkillsWorkspaceDir =
    params.skillsWorkspaceDir ??
    resolveMaterializedSandboxSkillsWorkspaceDir(params.agentWorkspaceDir);
  const mounts = [
    {
      hostPath: path.join(params.agentWorkspaceDir, "skills"),
      containerPath: containerJoin(params.workdir, "skills"),
      rootDir: params.agentWorkspaceDir,
    },
    {
      hostPath: path.join(params.agentWorkspaceDir, ".agents", "skills"),
      containerPath: containerJoin(params.workdir, ".agents", "skills"),
      rootDir: params.agentWorkspaceDir,
    },
    {
      hostPath: path.join(materializedSkillsWorkspaceDir, "skills"),
      containerPath: containerJoin(
        params.workdir,
        ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS,
        "skills",
      ),
      rootDir: materializedSkillsWorkspaceDir,
    },
  ];

  return mounts
    .filter((mount) =>
      isExistingMxcSkillMountSource({
        rootDir: mount.rootDir,
        hostPath: mount.hostPath,
      }),
    )
    .map(({ hostPath, containerPath }) => ({ hostPath, containerPath }));
}
