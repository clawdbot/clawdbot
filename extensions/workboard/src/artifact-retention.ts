import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";

export type WorktreeRetentionRuntime = Pick<
  PluginRuntime["worktrees"],
  "resolveRetentionTarget" | "setRetentionClaim"
>;

export type WorkboardArtifactRetentionStore = {
  reconcileArtifactRetention(): Promise<void>;
};

type RetentionGeneration = {
  claim_id: string;
  card_id: string;
  worktree_id: string;
  state: "prepared" | "active" | "release_pending";
};

export const WORKBOARD_ARTIFACT_RETENTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workboard_artifact_retention (
    claim_id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'release_pending'))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS workboard_artifact_retention_active_idx
    ON workboard_artifact_retention(card_id) WHERE state = 'active';
  CREATE INDEX IF NOT EXISTS workboard_artifact_retention_pending_idx
    ON workboard_artifact_retention(state);
`;

async function retainedWorkspacePath(card: WorkboardCard | undefined): Promise<string | undefined> {
  const workspace = card?.metadata?.automation?.workspace;
  if (!card || card.metadata?.archivedAt || workspace?.kind !== "worktree" || !workspace.path) {
    return undefined;
  }
  const artifactPaths = (card.metadata?.artifacts ?? []).flatMap((artifact) =>
    artifact.path ? [artifact.path] : [],
  );
  if (artifactPaths.length === 0) {
    return undefined;
  }
  const workspaceRoot = path.resolve(workspace.path);
  try {
    const canonicalWorkspaceRoot = await canonicalPathFromExistingAncestor(workspaceRoot);
    for (const artifact of artifactPaths) {
      const canonicalArtifactPath = await canonicalPathFromExistingAncestor(
        path.resolve(workspaceRoot, artifact),
      );
      if (isPathInside(canonicalWorkspaceRoot, canonicalArtifactPath)) {
        return workspace.path;
      }
    }
  } catch {
    // Resolution failure must not turn a persisted local reference into an unprotected tree.
    return workspace.path;
  }
  return undefined;
}

/** Shares the card owner's database/commit boundary, never a second persistence transaction. */
export class WorkboardArtifactRetention {
  private readonly k;

  constructor(
    private readonly db: DatabaseSync,
    private readonly worktrees: WorktreeRetentionRuntime,
  ) {
    this.k = getNodeSqliteKysely<{ workboard_artifact_retention: RetentionGeneration }>(db);
  }

  private current(cardId: string): RetentionGeneration | undefined {
    return executeSqliteQuerySync(
      this.db,
      this.k
        .selectFrom("workboard_artifact_retention")
        .selectAll()
        .where("card_id", "=", cardId)
        .where("state", "=", "active"),
    ).rows[0];
  }

  private cancel(claimId: string): void {
    executeSqliteQuerySync(
      this.db,
      this.k
        .updateTable("workboard_artifact_retention")
        .set({ state: "release_pending" })
        .where("claim_id", "=", claimId)
        .where("state", "=", "prepared"),
    );
  }

  cancelPrepared(): void {
    // Cancellation and card publication compete in this same SQLite commit domain.
    // A delayed writer must still find its exact prepared generation before publishing.
    executeSqliteQuerySync(
      this.db,
      this.k
        .updateTable("workboard_artifact_retention")
        .set({ state: "release_pending" })
        .where("state", "=", "prepared"),
    );
  }

  async drainReleases(): Promise<void> {
    const pending = executeSqliteQuerySync(
      this.db,
      this.k
        .selectFrom("workboard_artifact_retention")
        .selectAll()
        .where("state", "=", "release_pending"),
    ).rows;
    for (const generation of pending) {
      const released = await this.worktrees.setRetentionClaim({
        worktreeId: generation.worktree_id,
        ownerKind: "workboard",
        ownerId: generation.card_id,
        claimId: generation.claim_id,
        active: false,
      });
      if (!released) {
        throw new Error("managed worktree rejected artifact retention release");
      }
      // Acknowledge only after terminal release; replay after a crash is idempotent.
      executeSqliteQuerySync(
        this.db,
        this.k
          .deleteFrom("workboard_artifact_retention")
          .where("claim_id", "=", generation.claim_id)
          .where("state", "=", "release_pending"),
      );
    }
  }

  async mutate<T>(
    cardId: string,
    next: WorkboardCard | undefined,
    commit: () => T,
    applied: (result: T) => boolean,
    allowUnavailable = false,
  ): Promise<T> {
    const workspacePath = await retainedWorkspacePath(next);
    const worktreeId = workspacePath
      ? await this.worktrees.resolveRetentionTarget({
          path: workspacePath,
          ownerKind: "workboard",
          ownerId: cardId,
        })
      : undefined;
    if (workspacePath && !worktreeId) {
      if (!allowUnavailable) {
        throw new Error(`managed worktree is unavailable for artifact retention: ${workspacePath}`);
      }
      // Startup cannot interpret temporary removal as removal of the persisted reference.
      // Preserve an enrolled generation so restoring that identity retains its protection.
      return runSqliteImmediateTransactionSync(this.db, commit);
    }

    const previous = this.current(cardId);
    const reused = worktreeId && previous?.worktree_id === worktreeId ? previous : undefined;
    const prepared: RetentionGeneration | undefined =
      worktreeId && !reused
        ? { claim_id: randomUUID(), card_id: cardId, worktree_id: worktreeId, state: "prepared" }
        : undefined;
    if (prepared) {
      // Persist intent before the other store can acquire anything we must later release.
      executeSqliteQuerySync(
        this.db,
        this.k.insertInto("workboard_artifact_retention").values(prepared),
      );
    }
    const generation = prepared ?? reused;
    try {
      if (generation) {
        const acquired = await this.worktrees.setRetentionClaim({
          worktreeId: generation.worktree_id,
          ownerKind: "workboard",
          ownerId: cardId,
          claimId: generation.claim_id,
          active: true,
        });
        if (!acquired) {
          throw new Error(
            "artifact retention preparation was cancelled or the worktree is unavailable; retry the mutation",
          );
        }
      }
      return runSqliteImmediateTransactionSync(this.db, () => {
        if (generation) {
          const current = executeSqliteQuerySync(
            this.db,
            this.k
              .selectFrom("workboard_artifact_retention")
              .select("state")
              .where("claim_id", "=", generation.claim_id),
          ).rows[0];
          if (current?.state !== (prepared ? "prepared" : "active")) {
            throw new Error("artifact retention preparation was cancelled; retry the mutation");
          }
        }
        const result = commit();
        if (applied(result)) {
          let obsolete = this.k
            .updateTable("workboard_artifact_retention")
            .set({ state: "release_pending" })
            .where("card_id", "=", cardId)
            .where("state", "=", "active");
          if (generation) {
            obsolete = obsolete.where("claim_id", "!=", generation.claim_id);
          }
          executeSqliteQuerySync(this.db, obsolete);
          if (prepared) {
            executeSqliteQuerySync(
              this.db,
              this.k
                .updateTable("workboard_artifact_retention")
                .set({ state: "active" })
                .where("claim_id", "=", prepared.claim_id),
            );
          }
        } else if (prepared) {
          this.cancel(prepared.claim_id);
        }
        return result;
      });
    } catch (error) {
      if (prepared) {
        this.cancel(prepared.claim_id);
      }
      throw error;
    } finally {
      // The durable obligation owns retry. A cleanup outage must not turn a committed
      // card write into a reported write failure (and trigger incorrect compensation).
      await this.drainReleases().catch(() => undefined);
    }
  }
}
