import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { PreservedSessionWorktree } from "../../packages/gateway-protocol/src/index.js";
import { runGit } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  classifyWorktreeRemovalError,
  managedWorktrees,
  ManagedWorktreeService,
} from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { loadSessionEntry, type SessionAccessScope } from "../config/sessions/session-accessor.js";
import { collectActiveSessionWorkAdmissionKeys } from "../config/sessions/store-maintenance-preserve.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../gateway/worker-environments/session-placement-lifecycle.js";
import { getChildLogger } from "../logging/logger.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { runExclusiveSessionLifecycleMutation } from "./session-lifecycle-admission.js";

export class SessionWorktreeLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: PreservedSessionWorktree["reason"] | "restore-failed" | "session-changed",
  ) {
    super(message);
  }
}

function serviceFor(env?: NodeJS.ProcessEnv) {
  return env ? new ManagedWorktreeService({ env }) : managedWorktrees;
}

function belongsToSession(record: ManagedWorktreeRecord, sessionKey: string) {
  return record.ownerKind === "session" && record.ownerId === sessionKey;
}

/** The session lifecycle fence remains held until this exact bound checkout finishes cleanup. */
export async function removeSessionWorktree(params: {
  id?: string;
  sessionKey: string;
  reason: string;
  commitGuard?: () => void;
  env?: NodeJS.ProcessEnv;
}): Promise<PreservedSessionWorktree | undefined> {
  if (!params.id) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const record = getRegistryWorktree(env, params.id);
  if (!record || record.removedAt !== undefined) {
    return undefined;
  }
  const preserved = (
    current: ManagedWorktreeRecord,
    reason: PreservedSessionWorktree["reason"],
  ) => ({
    id: current.id,
    branch: current.branch,
    path: current.path,
    reason,
  });
  const assertCurrent = () => {
    params.commitGuard?.();
    const current = getRegistryWorktree(env, record.id);
    if (current && !belongsToSession(current, params.sessionKey)) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree ownership changed; retry cleanup.",
        "owner-mismatch",
      );
    }
  };
  try {
    assertCurrent();
    await serviceFor(params.env).remove({
      id: record.id,
      reason: params.reason,
      commitGuard: assertCurrent,
    });
  } catch (error) {
    // Authorization loss is a failed lifecycle action, not successful best-effort cleanup.
    params.commitGuard?.();
    const current = getRegistryWorktree(env, record.id);
    if (current && current.removedAt === undefined) {
      const reason =
        error instanceof SessionWorktreeLifecycleError && error.reason === "owner-mismatch"
          ? error.reason
          : classifyWorktreeRemovalError(error);
      getChildLogger({ subsystem: "session-worktree" }).warn("Session worktree preserved", {
        worktreeId: record.id,
        sessionKey: params.sessionKey,
        reason,
      });
      return preserved(current, reason);
    }
  }
  return undefined;
}

/** Snapshot removal and restore never change conversation or session metadata themselves. */
export async function synchronizeSessionWorktreeArchive(params: {
  archived: boolean;
  entry: SessionEntry;
  scope: SessionAccessScope;
  commitGuard?: () => void;
}): Promise<void> {
  const { entry, scope } = params;
  const id = entry.worktree?.id;
  if (!id) {
    return;
  }
  const assertCurrent = () => {
    params.commitGuard?.();
    const current = loadSessionEntry(scope);
    if (
      current?.sessionId !== entry.sessionId ||
      current?.lifecycleRevision !== entry.lifecycleRevision ||
      current?.archivedAt !== entry.archivedAt ||
      !isDeepStrictEqual(current?.worktree, entry.worktree)
    ) {
      throw new SessionWorktreeLifecycleError(
        "Session changed while preparing its worktree; retry the request.",
        "session-changed",
      );
    }
    const record = getRegistryWorktree(scope.env ?? process.env, id);
    if (record && !belongsToSession(record, scope.sessionKey)) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree has a different owner; restore the correct binding before retrying.",
        "owner-mismatch",
      );
    }
  };
  assertCurrent();
  if (params.archived) {
    const preserved = await removeSessionWorktree({
      id,
      sessionKey: scope.sessionKey,
      reason: "session-archive",
      env: scope.env,
      commitGuard: assertCurrent,
    });
    if (preserved) {
      throw new SessionWorktreeLifecycleError(
        `Session worktree was preserved (${preserved.reason}); resolve the cleanup condition and retry the archive.`,
        preserved.reason,
      );
    }
  } else {
    const record = getRegistryWorktree(scope.env ?? process.env, id);
    if (!record || (record.removedAt !== undefined && !record.snapshotRef)) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree snapshot is missing or expired. The conversation is preserved; start a new worktree task from the source repository to continue.",
        "restore-failed",
      );
    }
    if (record.removedAt !== undefined) {
      try {
        await serviceFor(scope.env).restore({ id, commitGuard: assertCurrent });
      } catch (error) {
        assertCurrent();
        if (error instanceof SessionWorktreeLifecycleError) {
          throw error;
        }
        if (!existsSync(record.repoRoot)) {
          throw new SessionWorktreeLifecycleError(
            "Session worktree source repository is missing. Restore the original repository and its snapshot refs, then retry; otherwise start a new worktree task. The conversation is preserved.",
            "restore-failed",
          );
        }
        const snapshot = await runGit(record.repoRoot, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${record.snapshotRef}^{commit}`,
        ]);
        assertCurrent();
        if (snapshot.code !== 0) {
          throw new SessionWorktreeLifecycleError(
            "Session worktree snapshot is missing or unavailable. Restore the original repository snapshot, or start a new worktree task. The conversation is preserved.",
            "restore-failed",
          );
        }
        throw new SessionWorktreeLifecycleError(
          "Session worktree could not be restored. Free disk space if needed, check the source repository, then retry. The conversation and snapshot are preserved.",
          "restore-failed",
        );
      }
    }
  }
  assertCurrent();
}

/** Maintenance commits archive metadata first; its released writer lane must never retain Git work. */
export async function cleanUpAutomaticallyArchivedWorktrees(
  scope: Pick<SessionAccessScope, "agentId" | "env">,
  targets: readonly { entry: SessionEntry; sessionKey: string; storePath: string }[],
): Promise<void> {
  for (const target of targets) {
    try {
      await runExclusiveSessionLifecycleMutation({
        scope: target.storePath,
        identities: [target.sessionKey, target.entry.sessionId],
        run: async () => {
          const placements = createWorkerSessionPlacementStore({
            database: openOpenClawStateDatabase({ env: scope.env }),
          });
          const assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
            context: { workerSessionPlacementService: placements },
            sessionId: target.entry.sessionId,
          });
          await synchronizeSessionWorktreeArchive({
            archived: true,
            entry: target.entry,
            scope: { ...scope, sessionKey: target.sessionKey, storePath: target.storePath },
            commitGuard: () => {
              assertPlacementCurrent();
              if (
                collectActiveSessionWorkAdmissionKeys({
                  storePath: target.storePath,
                  store: { [target.sessionKey]: target.entry },
                })?.has(target.sessionKey)
              ) {
                throw new SessionWorktreeLifecycleError(
                  "Session worktree is still active; cleanup is deferred.",
                  "busy",
                );
              }
            },
          });
        },
      });
    } catch (error) {
      getChildLogger({ subsystem: "session-worktree" }).warn(
        "Automatic archive worktree cleanup deferred",
        {
          worktreeId: target.entry.worktree?.id,
          reason: error instanceof SessionWorktreeLifecycleError ? error.reason : "cleanup-failed",
        },
      );
    }
  }
}
