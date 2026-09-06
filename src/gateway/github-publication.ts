import { randomUUID } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createPersonalGitHubPublicationCoordinator } from "./github-personal-publication.js";
import {
  assertExpectedSharedGitHubPublisher,
  prepareCurrentGitHubPublicationIdentity,
  resolveGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import {
  createGitHubPublicationCoordinatorMethods,
  type GitHubPublicationClaimRequest,
} from "./github-publication-coordinator-methods.js";
import { executeGitHubPublication } from "./github-publication-executor.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import {
  claimGitHubPublicationExecution as claimExecution,
  createGitHubPublicationExecutionStore,
  deferGitHubPublicationRequests as deferRequests,
  digestGitHubPublicationRequest as digestRequest,
  insertGitHubPublicationRequest,
  ensureGitHubPublicationStore as ensureSchema,
  githubPublicationDatabase as publicationDb,
  isGitHubPublicationExecutionOwner as ownsExecution,
  listGitHubPublicationsForClaim,
  projectGitHubPublicationResult as publicationResult,
  readGitHubPublicationRequest,
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
    return readGitHubPublicationRequest(db, { requestId });
  };

  const requestForClaim = async (
    request: GitHubPublicationClaimRequest,
  ): Promise<SessionGitHubPublicationResult> => {
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
    assertExpectedSharedGitHubPublisher(
      request.expectedPublisher,
      { source: identity.source, ...identity.account },
      {
        idempotencyKey: request.idempotencyKey,
        hasRequest: () =>
          Boolean(
            readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
              sessionId: request.claim.sessionId,
              idempotencyKey: request.idempotencyKey,
            }),
          ),
      },
    );
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
        const stored = insertGitHubPublicationRequest(db, {
          request,
          requestId,
          requestDigest,
          now,
          identity,
          worktree,
          sessionId: request.claim.sessionId,
          claim: request.claim,
        });
        if (!sameClaim(stored, request.claim)) {
          throw new Error("GitHub publication idempotency key was reused.");
        }
        return stored;
      },
      undefined,
      { operationLabel: "github-publication.request" },
    );
    return publicationResult(row);
  };

  const { bindWorkspaceSnapshot, updatePublishingFacts, complete } =
    createGitHubPublicationExecutionStore(instanceId);

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
        const current = readGitHubPublicationRequest(db, { requestId: input.row.request_id });
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
        const updated = executeSqliteQueryTakeFirstSync(
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
            .where("workspace_tree", "is", null)
            .returningAll(),
        );
        if (!updated) {
          throw new Error("GitHub publication accepted workspace snapshot changed.");
        }
        return updated;
      },
      undefined,
      { operationLabel: "github-publication.bind-accepted-workspace" },
    );

  const processRow = (
    initial: PublicationRow,
    validateAuthority: () => boolean,
  ): Promise<SessionGitHubPublicationResult> => {
    if (initial.status === "published" || initial.status === "failed") {
      return Promise.resolve(publicationResult(initial));
    }
    const executionKey = `${instanceId}\0${initial.request_id}`;
    return getOrCreatePromise(
      activePublicationExecutions,
      executionKey,
      () => {
        const claimed = claimExecution(initial.request_id, instanceId);
        if (claimed.status === "published" || claimed.status === "failed") {
          return Promise.resolve(publicationResult(claimed));
        }
        return params.placements.withWorkspaceExclusion(claimed.session_id, async (assertOwned) => {
          const lease = await acquireWorktreeRunLease(claimed.worktree_id);
          try {
            assertOwned();
            return await executeGitHubPublication({
              initial: claimed,
              validateAuthority: () => {
                assertOwned();
                return validateAuthority() && ownsExecution(claimed.request_id, instanceId);
              },
              projectResult: publicationResult,
              bindWorkspaceSnapshot,
              updatePublishingFacts,
              complete,
              defer: (row) => {
                deferRequests([row.request_id]);
                const deferred = readById(row.request_id);
                if (!deferred) {
                  throw new Error("GitHub publication request disappeared.");
                }
                return deferred;
              },
            });
          } finally {
            await lease.release();
          }
        });
      },
      { evictOnSettled: true },
    );
  };

  const prepareClaimWorkspace = async (claim: WorkerSessionTurnClaim): Promise<void> => {
    ensureSchema();
    params.placements.closeWorkerTurnToolAdmission(claim);
    const rows = listGitHubPublicationsForClaim(claim, { pendingOnly: true });
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

  const deferClaimPreparation = (claim: WorkerSessionTurnClaim): void => {
    ensureSchema();
    const rows = listGitHubPublicationsForClaim(claim, { pendingOnly: true });
    deferRequests(rows.map((row) => row.request_id));
  };

  return {
    ...createPersonalGitHubPublicationCoordinator(params.placements),
    requestForClaim,
    prepareClaimWorkspace,
    deferClaimPreparation,
    ...createGitHubPublicationCoordinatorMethods({
      placements: params.placements,
      readById,
      requestForClaim,
      sameWorktree,
      processRow,
    }),
  };
}
