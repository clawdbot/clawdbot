import { createHash } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensureGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

type GitHubPublicationDatabase = Pick<
  StateDatabase,
  "github_publication_requests" | "worker_session_placements"
>;
export type GitHubPublicationRow = StateDatabase["github_publication_requests"];
type PublicationFailureCode = Extract<SessionGitHubPublicationResult, { status: "failed" }>["code"];

const PUBLICATION_FAILURE_CODES = new Set<string>([
  "identity_changed",
  "identity_unavailable",
  "session_changed",
  "workspace_changed",
  "not_git",
  "not_github",
  "no_changes",
  "push_rejected",
  "github_rejected",
  "unavailable",
]);

function publicationFailureCode(value: string): PublicationFailureCode {
  // SAFETY: membership in the closed protocol vocabulary narrows this stored string.
  return PUBLICATION_FAILURE_CODES.has(value) ? (value as PublicationFailureCode) : "unavailable";
}

export const githubPublicationDatabase = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<GitHubPublicationDatabase>(db);

export function ensureGitHubPublicationStore(): void {
  ensureGitHubPublicationSchema(openOpenClawStateDatabase().db);
}

export function hasGitHubPublicationStore(): boolean {
  return tableExists(openOpenClawStateDatabase().db, "github_publication_requests");
}

export function readGitHubPublicationBranch(
  worktree: NonNullable<SessionEntry["worktree"]>,
): string | undefined {
  if (!hasGitHubPublicationStore()) {
    return undefined;
  }
  const db = openOpenClawStateDatabase().db;
  return executeSqliteQuerySync(
    db,
    githubPublicationDatabase(db)
      .selectFrom("github_publication_requests")
      .select("branch")
      .where("worktree_id", "=", worktree.id)
      .where("source_branch", "=", worktree.branch)
      .where("repository", "is not", null)
      .orderBy("created_at_ms")
      .orderBy("request_id")
      .limit(1),
  ).rows[0]?.branch;
}

export function bindGitHubPublicationDestination(params: {
  row: GitHubPublicationRow;
  repository: string;
  entry: SessionEntry | undefined;
}): GitHubPublicationRow {
  const { row, repository, entry } = params;
  const slug =
    entry?.worktree?.naming === "automatic"
      ? slugifyWorktreeTitle(entry.label ?? entry.displayName ?? "")
      : undefined;
  const suffix = createHash("sha256").update(row.worktree_id).digest("hex").slice(0, 12);
  const suggestedBranch = slug ? `openclaw/${slug}-${suffix}` : row.source_branch;
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = githubPublicationDatabase(db);
      const current = executeSqliteQuerySync(
        db,
        query
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("request_id", "=", row.request_id),
      ).rows[0];
      if (
        current?.status !== "publishing" ||
        current.gateway_instance_id !== row.gateway_instance_id
      ) {
        throw new Error("GitHub publication execution ownership changed.");
      }
      // Repository binding precedes every push. Once bound, retries and later
      // requests reuse the destination even if the sidebar title changes.
      if (current.repository !== null) {
        if (current.repository !== repository) {
          throw new Error("GitHub publication workspace repository changed.");
        }
        return current;
      }
      const previous = executeSqliteQuerySync(
        db,
        query
          .selectFrom("github_publication_requests")
          .select("branch")
          .where("worktree_id", "=", row.worktree_id)
          .where("repository_fingerprint", "=", row.repository_fingerprint)
          .where("source_branch", "=", row.source_branch)
          .where("repository", "=", repository)
          .orderBy("created_at_ms")
          .orderBy("request_id")
          .limit(1),
      ).rows[0];
      const branch = previous?.branch ?? suggestedBranch;
      executeSqliteQuerySync(
        db,
        query
          .updateTable("github_publication_requests")
          .set({ repository, branch, updated_at_ms: Date.now() })
          .where("request_id", "=", row.request_id),
      );
      return { ...current, repository, branch };
    },
    undefined,
    { operationLabel: "github-publication.bind-destination" },
  );
}

