/**
 * Sandbox workspace mount argument builder.
 *
 * Creates Docker bind specs for writable workspaces and read-only skill source mounts.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDirectoryWithinRoot } from "../../infra/fs-safe-advanced.js";
import { isPathInside } from "../../infra/path-guards.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { isPathInsideContainerRoot, normalizeContainerPathCore } from "./path-utils.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 4;
const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS = [".openclaw", "sandbox-skills"] as const;

/** Managed skill directory projected read-only into the sandbox workspace. */
export type ReadOnlyWorkspaceSkillMount = {
  hostPath: string;
  containerPath: string;
};

/** Keep managed overlay mountpoints removable by the workspace's host owner. */
export async function prepareWorkspaceSkillMountpoints(
  workspaceDir: string,
  workdir: string,
  mounts: readonly ReadOnlyWorkspaceSkillMount[],
  binds?: readonly string[],
): Promise<void> {
  if (mounts.length === 0) {
    return;
  }
  const overlayTargets = resolveProtectedSkillMountContainerPaths(mounts);
  const parents = filterBindsConflictingWithProtectedMounts(binds, overlayTargets).flatMap(
    (bind) => {
      const spec = splitSandboxBindSpec(bind);
      return spec
        ? [{ host: spec.host, container: normalizeMountContainerPath(spec.container) }]
        : [];
    },
  );
  const seenParents = new Set<string>();
  for (const parent of parents) {
    if (!mounts.some((mount) => isPathInsideContainerRoot(parent.container, mount.containerPath))) {
      continue;
    }
    if (seenParents.has(parent.container)) {
      throw new Error(
        `Sandbox skill mountpoint has duplicate parent binds at ${JSON.stringify(parent.container.slice(0, 160))}. Remove the duplicate bind before retrying.`,
      );
    }
    seenParents.add(parent.container);
  }
  // Custom binds precede the workspace at equal depth, as in the mount resolver.
  parents.push({ host: workspaceDir, container: normalizeMountContainerPath(workdir) });
  parents.sort((a, b) => b.container.length - a.container.length);
  const neededTargets = new Set(overlayTargets);
  const destinations = [];
  // Visit the whole containing bind chain: each parent may itself need a
  // mountpoint in another host-backed bind, including above the workdir.
  for (const target of neededTargets) {
    const parent = parents.find(
      (entry) => entry.container !== target && isPathInsideContainerRoot(entry.container, target),
    );
    if (!parent) {
      if (overlayTargets.has(target)) {
        throw new Error("Sandbox skill mountpoint has no containing workspace bind.");
      }
      continue; // The outermost bind attaches to the container image, not a host source.
    }
    destinations.push({ parent, requestedPath: path.posix.relative(parent.container, target) });
    neededTargets.add(parent.container);
  }
  for (const { parent, requestedPath } of destinations) {
    // Even for a read-only container bind, the gateway prepares missing host
    // directories so rootful engines do not create them as root. Never follow
    // symlinks in the suffix or repair existing ownership.
    const rootDir = await fs.promises.realpath(parent.host);
    const result = await ensureDirectoryWithinRoot({
      rootDir,
      requestedPath,
      scopeLabel: "sandbox workspace skill mountpoints",
    });
    if (!result.ok) {
      throw new Error(
        `${result.error} Required mountpoint ${JSON.stringify(requestedPath.slice(0, 160))} is beneath container bind ${JSON.stringify(parent.container.slice(0, 160))}. Move conflicting files or links aside before retrying.`,
      );
    }
  }
}

function formatManagedWorkspaceBind(params: {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}): string {
  return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
}

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function normalizeMountContainerPath(containerPath: string): string {
  return normalizeContainerPathCore(containerPath).replace(/\/+$/, "") || "/";
}

/** Hidden workspace used to materialize non-workspace skills for rw sandboxes. */
export function resolveMaterializedSandboxSkillsWorkspaceDir(rootDir: string): string {
  return path.join(rootDir, ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS);
}

