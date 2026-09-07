import { createHash } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { insertGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { ensureGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-store.js";

type GitHubPublicationDatabase = Pick<
  StateDatabase,
  "github_publication_requests" | "worker_session_placements"
>;
export type GitHubPublicationRow = StateDatabase["github_publication_requests"];
export type GitHubPublicationExecutionRow = Omit<
  GitHubPublicationRow,
  "claim_id" | "run_id" | "environment_id" | "owner_epoch" | "placement_generation"
> & { last_effect?: string | null; effect_state?: string | null };
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

export function readGitHubPublicationRequest(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  request: { requestId: string } | { sessionId: string; idempotencyKey: string },
): GitHubPublicationRow | undefined {
  const query = githubPublicationDatabase(db).selectFrom("github_publication_requests").selectAll();
  return executeSqliteQueryTakeFirstSync(
    db,
    "requestId" in request
      ? query.where("request_id", "=", request.requestId)
      : query
          .where("session_id", "=", request.sessionId)
          .where("idempotency_key", "=", request.idempotencyKey),
  );
}

export function listGitHubPublicationsForClaim(
  claim: WorkerSessionTurnClaim,
  options: { pendingOnly?: boolean } = {},
): GitHubPublicationRow[] {
  const db = openOpenClawStateDatabase().db;
  let query = githubPublicationDatabase(db)
    .selectFrom("github_publication_requests")
    .selectAll()
    .where("session_id", "=", claim.sessionId)
    .where("claim_id", "=", claim.claimId)
    .where("run_id", "=", claim.runId)
    .orderBy("created_at_ms");
  if (options.pendingOnly) {
    query = query.where("status", "in", ["requested", "publishing"]);
  }
  return executeSqliteQuerySync(db, query).rows;
}

export function claimGitHubPublicationExecution(
  requestId: string,
  gatewayInstanceId: string,
): GitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = githubPublicationDatabase(db);
      const current = readGitHubPublicationRequest(db, { requestId });
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
      const claimed = executeSqliteQueryTakeFirstSync(db, update.returningAll());
      if (!claimed) {
        throw new Error("GitHub publication execution ownership changed.");
      }
      return claimed;
    },
    undefined,
    { operationLabel: "github-publication.claim" },
  );
}

export function matchesGitHubPublicationIdentityRow(
  row: Pick<
    GitHubPublicationExecutionRow,
    | "agent_id"
    | "identity_source"
    | "identity_profile_id"
    | "identity_account_id"
    | "identity_login"
  >,
  identity: Pick<PreparedGitHubPublicationIdentity, "source" | "profileId" | "account">,
): boolean {
  return (
    row.identity_source === identity.source &&
    row.identity_profile_id === (identity.profileId ?? null) &&
    row.identity_account_id === identity.account.accountId &&
    row.identity_login.toLowerCase() === identity.account.login.toLowerCase()
  );
}

/** Insert/replay shared intent inside the caller's admission transaction. */
export function insertGitHubPublicationRequest(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  input: {
    request: {
      sessionKey: string;
      agentId: string;
      idempotencyKey: string;
      title?: string;
      body?: string;
    };
    requestId: string;
    requestDigest: string;
    sessionId: string;
    lifecycleRevision: string | null;
    now: number;
    worktree: { id: string; repoFingerprint: string; branch: string };
    identity: Pick<PreparedGitHubPublicationIdentity, "source" | "profileId" | "account">;
    claim?: WorkerSessionTurnClaim;
    snapshot?: { sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string };
  },
): GitHubPublicationRow {
  const { request, identity, worktree, claim, snapshot } = input;
  const query = githubPublicationDatabase(db);
  const inserted = executeSqliteQuerySync(
    db,
    query
      .insertInto("github_publication_requests")
      .values({
        request_id: input.requestId,
        idempotency_key: request.idempotencyKey,
        request_digest: input.requestDigest,
        session_id: input.sessionId,
        session_key: request.sessionKey,
        agent_id: request.agentId,
        worktree_id: worktree.id,
        repository_fingerprint: worktree.repoFingerprint,
        claim_id: claim?.claimId ?? null,
        run_id: claim?.runId ?? null,
        environment_id: claim?.owner.environmentId ?? null,
        owner_epoch: claim?.owner.ownerEpoch ?? null,
        placement_generation: claim?.placementGeneration ?? null,
        identity_source: identity.source,
        identity_profile_id: identity.profileId ?? null,
        identity_account_id: identity.account.accountId,
        identity_login: identity.account.login,
        title: request.title ?? null,
        body: request.body ?? null,
        branch: worktree.branch,
        source_head_commit: snapshot?.sourceHeadCommit ?? null,
        source_index_tree: snapshot?.sourceIndexTree ?? null,
        workspace_tree: snapshot?.workspaceTree ?? null,
        created_at_ms: input.now,
        status: "requested",
        gateway_instance_id: null,
        repository: null,
        base_branch: null,
        head_commit: null,
        pull_request_url: null,
        error_code: null,
        next_action: null,
        updated_at_ms: input.now,
        reported_at_ms: null,
      })
      .onConflict((conflict) => conflict.columns(["session_id", "idempotency_key"]).doNothing()),
  );
  if (inserted.numAffectedRows === 1n) {
    insertGitHubPublicationSessionLifecycle(db, {
      publicationKind: "shared",
      requestId: input.requestId,
      lifecycleRevision: input.lifecycleRevision,
    });
  }
  const stored = readGitHubPublicationRequest(db, {
    sessionId: input.sessionId,
    idempotencyKey: request.idempotencyKey,
  });
  if (
    !stored ||
    stored.request_digest !== input.requestDigest ||
    !matchesGitHubPublicationIdentityRow(stored, identity) ||
    stored.worktree_id !== worktree.id ||
    stored.repository_fingerprint !== worktree.repoFingerprint ||
    stored.branch !== worktree.branch
  ) {
    throw new Error("GitHub publication idempotency key was reused.");
  }
  return stored;
}

