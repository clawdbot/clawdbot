import { randomUUID } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  prepareCurrentGitHubPublicationIdentity,
  resolveGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import { createGitHubPublicationCoordinatorMethods } from "./github-publication-coordinator-methods.js";
import {
  captureGitHubPublicationWorkspaceSnapshot,
  executeGitHubPublication,
  matchesGitHubPublicationIdentityRow,
  resolveGitHubPublicationFailure,
} from "./github-publication-executor.js";
import {
  claimGitHubPublicationExecution as claimExecution,
  digestGitHubPublicationRequest as digestRequest,
  ensureGitHubPublicationStore as ensureSchema,
  githubPublicationDatabase as publicationDb,
  isGitHubPublicationExecutionOwner as ownsExecution,
  projectGitHubPublicationResult as publicationResult,
  type GitHubPublicationRow as PublicationRow,
} from "./github-publication-store.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

const activePublicationExecutions = new Map<string, Promise<SessionGitHubPublicationResult>>();

function sameWorktree(
  row: PublicationRow,
  worktree: ReturnType<typeof resolveGitHubPublicationWorktreeOwner>["worktree"],
): boolean {
  return (
    row.worktree_id === worktree.id &&
    row.repository_fingerprint === worktree.repoFingerprint &&
    row.branch === worktree.branch
  );
}

