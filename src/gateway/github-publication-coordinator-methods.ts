import { randomUUID } from "node:crypto";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  prepareCurrentGitHubPublicationIdentity,
  resolveGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import {
  captureGitHubPublicationWorkspaceSnapshot,
  matchesGitHubPublicationIdentityRow,
} from "./github-publication-executor.js";
import {
  claimGitHubPublicationExecution as claimExecution,
  digestGitHubPublicationRequest as digestRequest,
  ensureGitHubPublicationStore as ensureSchema,
  githubPublicationDatabase as publicationDb,
  hasGitHubPublicationStore as schemaExists,
  projectGitHubPublicationResult as publicationResult,
  type GitHubPublicationRow as PublicationRow,
} from "./github-publication-store.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

type ClaimRequest = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  agentId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
  assertCurrent?: () => void;
};

function exactClaimForPlacement(
  placement: NonNullable<ReturnType<WorkerSessionPlacementStore["get"]>>,
): WorkerSessionTurnClaim | undefined {
  const claim = placement.turnClaim;
  if (!claim) {
    return undefined;
  }
  if (claim.owner === "worker") {
    if (
      (placement.state !== "active" && placement.state !== "draining") ||
      !placement.environmentId ||
      placement.activeOwnerEpoch !== claim.ownerEpoch
    ) {
      return undefined;
    }
    return {
      sessionId: placement.sessionId,
      claimId: claim.claimId,
      runId: claim.runId,
      placementGeneration: claim.generation,
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: claim.ownerEpoch,
      },
    };
  }
  return {
    sessionId: placement.sessionId,
    claimId: claim.claimId,
    runId: claim.runId,
    placementGeneration: claim.generation,
    owner: {
      kind: "local",
      ...(placement.environmentId ? { environmentId: placement.environmentId } : {}),
      ...(placement.activeOwnerEpoch !== null ? { ownerEpoch: placement.activeOwnerEpoch } : {}),
    },
  };
}

