/** Pure mount and path helpers for the remote sandbox filesystem bridge. */
import path from "node:path";
import { normalizeContainerPath as normalizeSandboxContainerPath } from "./path-utils.js";
import {
  isExistingWorkspaceSkillMountSource,
  resolveMaterializedSandboxSkillsWorkspaceDir,
} from "./workspace-mounts.js";

export type RemoteMountSource = "workspace" | "agent" | "protectedSkill";

export type RemoteMountInfo = {
  localRoot: string;
  containerRoot: string;
  writable: boolean;
  source: RemoteMountSource;
};

export function buildRemoteProtectedSkillMounts(params: {
  localRoot: string;
  skillsWorkspaceDir?: string;
  workspaceContainerRoot: string;
  agentContainerRoot: string;
  includeAgentMount: boolean;
}): RemoteMountInfo[] {
  const materializedSkillsWorkspaceDir = path.resolve(
    params.skillsWorkspaceDir ?? resolveMaterializedSandboxSkillsWorkspaceDir(params.localRoot),
  );
  const mounts: Array<RemoteMountInfo & { allowedRoot: string }> = [
    {
      localRoot: path.join(params.localRoot, "skills"),
      containerRoot: path.posix.join(params.workspaceContainerRoot, "skills"),
      writable: false,
      source: "protectedSkill",
      allowedRoot: params.localRoot,
    },
    {
      localRoot: path.join(params.localRoot, ".agents", "skills"),
      containerRoot: path.posix.join(params.workspaceContainerRoot, ".agents", "skills"),
      writable: false,
      source: "protectedSkill",
      allowedRoot: params.localRoot,
    },
    {
      localRoot: path.join(materializedSkillsWorkspaceDir, "skills"),
      containerRoot: path.posix.join(
        params.workspaceContainerRoot,
        ".openclaw",
        "sandbox-skills",
        "skills",
      ),
      writable: false,
      source: "protectedSkill",
      allowedRoot: materializedSkillsWorkspaceDir,
    },
  ];
  if (params.includeAgentMount) {
    mounts.push(
      {
        localRoot: path.join(params.localRoot, "skills"),
        containerRoot: path.posix.join(params.agentContainerRoot, "skills"),
        writable: false,
        source: "protectedSkill",
        allowedRoot: params.localRoot,
      },
      {
        localRoot: path.join(params.localRoot, ".agents", "skills"),
        containerRoot: path.posix.join(params.agentContainerRoot, ".agents", "skills"),
        writable: false,
        source: "protectedSkill",
        allowedRoot: params.localRoot,
      },
      {
        localRoot: path.join(materializedSkillsWorkspaceDir, "skills"),
        containerRoot: path.posix.join(
          params.agentContainerRoot,
          ".openclaw",
          "sandbox-skills",
          "skills",
        ),
        writable: false,
        source: "protectedSkill",
        allowedRoot: materializedSkillsWorkspaceDir,
      },
    );
  }
  return mounts
    .filter((mount) =>
      isExistingWorkspaceSkillMountSource({
        rootDir: mount.allowedRoot,
        hostPath: mount.localRoot,
      }),
    )
    .map(({ allowedRoot: _allowedRoot, ...mount }) => mount);
}

export function compareRemoteMountsByContainerPath(a: RemoteMountInfo, b: RemoteMountInfo): number {
  return b.containerRoot.length - a.containerRoot.length || mountPriority(b) - mountPriority(a);
}

export function compareRemoteMountsByLocalPath(a: RemoteMountInfo, b: RemoteMountInfo): number {
  return b.localRoot.length - a.localRoot.length || mountPriority(b) - mountPriority(a);
}

function mountPriority(mount: RemoteMountInfo): number {
  if (mount.source === "protectedSkill") {
    return 2;
  }
  if (mount.source === "agent") {
    return 1;
  }
  return 0;
}

export function normalizeContainerPath(value: string): string {
  const normalized = normalizeSandboxContainerPath(value.trim() || "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}