function sameClaim(row: PublicationRow, claim: WorkerSessionTurnClaim): boolean {
  return (
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

function assertStoredClaim(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  request: {
    claim: WorkerSessionTurnClaim;
    sessionKey: string;
    agentId: string;
  },
): void {
  const row = executeSqliteQuerySync(
    db,
    publicationDb(db)
      .selectFrom("worker_session_placements")
      .select([
        "agent_id",
        "session_key",
        "state",
        "environment_id",
        "active_owner_epoch",
        "turn_claim_owner",
        "turn_claim_id",
        "turn_claim_run_id",
        "turn_claim_generation",
        "turn_claim_owner_epoch",
      ])
      .where("session_id", "=", request.claim.sessionId),
  ).rows[0];
  const ownerMatches =
    request.claim.owner.kind === "worker"
      ? row?.turn_claim_owner === "worker" &&
        row.environment_id === request.claim.owner.environmentId &&
        row.active_owner_epoch === request.claim.owner.ownerEpoch &&
        row.turn_claim_owner_epoch === request.claim.owner.ownerEpoch
      : row?.turn_claim_owner === "local";
  if (
    !row ||
    (row.state !== "active" && row.state !== "draining" && row.state !== "local") ||
    row.agent_id !== request.agentId ||
    row.session_key !== request.sessionKey ||
    row.turn_claim_id !== request.claim.claimId ||
    row.turn_claim_run_id !== request.claim.runId ||
    row.turn_claim_generation !== request.claim.placementGeneration ||
    !ownerMatches
  ) {
    throw new Error("GitHub publication turn authority changed before recording.");
  }
}

export type GitHubPublicationCoordinator = ReturnType<typeof createGitHubPublicationCoordinator>;

export function createGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
}) {
  const instanceId = params.placements.workspaceResultInstanceId();

  const readById = (requestId: string): PublicationRow | undefined => {
    ensureSchema();
    const db = openOpenClawStateDatabase().db;
    return executeSqliteQuerySync(
      db,
      publicationDb(db)
        .selectFrom("github_publication_requests")
        .selectAll()
        .where("request_id", "=", requestId),
    ).rows[0];
  };

  const requestForClaim = async (request: {
    claim: WorkerSessionTurnClaim;
    sessionKey: string;
    agentId: string;
    idempotencyKey: string;
    title?: string;
    body?: string;
    assertCurrent?: () => void;
  }): Promise<SessionGitHubPublicationResult> => {
    ensureSchema();
    request.assertCurrent?.();
    if (!params.placements.validateTurnClaim(request.claim)) {
      throw new Error("GitHub publication lost the live session turn claim.");
    }
    const placement = params.placements.get(request.claim.sessionId);
    if (
      !placement ||
      placement.sessionKey !== request.sessionKey ||
      placement.agentId !== request.agentId
    ) {
      throw new Error("GitHub publication session identity changed.");
    }
    resolveGitHubPublicationWorktreeOwner({
      sessionId: request.claim.sessionId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
    });
    request.assertCurrent?.();
    const identity = await prepareCurrentGitHubPublicationIdentity(request.agentId);
    request.assertCurrent?.();
    if (!params.placements.validateTurnClaim(request.claim)) {
      throw new Error("GitHub publication lost the live session turn claim after verification.");
    }
    const { worktree } = resolveGitHubPublicationWorktreeOwner({
      sessionId: request.claim.sessionId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
    });
    const requestDigest = digestRequest({
      sessionId: request.claim.sessionId,
      idempotencyKey: request.idempotencyKey,
      title: request.title,
      body: request.body,
    });
    const now = Date.now();
    const requestId = randomUUID();
    const row = runOpenClawStateWriteTransaction(
      ({ db }) => {
        assertStoredClaim(db, request);
        const query = publicationDb(db);
        executeSqliteQuerySync(
          db,
          query
            .insertInto("github_publication_requests")
            .values({
              request_id: requestId,
              idempotency_key: request.idempotencyKey,
              request_digest: requestDigest,
              session_id: request.claim.sessionId,
              session_key: request.sessionKey,
              agent_id: request.agentId,
              worktree_id: worktree.id,
              repository_fingerprint: worktree.repoFingerprint,
              claim_id: request.claim.claimId,
              run_id: request.claim.runId,
              environment_id: request.claim.owner.environmentId ?? null,
              owner_epoch: request.claim.owner.ownerEpoch ?? null,
              placement_generation: request.claim.placementGeneration,
              identity_source: identity.source,
              identity_profile_id: identity.profileId ?? null,
              identity_account_id: identity.account.accountId,
              identity_login: identity.account.login,
              title: request.title ?? null,
              body: request.body ?? null,
              status: "requested",
              gateway_instance_id: null,
              repository: null,
              branch: worktree.branch,
              base_branch: null,
              source_head_commit: null,
              source_index_tree: null,
              workspace_tree: null,
              head_commit: null,
              pull_request_url: null,
              error_code: null,
              next_action: null,
              created_at_ms: now,
              updated_at_ms: now,
              reported_at_ms: null,
            })
            .onConflict((conflict) =>
              conflict.columns(["session_id", "idempotency_key"]).doNothing(),
            ),
        );
        const stored = executeSqliteQuerySync(
          db,
          query
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("session_id", "=", request.claim.sessionId)
            .where("idempotency_key", "=", request.idempotencyKey),
        ).rows[0];
        if (
          !stored ||
          stored.request_digest !== requestDigest ||
          !sameClaim(stored, request.claim) ||
          !matchesGitHubPublicationIdentityRow(stored, identity) ||
          !sameWorktree(stored, worktree)
        ) {
          throw new Error("GitHub publication idempotency key was reused.");
        }
        return stored;
      },
      undefined,
      { operationLabel: "github-publication.request" },
    );
    return publicationResult(row);
  };

  const bindWorkspaceSnapshot = (input: {
    row: PublicationRow;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }): PublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const query = publicationDb(db);
        const updated = executeSqliteQuerySync(
          db,
          query
            .updateTable("github_publication_requests")
            .set({
              source_head_commit: input.sourceHeadCommit,
              source_index_tree: input.sourceIndexTree,
              workspace_tree: input.workspaceTree,
              updated_at_ms: Date.now(),
            })
            .where("request_id", "=", input.row.request_id)
            .where("status", "=", "publishing")
            .where("gateway_instance_id", "=", instanceId)
            .where("source_head_commit", "is", null)
            .where("source_index_tree", "is", null)
            .where("workspace_tree", "is", null),
        );
        if (updated.numAffectedRows !== 1n) {
          throw new Error("GitHub publication workspace snapshot changed before execution.");
        }
        return executeSqliteQuerySync(
          db,
          query
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("request_id", "=", input.row.request_id),
        ).rows[0]!;
      },
      undefined,
      { operationLabel: "github-publication.bind-workspace" },
    );

  const bindAcceptedClaimSnapshot = (input: {
    row: PublicationRow;
    claim: WorkerSessionTurnClaim;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }): PublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        assertStoredClaim(db, {
          claim: input.claim,
          sessionKey: input.row.session_key,
          agentId: input.row.agent_id,
        });
        const query = publicationDb(db);
        const current = executeSqliteQuerySync(
          db,
          query
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("request_id", "=", input.row.request_id),
        ).rows[0];
        if (
          !current ||
          current.claim_id !== input.claim.claimId ||
          current.run_id !== input.claim.runId ||
          (current.status !== "requested" && current.status !== "publishing")
        ) {
          throw new Error("GitHub publication workspace snapshot owner changed.");
        }
        if (current.source_head_commit || current.source_index_tree || current.workspace_tree) {
          if (
            current.source_head_commit !== input.sourceHeadCommit ||
            current.source_index_tree !== input.sourceIndexTree ||
            current.workspace_tree !== input.workspaceTree
          ) {
            throw new Error("GitHub publication accepted workspace snapshot changed.");
          }
          return current;
        }
        const updated = executeSqliteQuerySync(
          db,
          query
            .updateTable("github_publication_requests")
            .set({
              source_head_commit: input.sourceHeadCommit,
              source_index_tree: input.sourceIndexTree,
              workspace_tree: input.workspaceTree,
              updated_at_ms: Date.now(),
            })
            .where("request_id", "=", input.row.request_id)
            .where("source_head_commit", "is", null)
            .where("source_index_tree", "is", null)
            .where("workspace_tree", "is", null),
        );
        if (updated.numAffectedRows !== 1n) {
          throw new Error("GitHub publication accepted workspace snapshot changed.");
        }
        return executeSqliteQuerySync(
          db,
          query
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("request_id", "=", input.row.request_id),
        ).rows[0]!;
      },
      undefined,
      { operationLabel: "github-publication.bind-accepted-workspace" },
    );

  const updatePublishingFacts = (input: {
    row: PublicationRow;
    repository: string;
    branch: string;
    baseBranch: string;
    sourceHeadCommit: string;
    workspaceTree: string;
    headCommit: string;
  }): PublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const result = executeSqliteQuerySync(
          db,
          publicationDb(db)
            .updateTable("github_publication_requests")
            .set({
              repository: input.repository,
              branch: input.branch,
              base_branch: input.baseBranch,
              source_head_commit: input.sourceHeadCommit,
              workspace_tree: input.workspaceTree,
              head_commit: input.headCommit,
              updated_at_ms: Date.now(),
            })
            .where("request_id", "=", input.row.request_id)
            .where("status", "=", "publishing")
            .where("gateway_instance_id", "=", instanceId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error("GitHub publication state changed before execution.");
        }
        return executeSqliteQuerySync(
          db,
          publicationDb(db)
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("request_id", "=", input.row.request_id),
        ).rows[0]!;
      },
      undefined,
      { operationLabel: "github-publication.begin" },
    );

  const complete = (row: PublicationRow, result: SessionGitHubPublicationResult): PublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
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
        if (!values) {
          throw new Error("GitHub publication terminal result is invalid.");
        }
        const updated = executeSqliteQuerySync(
          db,
          publicationDb(db)
            .updateTable("github_publication_requests")
            .set({ ...values, updated_at_ms: Date.now() })
            .where("request_id", "=", row.request_id)
            .where("status", "=", "publishing")
            .where("gateway_instance_id", "=", instanceId),
        );
        if (updated.numAffectedRows !== 1n) {
          throw new Error("GitHub publication state changed before completion.");
        }
        return executeSqliteQuerySync(
          db,
          publicationDb(db)
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("request_id", "=", row.request_id),
        ).rows[0]!;
      },
      undefined,
      { operationLabel: "github-publication.complete" },
    );

  const processRow = (
    initial: PublicationRow,
    validateAuthority: () => boolean,
  ): Promise<SessionGitHubPublicationResult> => {
    if (initial.status === "published" || initial.status === "failed") {
      return Promise.resolve(publicationResult(initial));
    }
    const executionKey = `${instanceId}\0${initial.request_id}`;
    const current = activePublicationExecutions.get(executionKey);
    if (current) {
      return current;
    }
    const claimed = claimExecution(initial.request_id, instanceId);
    if (claimed.status === "published" || claimed.status === "failed") {
      return Promise.resolve(publicationResult(claimed));
    }
    const operation = executeGitHubPublication({
      initial: claimed,
      validateAuthority: () => validateAuthority() && ownsExecution(claimed.request_id, instanceId),
      projectResult: publicationResult,
      bindWorkspaceSnapshot,
      updatePublishingFacts,
      complete,
    });
    activePublicationExecutions.set(executionKey, operation);
    const release = () => {
      if (activePublicationExecutions.get(executionKey) === operation) {
        activePublicationExecutions.delete(executionKey);
      }
    };
    void operation.then(release, release);
    return operation;
  };

  const prepareClaimWorkspace = async (claim: WorkerSessionTurnClaim): Promise<void> => {
    ensureSchema();
    params.placements.closeWorkerTurnToolAdmission(claim);
    const db = openOpenClawStateDatabase().db;
    const rows = executeSqliteQuerySync(
      db,
      publicationDb(db)
        .selectFrom("github_publication_requests")
        .selectAll()
        .where("session_id", "=", claim.sessionId)
        .where("claim_id", "=", claim.claimId)
        .where("run_id", "=", claim.runId)
        .where("status", "in", ["requested", "publishing"])
        .orderBy("created_at_ms"),
    ).rows;
    if (rows.length === 0) {
      return;
    }
    if (!params.placements.validateWorkspaceResultClaim(claim)) {
      throw new Error("GitHub publication lost its workspace result claim before snapshot.");
    }
    const first = rows[0]!;
    const { worktree } = resolveGitHubPublicationWorktreeOwner({
      sessionId: first.session_id,
      sessionKey: first.session_key,
      agentId: first.agent_id,
      expected: {
        worktreeId: first.worktree_id,
        repositoryFingerprint: first.repository_fingerprint,
        branch: first.branch,
      },
    });
    for (const row of rows) {
      if (!sameWorktree(row, worktree)) {
        throw new Error("GitHub publication worktree changed before accepted snapshot.");
      }
    }
    const bound = rows.find(
      (row) => row.source_head_commit && row.source_index_tree && row.workspace_tree,
    );
    if (bound) {
      for (const row of rows) {
        if (
          (row.source_head_commit || row.source_index_tree || row.workspace_tree) &&
          (row.source_head_commit !== bound.source_head_commit ||
            row.source_index_tree !== bound.source_index_tree ||
            row.workspace_tree !== bound.workspace_tree)
        ) {
          throw new Error("GitHub publication accepted workspace snapshot changed.");
        }
      }
      if (
        rows.every((row) => row.source_head_commit && row.source_index_tree && row.workspace_tree)
      ) {
        return;
      }
    }
    const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
      cwd: worktree.path,
      assertCurrent: () => {
        if (!params.placements.validateWorkspaceResultClaim(claim)) {
          throw new Error("GitHub publication lost its workspace result claim during snapshot.");
        }
      },
    });
    for (const row of rows) {
      bindAcceptedClaimSnapshot({ row, claim, ...snapshot });
    }
  };

  const failClaimPreparation = (
    claim: WorkerSessionTurnClaim,
    error: unknown,
  ): SessionGitHubPublicationResult[] => {
    ensureSchema();
    const db = openOpenClawStateDatabase().db;
    const rows = executeSqliteQuerySync(
      db,
      publicationDb(db)
        .selectFrom("github_publication_requests")
        .selectAll()
        .where("session_id", "=", claim.sessionId)
        .where("claim_id", "=", claim.claimId)
        .where("run_id", "=", claim.runId)
        .orderBy("created_at_ms"),
    ).rows;
    const failure = resolveGitHubPublicationFailure(error);
    return rows.map((row) => {
      if (row.status === "published" || row.status === "failed") {
        return publicationResult(row);
      }
      const claimed = claimExecution(row.request_id, instanceId);
      return publicationResult(
        complete(claimed, {
          requestId: row.request_id,
          status: "failed",
          code: failure.code,
          message: "GitHub publication failed.",
          nextAction: failure.nextAction,
        }),
      );
    });
  };

  return {
    requestForClaim,
    prepareClaimWorkspace,
    failClaimPreparation,
    ...createGitHubPublicationCoordinatorMethods({
      placements: params.placements,
      instanceId,
      readById,
      requestForClaim,
      sameWorktree,
      processRow,
      failClaimPreparation,
      complete,
    }),
  };
}
