// Decides which existing workspace files an adopting Claw add may claim without rewriting them.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { FsSafeError, root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import type { ClawAddCapabilityChange, ClawAddPlanAction, ClawDiagnostic } from "./types.js";

type AdoptionPendingFile = {
  action: ClawAddPlanAction;
  manifestPath: string;
};

type AdoptableTargetState =
  | { state: "absent" }
  | { state: "unsafe" }
  | { state: "adoptable"; digest: string };

type WorkspaceDiskState =
  | { state: "absent" }
  | { state: "uninspectable" }
  | { state: "present"; isDirectory: boolean };

// Only ENOENT proves absence. Permission, symlink-loop, and IO failures leave the path unknown, and
// planning must not read unknown as free space: apply already refuses an uninspectable workspace
// (`workspace_parent_failed` in add.ts), so a plan that approves one strands the operator mid-install.
async function readWorkspaceDiskState(workspace: string): Promise<WorkspaceDiskState> {
  try {
    return { state: "present", isDirectory: (await lstat(workspace)).isDirectory() };
  } catch (error) {
    const absent =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return absent ? { state: "absent" } : { state: "uninspectable" };
  }
}

function adoptionBlocker(path: string, message: string): ClawDiagnostic {
  return { level: "error", code: "workspace_file_conflict", phase: "plan", path, message };
}

/** Describes the distinct consent required to claim an existing workspace directory. */
export function workspaceAdoptionCapabilityChange(
  agentId: string,
  workspace: string,
): Omit<ClawAddCapabilityChange, "classification" | "requiresDistinctConsent" | "digest"> {
  return {
    kind: "agent",
    id: agentId,
    path: "workspace",
    action: "configure",
    reason:
      "The Claw adopts an existing workspace directory; declared files must already match or be absent.",
    effect: { workspace, adoptExistingWorkspace: true },
  };
}

/** Plans the workspace-level adoption decision before declared files are inspected. */
export async function planWorkspaceAdoption(params: {
  agentId: string;
  workspace: string;
  requested: boolean;
  configuredWorkspaceConflict: boolean;
  configuredWorkspaceConflictCode?: "workspace_collision" | "agent_workspace_conflict";
  resumableWorkspace?: string;
}): Promise<{
  adopted: boolean;
  action: ClawAddPlanAction;
  blockers: ClawDiagnostic[];
}> {
  const disk = await readWorkspaceDiskState(params.workspace);
  if (disk.state === "uninspectable") {
    const message = `Workspace ${JSON.stringify(params.workspace)} cannot be inspected; adoption requires a workspace path this account can read.`;
    return {
      adopted: false,
      blockers: [
        {
          level: "error",
          code: "workspace_parent_failed",
          phase: "plan",
          path: "$.workspace",
          message,
        },
      ],
      action: {
        kind: "workspace",
        id: params.agentId,
        action: "create",
        target: params.workspace,
        details: { expectedState: "uninspectable" },
        blocked: true,
        reason: message,
      },
    };
  }
  const workspaceExistsOnDisk = disk.state === "present";
  const adopted =
    params.requested &&
    disk.state === "present" &&
    disk.isDirectory &&
    !params.configuredWorkspaceConflict;
  const blocked =
    !adopted &&
    (params.configuredWorkspaceConflict ||
      (workspaceExistsOnDisk && params.resumableWorkspace !== params.workspace));
  const blockers: ClawDiagnostic[] = [];
  if (blocked) {
    blockers.push({
      level: "error",
      code: params.configuredWorkspaceConflictCode ?? "workspace_collision",
      phase: "plan",
      path: "$.workspace",
      message:
        params.requested && workspaceExistsOnDisk
          ? `Workspace ${JSON.stringify(params.workspace)} cannot be adopted; it is ${
              params.configuredWorkspaceConflict
                ? "already configured for another agent"
                : "not a directory"
            }.`
          : `Workspace ${JSON.stringify(params.workspace)} already exists; a Claw requires a new workspace.`,
    });
  }
  return {
    adopted,
    blockers,
    action: {
      kind: "workspace",
      id: params.agentId,
      action: adopted ? "adopt" : "create",
      target: params.workspace,
      details: { expectedState: adopted ? "existing-directory" : "absent" },
      blocked,
      ...(blocked
        ? { reason: `Workspace ${JSON.stringify(params.workspace)} already exists.` }
        : {}),
    },
  };
}

// Planning reads adoptable destinations through the same safe-file contract the mutation path
// uses. A destination only apply would reject (symlink, hardlink, oversized) has to block before
// consent, or apply commits the agent config first and leaves the operator a partial install.
async function readAdoptableTarget(
  workspaceRoot: Root,
  targetPath: string,
): Promise<AdoptableTargetState> {
  try {
    const read = await workspaceRoot.read(targetPath, {
      hardlinks: "reject",
      maxBytes: MAX_MANAGED_FILE_BYTES,
      symlinks: "reject",
    });
    return {
      state: "adoptable",
      digest: `sha256:${createHash("sha256").update(read.buffer).digest("hex")}`,
    };
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return { state: "absent" };
    }
    return { state: "unsafe" };
  }
}

/**
 * Marks every declared file that already exists with identical content as an `adopt` action and
 * blocks the rest. Mutates the passed actions in place and returns the plan blockers to record.
 */
export async function planWorkspaceAdoptionTargets(params: {
  workspace: string;
  pendingFiles: readonly AdoptionPendingFile[];
  packageBootstrap?: ClawAddPlanAction;
}): Promise<ClawDiagnostic[]> {
  const workspaceRoot = await fsSafeRoot(params.workspace);
  const blockers: ClawDiagnostic[] = [];
  if (params.packageBootstrap && !params.packageBootstrap.blocked) {
    const existing = await readAdoptableTarget(workspaceRoot, params.packageBootstrap.id);
    if (existing.state !== "absent") {
      const diagnostic = adoptionBlocker(
        "$packageBootstrap",
        existing.state === "unsafe"
          ? `Package BOOTSTRAP.md destination ${JSON.stringify(params.packageBootstrap.target)} must be absent; the existing path is not a safe regular file.`
          : `Package BOOTSTRAP.md destination ${JSON.stringify(params.packageBootstrap.target)} already exists; adoption never claims operator-owned native bootstrap content.`,
      );
      params.packageBootstrap.blocked = true;
      params.packageBootstrap.reason = diagnostic.message;
      blockers.push(diagnostic);
    }
  }
  for (const pending of params.pendingFiles) {
    if (pending.action.blocked || !pending.action.digest) {
      continue;
    }
    const existing = await readAdoptableTarget(workspaceRoot, pending.action.id);
    if (existing.state === "absent") {
      continue;
    }
    if (existing.state === "adoptable" && existing.digest === pending.action.digest) {
      pending.action.action = "adopt";
      pending.action.details = { ...pending.action.details, expectedState: "existing-identical" };
      continue;
    }
    const diagnostic = adoptionBlocker(
      pending.manifestPath,
      existing.state === "unsafe"
        ? `Adoptable workspace destination ${JSON.stringify(pending.action.target)} must be a readable regular file inside the workspace, with no symlink or hardlink, within managed size limits.`
        : `Workspace destination ${JSON.stringify(pending.action.target)} exists with different content; adoption never overwrites existing files.`,
    );
    pending.action.blocked = true;
    pending.action.reason = diagnostic.message;
    blockers.push(diagnostic);
  }
  return blockers;
}
