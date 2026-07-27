import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  deleteClawWorkspaceFileRecord,
  readClawWorkspaceFiles,
  upsertClawWorkspaceFile,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

const MAX_UPDATE_FILE_BYTES = 1024 * 1024;

export type ClawWorkspaceUpdateExecution = {
  appliedPaths: string[];
  rollback: () => Promise<void>;
};

export class ClawWorkspaceUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawWorkspaceUpdateError";
  }
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function relativeWithin(root: string, target: string): string {
  const value = relative(root, target);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new ClawWorkspaceUpdateError(`Path ${JSON.stringify(target)} escapes its owned root.`);
  }
  return value;
}

export async function applyClawWorkspaceUpdate(
  updatePlan: ClawUpdatePlan,
  targetAddPlan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<ClawWorkspaceUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "workspaceFile" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedPaths: [], rollback: async () => undefined };
  }
  const workspaceRoot = resolve(targetAddPlan.agent.workspace);
  const packageRoot = resolve(targetAddPlan.claw.packageRoot);
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_UPDATE_FILE_BYTES,
    symlinks: "reject",
  });
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_UPDATE_FILE_BYTES,
    symlinks: "reject",
  });
  const currentRefs = new Map(
    readClawWorkspaceFiles(updatePlan.agentId, options).map((record) => [record.path, record]),
  );
  const targetActions = new Map(
    targetAddPlan.actions
      .filter((action) => action.kind === "workspaceFile")
      .map((action) => [action.id, action]),
  );
  const undo: Array<() => Promise<void>> = [];
  const appliedPaths: string[] = [];

  const rollback = async () => {
    const failures: string[] = [];
    for (const revert of undo.toReversed()) {
      try {
        await revert();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      throw new ClawWorkspaceUpdateError(failures.join("; "), true);
    }
  };

  try {
    for (const action of actions) {
      const path = action.id;
      const previousRef = currentRefs.get(path);
      const existed = await workspace.exists(path);
      const previousContent = existed
        ? await workspace.readBytes(path, { maxBytes: MAX_UPDATE_FILE_BYTES })
        : undefined;
      if (action.currentPresent === true && !existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} disappeared after planning.`,
        );
      }
      if (action.currentPresent === false && existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} appeared after planning.`,
        );
      }
      if (
        previousContent &&
        action.currentDigest &&
        digest(previousContent) !== action.currentDigest
      ) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} changed after planning.`,
        );
      }
      if (action.action === "add" && existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace destination ${JSON.stringify(path)} appeared after planning.`,
        );
      }

      if (action.action === "remove") {
        undo.push(async () => {
          if (await workspace.exists(path)) {
            throw new Error(`Workspace file ${JSON.stringify(path)} appeared before rollback.`);
          }
          if (previousContent) {
            await workspace.write(path, previousContent, { mkdir: true, overwrite: true });
          }
          if (previousRef) {
            upsertClawWorkspaceFile(previousRef, options);
          }
        });
        if (existed) {
          await workspace.remove(path);
        }
        deleteClawWorkspaceFileRecord(updatePlan.agentId, path, options);
        appliedPaths.push(path);
        continue;
      }

      const target = targetActions.get(path);
      if (!target?.source || !target.digest) {
        throw new ClawWorkspaceUpdateError(
          `Target workspace action ${JSON.stringify(path)} lacks source provenance.`,
        );
      }
      const sourceRelative = relativeWithin(packageRoot, resolve(target.source));
      const content = await source.readBytes(sourceRelative, { maxBytes: MAX_UPDATE_FILE_BYTES });
      if (digest(content) !== target.digest || target.digest !== action.desiredDigest) {
        throw new ClawWorkspaceUpdateError(
          `Workspace source for ${JSON.stringify(path)} changed after planning.`,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const record: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        workspace: workspace.rootReal,
        path,
        sourcePath: resolve(target.source),
        contentDigest: target.digest,
        status: "complete",
        createdAtMs: previousRef?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      };
      undo.push(async () => {
        if (!(await workspace.exists(path))) {
          throw new Error(`Workspace file ${JSON.stringify(path)} disappeared before rollback.`);
        }
        const currentContent = await workspace.readBytes(path, {
          maxBytes: MAX_UPDATE_FILE_BYTES,
        });
        if (digest(currentContent) !== target.digest) {
          throw new Error(`Workspace file ${JSON.stringify(path)} changed before rollback.`);
        }
        if (previousContent) {
          await workspace.write(path, previousContent, { mkdir: true, overwrite: true });
        } else if (await workspace.exists(path)) {
          await workspace.remove(path);
        }
        if (previousRef) {
          upsertClawWorkspaceFile(previousRef, options);
        } else {
          deleteClawWorkspaceFileRecord(updatePlan.agentId, path, options);
        }
      });
      await workspace.write(path, content, { mkdir: true, overwrite: existed });
      upsertClawWorkspaceFile(record, options);
      appliedPaths.push(path);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawWorkspaceUpdateError(
        `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        true,
      );
    }
    throw error;
  }
  return { appliedPaths, rollback };
}