/** Returns true when a skill mount source exists inside the canonical mount root. */
function isExistingWorkspaceSkillMountSource(params: {
  rootDir: string;
  hostPath: string;
}): boolean {
  try {
    if (!fs.lstatSync(params.hostPath).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  const agentRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(params.rootDir));
  const canonicalSource = resolveSandboxHostPathViaExistingAncestor(path.resolve(params.hostPath));
  return isPathInside(agentRoot, canonicalSource);
}

/** Protects managed skills inside writable shared or private sandbox workspaces. */
export function resolveReadOnlyWorkspaceSkillMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}): ReadOnlyWorkspaceSkillMount[] {
  if (params.workspaceAccess === "ro") {
    return [];
  }

  // Private workspaces protect their own synced instructions, never mount the
  // shared agent workspace merely to obtain its skill sources.
  const rootDir =
    params.workspaceAccess === "none" ? params.workspaceDir : params.agentWorkspaceDir;
  const mounts = [
    {
      hostPath: path.join(rootDir, "skills"),
      containerPath: containerJoin(params.workdir, "skills"),
      rootDir,
    },
    {
      hostPath: path.join(rootDir, ".agents", "skills"),
      containerPath: containerJoin(params.workdir, ".agents", "skills"),
      rootDir,
    },
  ];
  if (params.workspaceAccess === "rw") {
    const materializedSkillsWorkspaceDir =
      params.skillsWorkspaceDir ?? resolveMaterializedSandboxSkillsWorkspaceDir(rootDir);
    mounts.push({
      hostPath: path.join(materializedSkillsWorkspaceDir, "skills"),
      containerPath: containerJoin(
        params.workdir,
        ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS,
        "skills",
      ),
      rootDir: materializedSkillsWorkspaceDir,
    });
  }

  return mounts
    .filter((mount) =>
      isExistingWorkspaceSkillMountSource({
        rootDir: mount.rootDir,
        hostPath: mount.hostPath,
      }),
    )
    .map(({ hostPath, containerPath }) => ({ hostPath, containerPath }));
}

/** Returns stable mount state for sandbox config hashes. */
export function formatReadOnlyWorkspaceSkillMountHashState(
  mounts: readonly ReadOnlyWorkspaceSkillMount[],
): string[] {
  return mounts.map((mount) => `${mount.hostPath}:${mount.containerPath}:ro`);
}

/**
 * Returns the set of container paths that are protected by read-only skill mounts.
 *
 * User-defined binds that target any path in this set must be skipped so the
 * container engine sees one authoritative read-only mount for each destination.
 */
export function resolveProtectedSkillMountContainerPaths(
  mounts: readonly ReadOnlyWorkspaceSkillMount[],
): Set<string> {
  return new Set(mounts.map((mount) => normalizeMountContainerPath(mount.containerPath)));
}

/**
 * Returns a filtered copy of `binds` with entries whose container path conflicts with a
 * protected skill mount removed. Protected skill mounts always take precedence so checked-in
 * skills cannot be made writable by a user bind.
 */
export function filterBindsConflictingWithProtectedMounts(
  binds: readonly string[] | undefined,
  protectedContainerPaths: ReadonlySet<string>,
): string[] {
  if (!binds?.length) {
    return [];
  }
  if (protectedContainerPaths.size === 0) {
    return [...binds];
  }
  const filtered: string[] = [];
  for (const bind of binds) {
    const spec = splitSandboxBindSpec(bind);
    if (!spec) {
      filtered.push(bind);
      continue;
    }
    const containerPath = normalizeMountContainerPath(spec.container);
    if (!protectedContainerPaths.has(containerPath)) {
      filtered.push(bind);
    }
  }
  return filtered;
}

/** Appends Docker `-v` args for read-only skill mounts. */
export function appendReadOnlyWorkspaceSkillMountArgs(params: {
  args: string[];
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
}): void {
  for (const mount of params.readOnlyWorkspaceSkillMounts) {
    params.args.push(
      "-v",
      formatManagedWorkspaceBind({
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
        readOnly: true,
      }),
    );
  }
}

/** Appends Docker workspace mount args for the project, agent workspace, and skill overlays. */
export function appendWorkspaceMountArgs(params: {
  args: string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  readOnlyWorkspaceSkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
  includeReadOnlyWorkspaceSkillMounts?: boolean;
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  args.push(
    "-v",
    formatManagedWorkspaceBind({
      hostPath: workspaceDir,
      containerPath: workdir,
      readOnly: workspaceAccess === "ro",
    }),
  );

  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    args.push(
      "-v",
      formatManagedWorkspaceBind({
        hostPath: agentWorkspaceDir,
        containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
        readOnly: workspaceAccess === "ro",
      }),
    );
  }

  if (params.includeReadOnlyWorkspaceSkillMounts !== false) {
    appendReadOnlyWorkspaceSkillMountArgs({
      args,
      readOnlyWorkspaceSkillMounts:
        params.readOnlyWorkspaceSkillMounts ??
        resolveReadOnlyWorkspaceSkillMounts({
          workspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir: params.skillsWorkspaceDir,
          workdir,
          workspaceAccess,
        }),
    });
  }
}