export function createGitHubPublicationCoordinatorMethods(params: {
  placements: WorkerSessionPlacementStore;
  instanceId: string;
  readById: (requestId: string) => PublicationRow | undefined;
  requestForClaim: (request: ClaimRequest) => Promise<SessionGitHubPublicationResult>;
  sameWorktree: (
    row: PublicationRow,
    worktree: ReturnType<typeof resolveGitHubPublicationWorktreeOwner>["worktree"],
  ) => boolean;
  processRow: (
    initial: PublicationRow,
    validateAuthority: () => boolean,
  ) => Promise<SessionGitHubPublicationResult>;
  failClaimPreparation: (
    claim: WorkerSessionTurnClaim,
    error: unknown,
  ) => SessionGitHubPublicationResult[];
  complete: (row: PublicationRow, result: SessionGitHubPublicationResult) => PublicationRow;
}) {
  const {
    readById,
    requestForClaim,
    sameWorktree,
    processRow,
    failClaimPreparation,
    instanceId,
    complete,
  } = params;
  return {
    async requestForSession(
      input: SessionGitHubPublishParams & {
        agentId: string;
        expectedRunId?: string;
        assertCurrent?: () => void;
      },
    ): Promise<SessionGitHubPublicationResult> {
      ensureSchema();
      if (!input.sessionKey) {
        throw new Error("GitHub publication requires an authoritative session.");
      }
      input.assertCurrent?.();
      const initialLoaded = loadGatewaySessionEntryReadOnly(input.sessionKey, {
        agentId: input.agentId,
      });
      const sessionId = initialLoaded.entry?.sessionId;
      if (!sessionId) {
        throw new Error("GitHub publication session changed.");
      }
      const initialAuthority = resolveGitHubPublicationWorktreeOwner({
        sessionId,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
      });
      const loaded = initialAuthority.loaded;
      const placement = params.placements.get(sessionId);
      const capturePlacement = placement
        ? {
            state: placement.state,
            generation: placement.generation,
            updatedAtMs: placement.updatedAtMs,
          }
        : null;
      const assertCaptureAuthority = () => {
        input.assertCurrent?.();
        const current = params.placements.get(sessionId);
        const unchanged = capturePlacement
          ? current?.state === capturePlacement.state &&
            current.generation === capturePlacement.generation &&
            current.updatedAtMs === capturePlacement.updatedAtMs &&
            !current.turnClaim
          : current === undefined;
        if (!unchanged) {
          throw new Error("GitHub publication session authority changed during snapshot.");
        }
      };
      const claim = placement ? exactClaimForPlacement(placement) : undefined;
      if (claim) {
        if (!input.expectedRunId) {
          throw new Error("GitHub publication cannot join another active session turn.");
        }
        if (claim.runId !== input.expectedRunId) {
          throw new Error("GitHub publication run identity changed.");
        }
        const accepted = await requestForClaim({
          claim,
          sessionKey: loaded.canonicalKey,
          agentId: input.agentId,
          idempotencyKey: input.idempotencyKey,
          ...(input.title ? { title: input.title } : {}),
          ...(input.body ? { body: input.body } : {}),
          ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}),
        });
        input.assertCurrent?.();
        if (placement?.state !== "local") {
          return accepted;
        }
        const row = readById(accepted.requestId);
        if (!row) {
          throw new Error("GitHub publication request disappeared.");
        }
        return await processRow(row, () => {
          input.assertCurrent?.();
          return params.placements.validateTurnClaim(claim);
        });
      }
      if (placement && placement.state !== "local") {
        throw new Error(
          "GitHub publication for a cloud session must be requested by its next live turn.",
        );
      }
      const { worktree } = resolveGitHubPublicationWorktreeOwner({
        sessionId,
        sessionKey: loaded.canonicalKey,
        agentId: input.agentId,
      });
      const requestDigest = digestRequest({
        sessionId,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        body: input.body,
      });
      const database = openOpenClawStateDatabase().db;
      const existing = executeSqliteQuerySync(
        database,
        publicationDb(database)
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", input.idempotencyKey),
      ).rows[0];
      if (existing) {
        if (existing.request_digest !== requestDigest || !sameWorktree(existing, worktree)) {
          throw new Error("GitHub publication idempotency key was reused.");
        }
        if (existing.status === "published" || existing.status === "failed") {
          return publicationResult(existing);
        }
      }
      input.assertCurrent?.();
      const identity = await prepareCurrentGitHubPublicationIdentity(input.agentId);
      input.assertCurrent?.();
      const current = params.placements.get(sessionId);
      if ((current && current.state !== "local") || current?.turnClaim) {
        throw new Error("GitHub publication session authority changed after verification.");
      }
      const snapshot =
        existing?.source_head_commit && existing.source_index_tree && existing.workspace_tree
          ? {
              sourceHeadCommit: existing.source_head_commit,
              sourceIndexTree: existing.source_index_tree,
              workspaceTree: existing.workspace_tree,
            }
          : await captureGitHubPublicationWorkspaceSnapshot({
              cwd: worktree.path,
              assertCurrent: assertCaptureAuthority,
            });
      assertCaptureAuthority();
      resolveGitHubPublicationWorktreeOwner({
        sessionId,
        sessionKey: loaded.canonicalKey,
        agentId: input.agentId,
        expected: {
          worktreeId: worktree.id,
          repositoryFingerprint: worktree.repoFingerprint,
          branch: worktree.branch,
        },
      });
      const now = Date.now();
      const requestId = randomUUID();
      input.assertCurrent?.();
      const row = runOpenClawStateWriteTransaction(
        ({ db }) => {
          const query = publicationDb(db);
          executeSqliteQuerySync(
            db,
            query
              .insertInto("github_publication_requests")
              .values({
                request_id: requestId,
                idempotency_key: input.idempotencyKey,
                request_digest: requestDigest,
                session_id: sessionId,
                session_key: loaded.canonicalKey,
                agent_id: input.agentId,
                worktree_id: worktree.id,
                repository_fingerprint: worktree.repoFingerprint,
                claim_id: null,
                run_id: null,
                environment_id: null,
                owner_epoch: null,
                placement_generation: null,
                identity_source: identity.source,
                identity_profile_id: identity.profileId ?? null,
                identity_account_id: identity.account.accountId,
                identity_login: identity.account.login,
                title: input.title ?? null,
                body: input.body ?? null,
                status: "requested",
                gateway_instance_id: null,
                repository: null,
                branch: worktree.branch,
                base_branch: null,
                source_head_commit: snapshot.sourceHeadCommit,
                source_index_tree: snapshot.sourceIndexTree,
                workspace_tree: snapshot.workspaceTree,
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
              .where("session_id", "=", sessionId)
              .where("idempotency_key", "=", input.idempotencyKey),
          ).rows[0];
          if (
            !stored ||
            stored.request_digest !== requestDigest ||
            !matchesGitHubPublicationIdentityRow(stored, identity) ||
            !sameWorktree(stored, worktree)
          ) {
            throw new Error("GitHub publication idempotency key was reused.");
          }
          return stored;
        },
        undefined,
        { operationLabel: "github-publication.request-idle" },
      );
      return await processRow(row, () => {
        input.assertCurrent?.();
        const latest = params.placements.get(sessionId);
        return (!latest || latest.state === "local") && !latest?.turnClaim;
      });
    },

    async resumeLocalRequests(): Promise<void> {
      if (!schemaExists()) {
        return;
      }
      const db = openOpenClawStateDatabase().db;
      const rows = executeSqliteQuerySync(
        db,
        publicationDb(db)
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("claim_id", "is", null)
          .where("status", "in", ["requested", "publishing"])
          .orderBy("created_at_ms"),
      ).rows;
      for (const row of rows) {
        await processRow(row, () => {
          const placement = params.placements.get(row.session_id);
          return (!placement || placement.state === "local") && !placement?.turnClaim;
        });
      }
    },

    async processClaim(claim: WorkerSessionTurnClaim): Promise<SessionGitHubPublicationResult[]> {
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
      if (
        rows.some((row) => !row.source_head_commit || !row.source_index_tree || !row.workspace_tree)
      ) {
        return failClaimPreparation(
          claim,
          new Error("GitHub publication accepted workspace snapshot is missing."),
        );
      }
      const results: SessionGitHubPublicationResult[] = [];
      for (const row of rows) {
        results.push(
          await processRow(row, () => params.placements.validateWorkspaceResultClaim(claim)),
        );
      }
      return results;
    },

    failOrphanedRequests(): Array<{
      sessionId: string;
      sessionKey: string;
      agentId: string;
      result: SessionGitHubPublicationResult;
    }> {
      if (!schemaExists()) {
        return [];
      }
      const pending = new Set(
        params.placements
          .listPendingWorkspaceResults()
          .map((row) => `${row.sessionId}\0${row.claimId}\0${row.runId}`),
      );
      const db = openOpenClawStateDatabase().db;
      const rows = executeSqliteQuerySync(
        db,
        publicationDb(db)
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("status", "in", ["requested", "publishing"])
          .orderBy("created_at_ms"),
      ).rows;
      return rows.flatMap((row) => {
        // Claim-less rows are local publication requests. The startup/periodic
        // sweep resumes them against their persisted worktree authority.
        if (row.claim_id === null) {
          return [];
        }
        const ownerKey = `${row.session_id}\0${row.claim_id}\0${row.run_id}`;
        const placement = params.placements.get(row.session_id);
        const liveClaim = placement?.turnClaim;
        const stillLive =
          liveClaim?.claimId === row.claim_id &&
          liveClaim.runId === row.run_id &&
          liveClaim.generation === row.placement_generation;
        if (pending.has(ownerKey) || stillLive) {
          return [];
        }
        const claimed = claimExecution(row.request_id, instanceId);
        const terminal = publicationResult(
          complete(claimed, {
            requestId: row.request_id,
            status: "failed",
            code: "session_changed",
            message: "GitHub publication failed.",
            nextAction:
              "The originating turn ended before its workspace result was accepted. Start a new turn and request publication again.",
          }),
        );
        return [
          {
            sessionId: row.session_id,
            sessionKey: row.session_key,
            agentId: row.agent_id,
            result: terminal,
          },
        ];
      });
    },

    listUnreportedResults(): Array<{
      sessionId: string;
      sessionKey: string;
      agentId: string;
      result: SessionGitHubPublicationResult;
    }> {
      if (!schemaExists()) {
        return [];
      }
      const db = openOpenClawStateDatabase().db;
      return executeSqliteQuerySync(
        db,
        publicationDb(db)
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("status", "in", ["published", "failed"])
          .where("reported_at_ms", "is", null)
          .orderBy("updated_at_ms"),
      ).rows.map((row) => ({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        result: publicationResult(row),
      }));
    },

    read(requestId: string): SessionGitHubPublicationResult | undefined {
      const row = readById(requestId);
      return row ? publicationResult(row) : undefined;
    },

    markReported(requestId: string): void {
      ensureSchema();
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            publicationDb(db)
              .updateTable("github_publication_requests")
              .set({ reported_at_ms: Date.now(), updated_at_ms: Date.now() })
              .where("request_id", "=", requestId)
              .where("reported_at_ms", "is", null),
          );
        },
        undefined,
        { operationLabel: "github-publication.report" },
      );
    },
  };
}
