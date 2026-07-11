/**
 * Sandbox workspace mount argument builder.
 *
 * Creates Docker bind specs for writable workspaces and read-only skill source mounts.
 */
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 3;
const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS = [".openclaw", "sandbox-skills"] as const;

/** Read-only skill directory mounted from the agent workspace into the sandbox workspace. */
export type ReadOnlyWorkspaceSkillMount = {
  hostPath: string;
  containerPath: string;
};

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

/** Hidden workspace used to materialize non-workspace skills for rw sandboxes. */
export function resolveMaterializedSandboxSkillsWorkspaceDir(rootDir: string): string {
  return path.join(rootDir, ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS);
}

/** Returns true when a skill mount source exists inside the canonical mount root. */
export function isExistingWorkspaceSkillMountSource(params: {
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

/** Finds agent-workspace skill directories that should be mounted read-only in rw workspaces. */
export function resolveReadOnlyWorkspaceSkillMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}): ReadOnlyWorkspaceSkillMount[] {
  if (params.workspaceAccess !== "rw") {
    return [];
  }

  // RW workspaces mount the project as writable, but skill sources remain read-only so agent
  // instructions are visible without letting sandbox commands mutate them.
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
      readOnly: workspaceAccess !== "rw",
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