export function ownsGitHubPublicationDestination(
  row: GitHubPublicationRow,
  headCommit: string,
): boolean {
  const db = openOpenClawStateDatabase().db;
  return (
    executeSqliteQuerySync(
      db,
      githubPublicationDatabase(db)
        .selectFrom("github_publication_requests")
        .select("request_id")
        .where("worktree_id", "=", row.worktree_id)
        .where("repository_fingerprint", "=", row.repository_fingerprint)
        .where("source_branch", "=", row.source_branch)
        .where("repository", "=", row.repository)
        .where("branch", "=", row.branch)
        // A published destination may advance through collaborator commits. Before
        // first success, only an exact recorded candidate proves an ambiguous push.
        .where((eb) => eb.or([eb("status", "=", "published"), eb("head_commit", "=", headCommit)]))
        .limit(1),
    ).rows.length > 0
  );
}

export function claimGitHubPublicationExecution(
  requestId: string,
  gatewayInstanceId: string,
): GitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = githubPublicationDatabase(db);
      const current = executeSqliteQuerySync(
        db,
        query
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("request_id", "=", requestId),
      ).rows[0];
      if (!current) {
        throw new Error("GitHub publication request disappeared.");
      }
      if (current.status === "published" || current.status === "failed") {
        return current;
      }
      let update = query
        .updateTable("github_publication_requests")
        .set({
          status: "publishing",
          gateway_instance_id: gatewayInstanceId,
          updated_at_ms: Date.now(),
        })
        .where("request_id", "=", current.request_id)
        .where("status", "=", current.status);
      update = current.gateway_instance_id
        ? update.where("gateway_instance_id", "=", current.gateway_instance_id)
        : update.where("gateway_instance_id", "is", null);
      const claimed = executeSqliteQuerySync(db, update);
      if (claimed.numAffectedRows !== 1n) {
        throw new Error("GitHub publication execution ownership changed.");
      }
      return executeSqliteQuerySync(
        db,
        query
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("request_id", "=", requestId),
      ).rows[0]!;
    },
    undefined,
    { operationLabel: "github-publication.claim" },
  );
}

export function deferGitHubPublicationRequests(requestIds: string[]): void {
  if (requestIds.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = githubPublicationDatabase(db);
      const updatedAtMs = Date.now();
      for (const requestId of requestIds) {
        executeSqliteQuerySync(
          db,
          query
            .updateTable("github_publication_requests")
            .set({
              claim_id: null,
              run_id: null,
              environment_id: null,
              owner_epoch: null,
              placement_generation: null,
              status: "requested",
              gateway_instance_id: null,
              updated_at_ms: updatedAtMs,
            })
            .where("request_id", "=", requestId)
            .where("status", "in", ["requested", "publishing"]),
        );
      }
    },
    undefined,
    { operationLabel: "github-publication.defer" },
  );
}

export function isGitHubPublicationExecutionOwner(
  requestId: string,
  gatewayInstanceId: string,
): boolean {
  ensureGitHubPublicationStore();
  const db = openOpenClawStateDatabase().db;
  const row = executeSqliteQuerySync(
    db,
    githubPublicationDatabase(db)
      .selectFrom("github_publication_requests")
      .select(["status", "gateway_instance_id"])
      .where("request_id", "=", requestId),
  ).rows[0];
  return row?.status === "publishing" && row.gateway_instance_id === gatewayInstanceId;
}

export function digestGitHubPublicationRequest(params: {
  sessionId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: params.sessionId,
        idempotencyKey: params.idempotencyKey,
        title: params.title ?? null,
        body: params.body ?? null,
      }),
    )
    .digest("hex");
}

export function projectGitHubPublicationResult(
  row: GitHubPublicationRow,
): SessionGitHubPublicationResult {
  if (row.status === "published" && row.pull_request_url && row.repository && row.branch) {
    return {
      requestId: row.request_id,
      status: "published",
      url: row.pull_request_url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit ?? "unknown",
    };
  }
  if (row.status === "failed" && row.error_code && row.next_action) {
    return {
      requestId: row.request_id,
      status: "failed",
      code: publicationFailureCode(row.error_code),
      message: "GitHub publication failed.",
      nextAction: row.next_action,
    };
  }
  return {
    requestId: row.request_id,
    status: row.status === "publishing" ? "publishing" : "requested",
    message:
      row.status === "publishing"
        ? "The Gateway is publishing the reconciled workspace."
        : "Publication was accepted. Finish the turn so the Gateway can reconcile and publish the workspace.",
  };
}