/** Named execution transitions share one instance-bound write owner. */
export function createGitHubPublicationExecutionStore(instanceId: string) {
  const errors = {
    "bind-workspace": "GitHub publication workspace snapshot changed before execution.",
    begin: "GitHub publication state changed before execution.",
    complete: "GitHub publication state changed before completion.",
  };
  const write = (
    row: GitHubPublicationRow,
    values: Partial<GitHubPublicationRow> | undefined,
    transition: keyof typeof errors,
  ): GitHubPublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (!values) {
          throw new Error("GitHub publication terminal result is invalid.");
        }
        let update = githubPublicationDatabase(db)
          .updateTable("github_publication_requests")
          .set({ ...values, updated_at_ms: Date.now() })
          .where("request_id", "=", row.request_id)
          .where("status", "=", "publishing")
          .where("gateway_instance_id", "=", instanceId);
        if (transition === "bind-workspace") {
          update = update
            .where("source_head_commit", "is", null)
            .where("source_index_tree", "is", null)
            .where("workspace_tree", "is", null);
        }
        const updated = executeSqliteQueryTakeFirstSync(db, update.returningAll());
        if (!updated) {
          throw new Error(errors[transition]);
        }
        return updated;
      },
      undefined,
      { operationLabel: `github-publication.${transition}` },
    );
  return {
    bindWorkspaceSnapshot: (input: {
      row: GitHubPublicationRow;
      sourceHeadCommit: string;
      sourceIndexTree: string;
      workspaceTree: string;
    }): GitHubPublicationRow => {
      return write(
        input.row,
        {
          source_head_commit: input.sourceHeadCommit,
          source_index_tree: input.sourceIndexTree,
          workspace_tree: input.workspaceTree,
        },
        "bind-workspace",
      );
    },
    updatePublishingFacts: (input: {
      row: GitHubPublicationRow;
      repository: string;
      branch: string;
      baseBranch: string;
      sourceHeadCommit: string;
      workspaceTree: string;
      headCommit: string;
    }): GitHubPublicationRow => {
      return write(
        input.row,
        {
          repository: input.repository,
          branch: input.branch,
          base_branch: input.baseBranch,
          source_head_commit: input.sourceHeadCommit,
          workspace_tree: input.workspaceTree,
          head_commit: input.headCommit,
        },
        "begin",
      );
    },
    complete: (
      row: GitHubPublicationRow,
      result: SessionGitHubPublicationResult,
    ): GitHubPublicationRow => {
      const values =
        result.status === "published"
          ? {
              status: "published",
              pull_request_url: result.url,
              repository: result.repository,
              branch: result.branch,
              head_commit: result.headCommit,
              error_code: null,
              next_action: null,
            }
          : result.status === "failed"
            ? {
                status: "failed",
                pull_request_url: null,
                error_code: result.code,
                next_action: result.nextAction,
              }
            : undefined;
      return write(row, values, "complete");
    },
  };
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
  row: Pick<
    GitHubPublicationExecutionRow,
    | "request_id"
    | "identity_source"
    | "identity_account_id"
    | "identity_login"
    | "status"
    | "head_commit"
    | "pull_request_url"
    | "repository"
    | "branch"
    | "error_code"
    | "next_action"
    | "last_effect"
    | "effect_state"
  >,
): SessionGitHubPublicationResult {
  const effect: Pick<SessionGitHubPublicationResult, "effect"> =
    (row.last_effect === "push" || row.last_effect === "pull_request") &&
    (row.effect_state === "dispatched" || row.effect_state === "observed")
      ? {
          effect: {
            kind: row.last_effect,
            status: row.effect_state,
            ...(row.head_commit ? { headCommit: row.head_commit } : {}),
            ...(row.pull_request_url ? { url: row.pull_request_url } : {}),
          },
        }
      : {};
  const common = {
    requestId: row.request_id,
    publisher: {
      source:
        row.identity_source === "personal" ||
        row.identity_source === "agent-override" ||
        row.identity_source === "system-configured"
          ? row.identity_source
          : "system-detected",
      accountId: row.identity_account_id,
      login: row.identity_login,
    },
    ...effect,
  } satisfies Pick<SessionGitHubPublicationResult, "requestId" | "publisher" | "effect">;
  if (row.status === "published" && row.pull_request_url && row.repository && row.branch) {
    return {
      ...common,
      status: "published",
      url: row.pull_request_url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit ?? "unknown",
    };
  }
  if (row.status === "failed" && row.error_code && row.next_action) {
    return {
      ...common,
      status: "failed",
      code: publicationFailureCode(row.error_code),
      message: "GitHub publication failed.",
      nextAction: row.next_action,
    };
  }
  if (row.status === "needs_confirmation") {
    return {
      ...common,
      status: "needs_confirmation",
      message:
        "Confirm the original My GitHub account, target, and workspace to continue this interrupted publication. Already-dispatched GitHub effects may have completed; confirmation checks them before retrying.",
    };
  }
  return {
    ...common,
    status: row.status === "publishing" ? "publishing" : "requested",
    message:
      row.status === "publishing"
        ? "The Gateway is publishing the reconciled workspace."
        : row.identity_source === "personal"
          ? "My GitHub publication was accepted for the selected account and workspace."
          : "Publication was accepted. Finish the turn so the Gateway can reconcile and publish the workspace.",
  };
}
