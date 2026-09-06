/** Pure mount and path helpers for the remote sandbox filesystem bridge. */
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { isPathInsideContainerRoot, normalizeContainerPathCore } from "./path-utils.js";

export type RemoteMountSource = "workspace" | "agent" | "protectedSkill";

export type RemoteMountInfo = {
  localRoot: string;
  containerRoot: string;
  writable: boolean;
  source: RemoteMountSource;
};

export function resolveRemoteMountByContainerPath(
  mounts: RemoteMountInfo[],
  containerPath: string,
): RemoteMountInfo | null {
  return (
    mounts
      .toSorted(
        (a, b) =>
          b.containerRoot.length - a.containerRoot.length || mountPriority(b) - mountPriority(a),
      )
      .find((mount) => isPathInsideContainerRoot(mount.containerRoot, containerPath)) ?? null
  );
}

export function resolveRemoteMountByLocalPath(
  mounts: RemoteMountInfo[],
  localPath: string,
): RemoteMountInfo | null {
  return (
    mounts
      .toSorted(
        (a, b) => b.localRoot.length - a.localRoot.length || mountPriority(b) - mountPriority(a),
      )
      .find((mount) => isPathInside(mount.localRoot, localPath)) ?? null
  );
}

export function buildRemoteProtectedSkillRoots(params: {
  workspaceContainerRoot: string;
  agentContainerRoot: string;
  includeAgentMount: boolean;
}): string[] {
  const roots = [
    path.posix.join(params.workspaceContainerRoot, "skills"),
    path.posix.join(params.workspaceContainerRoot, ".agents", "skills"),
    path.posix.join(params.workspaceContainerRoot, ".openclaw", "sandbox-skills", "skills"),
  ];
  if (params.includeAgentMount) {
    roots.push(
      path.posix.join(params.agentContainerRoot, "skills"),
      path.posix.join(params.agentContainerRoot, ".agents", "skills"),
      path.posix.join(params.agentContainerRoot, ".openclaw", "sandbox-skills", "skills"),
    );
  }
  return roots;
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
  const normalized = normalizeContainerPathCore(value.trim() || "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}
