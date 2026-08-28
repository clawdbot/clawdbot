import fs from "node:fs";
import path from "node:path";
import { err, ok } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import { managedWorktrees, WorktreeRepositoryError } from "../agents/worktrees/service.js";
import type { CreateManagedWorktreeParams } from "../agents/worktrees/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { prepareWorktreeSessionTitle } from "./dashboard-session-title.js";
import type { PrepareGatewaySessionLifecycle } from "./session-lifecycle-preparation.js";

/** One worktree preparation owner for synchronous creation and admitted first turns. */
export async function prepareSessionWorktree(params: {
  target: Parameters<PrepareGatewaySessionLifecycle>[0];
  workspace: string;
  name?: string;
  baseRef?: string;
  label?: string;
  title?: ReturnType<typeof prepareWorktreeSessionTitle>;
  runSetupScript: boolean;
  signal?: AbortSignal;
  commitGuard?: () => void;
  onProgress?: CreateManagedWorktreeParams["onProgress"];
}): ReturnType<PrepareGatewaySessionLifecycle> {
  const { target, workspace, title, commitGuard } = params;
  try {
    const repository = await managedWorktrees.resolveRepositoryPaths(workspace);
    commitGuard?.();
    const boundId = normalizeOptionalString(target.entry?.worktree?.id);
    let existing = boundId ? managedWorktrees.findLiveById(boundId) : undefined;
    if (existing && (existing.ownerKind !== "session" || existing.ownerId !== target.key)) {
      return err(
        errorShape(ErrorCodes.UNAVAILABLE, "session worktree binding has a different owner"),
      );
    }
    existing ??= managedWorktrees.findLiveByOwner("session", target.key);
    let existingDirectory = false;
    if (existing) {
      try {
        existingDirectory = fs.lstatSync(existing.path).isDirectory();
      } catch {
        // Missing registry targets are replaced by create() under its owner lease.
      }
    }
    if (existing && existingDirectory) {
      if (existing.repoRoot !== repository.canonicalRoot) {
        return err(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "session worktree belongs to a different repository",
          ),
        );
      }
      if ((params.name && existing.name !== params.name) || (params.baseRef && boundId)) {
        return err(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `session is already bound to worktree ${existing.name} (${existing.branch})`,
          ),
        );
      }
    }
    const generatedTitle = existingDirectory ? undefined : await title?.generated;
    commitGuard?.();
    const worktree =
      existing && existingDirectory
        ? existing
        : await managedWorktrees.create({
            repoRoot: workspace,
            ownerKind: "session",
            ownerId: target.key,
            name: params.name,
            suggestedName: slugifyWorktreeTitle(
              params.label ?? generatedTitle ?? title?.source ?? "",
            ),
            baseRef: params.baseRef,
            runSetupScript: params.runSetupScript,
            signal: params.signal,
            commitGuard,
            onProgress: params.onProgress,
          });
    const rollback = existingDirectory
      ? undefined
      : async () => {
          await managedWorktrees.remove({
            id: worktree.id,
            reason: "session-create-failed",
            allowSnapshotLoss: true,
          });
        };
    try {
      commitGuard?.();
      // A nested source workspace keeps its relative cwd inside the new checkout.
      let spawnedCwd = worktree.path;
      const relative = path.relative(repository.sourceRoot, fs.realpathSync(workspace));
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        spawnedCwd = path.join(worktree.path, relative);
        fs.mkdirSync(spawnedCwd, { recursive: true });
      }
      return ok({
        spawnedCwd,
        sessionRoot: fs.realpathSync(worktree.path),
        worktree: {
          id: worktree.id,
          branch: worktree.branch,
          repoRoot: worktree.repoRoot,
          canonicalWorkspaceDir: workspace,
        },
        ...(rollback ? { rollback } : {}),
      });
    } catch (error) {
      await rollback?.();
      throw error;
    }
  } catch (error) {
    // Closed delegated authority remains an exception for its admission owner.
    commitGuard?.();
    return err(
      errorShape(
        error instanceof WorktreeRepositoryError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
        error instanceof WorktreeRepositoryError
          ? "agent workspace is not a git checkout"
          : formatErrorMessage(error),
      ),
    );
  }
}
