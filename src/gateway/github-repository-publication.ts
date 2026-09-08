import { randomUUID } from "node:crypto";
import type {
  SessionGitHubConfirmParams,
  SessionGitHubPublishParams,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.js";
import { personalGitHubStatus, type PersonalGitHubAction } from "./github-personal-oauth.js";
import {
  assertPersonalGitHubPublicationReplay,
  bindPersonalGitHubPublicationSelection,
  preparePersonalGitHubPublicationSelection,
  type PersonalGitHubSessionAction,
} from "./github-personal-publication.js";
import {
  assertExpectedSharedGitHubPublisher,
  prepareCurrentGitHubPublicationIdentity,
  sameGitHubPublicationWorkspace,
} from "./github-publication-availability.js";
import {
  exactClaimForPlacement,
  type GitHubPublicationClaimRequest,
} from "./github-publication-coordinator-methods.js";
import {
  matchesGitHubPublicationIdentityRow,
  projectGitHubPublicationResult,
} from "./github-publication-store.js";
import {
  executeRepositoryGitHubPublication,
  prepareRepositoryGitHubPublicationTarget,
} from "./github-repository-publication-executor.js";
import {
  createRepositoryGitHubPublicationRecovery,
  matchesRepositoryGitHubPublicationClaim,
} from "./github-repository-publication-recovery.js";
import { readGitHubRepositoryPublicationMetadata } from "./github-repository-publication-snapshot.js";
import {
  bindRepositoryGitHubPublicationCheckpoint,
  claimRepositoryGitHubPublication,
  deferRepositoryGitHubPublicationClaims,
  insertRepositoryGitHubPublication,
  listRepositoryGitHubPublications,
  readRepositoryGitHubPublicationBranch,
  markRepositoryGitHubPublicationReported,
  readRepositoryGitHubPublication,
  requireRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
  terminalRepositoryGitHubPublication,
  type RepositoryGitHubPublicationRow,
} from "./github-repository-publication-store.js";
import {
  repositoryOwner,
  resolveReceiptOwner,
  assertReceiptOwner,
  captureCheckpoint,
  type PreparedRepositoryPublicationSnapshot,
  type RepositoryPublicationSessionIdentity as SessionIdentity,
} from "./github-repository-publication-workspace.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolvePlacementTurnEnvironment } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
type SharedRequest = SessionGitHubPublishParams & {
  agentId: string;
  expectedRunId?: string;
  assertCurrent?: () => void;
};

export function createRepositoryGitHubPublicationCoordinator(
  placements: WorkerSessionPlacementStore,
) {
  const instanceId = placements.workspaceResultInstanceId();
  const active = new Map<string, string>();
  const requestByKey = (sessionId: string, key: string, owner: string | null) =>
    listRepositoryGitHubPublications({ sessionId, idempotencyKey: key, ownerProfileId: owner })[0];
  const personalStatus = (
    row: RepositoryGitHubPublicationRow,
    action: PersonalGitHubAction,
    session: SessionIdentity,
  ): SessionGitHubStatusResult => {
    action.assertCurrent();
    if (
      row.owner_profile_id !== action.owner ||
      row.session_key !== session.sessionKey ||
      row.agent_id !== session.agentId
    ) {
      throw new Error("My GitHub publication was not found for this profile and session.");
    }
    const executing =
      row.execution_id !== null &&
      row.gateway_instance_id === instanceId &&
      active.get(row.request_id) === row.execution_id;
    const pending = !terminalRepositoryGitHubPublication(row) && !executing;
    const connection = pending ? personalGitHubStatus(action) : null;
    const mismatch =
      pending &&
      (row.session_id !== session.sessionId ||
        row.session_lifecycle_revision !== (session.lifecycleRevision ?? null) ||
        !resolveReceiptOwner(row) ||
        connection?.generation !== row.connection_generation ||
        connection.account?.accountId !== row.identity_account_id ||
        connection.account.login.toLowerCase() !== row.identity_login.toLowerCase());
    if (mismatch) {
      return {
        result: projectGitHubPublicationResult({
          ...row,
          status: "failed",
          error_code:
            row.session_id !== session.sessionId ||
            row.session_lifecycle_revision !== (session.lifecycleRevision ?? null) ||
            !resolveReceiptOwner(row)
              ? "session_changed"
              : "identity_changed",
          next_action:
            "Review the original account and any recorded GitHub effects, then create a new publication for the current session.",
        }),
        confirmation: null,
      };
    }
    return {
      result: projectGitHubPublicationResult(
        pending ? { ...row, status: "needs_confirmation" } : row,
      ),
      confirmation:
        pending &&
        row.connection_generation &&
        row.push_repository &&
        row.repository &&
        row.base_branch &&
        row.source_head_commit &&
        row.source_index_tree &&
        row.workspace_tree
          ? {
              requestDigest: row.request_digest,
              generation: row.connection_generation,
              account: { accountId: row.identity_account_id, login: row.identity_login },
              pushRepository: row.push_repository,
              repository: row.repository,
              branch: row.branch,
              baseBranch: row.base_branch,
              sourceHeadCommit: row.source_head_commit,
              sourceIndexTree: row.source_index_tree,
              workspaceTree: row.workspace_tree,
            }
          : null,
    };
  };
  const execute = async (
    initial: RepositoryGitHubPublicationRow,
    assertCurrent: () => void,
    action?: PersonalGitHubSessionAction,
    prepared?: PreparedRepositoryPublicationSnapshot,
  ) => {
    const row = requireRepositoryGitHubPublication(initial.request_id);
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    assertCurrent();
    const { loaded } = assertReceiptOwner(row);
    if (!row.checkpoint_ref) {
      throw new Error("GitHub publication has no accepted checkpoint.");
    }
    const bound =
      action && row.connection_generation
        ? bindPersonalGitHubPublicationSelection(action, {
            generation: row.connection_generation,
            account: { accountId: row.identity_account_id, login: row.identity_login },
          })
        : undefined;
    if (
      (row.owner_profile_id !== null) !== Boolean(bound) ||
      (bound && bound.profileId !== row.identity_profile_id)
    ) {
      throw new Error("My GitHub publication owner changed.");
    }
    const assertExecution = () => {
      // Classify source loss before personal preparation can turn it into a retryable error.
      assertReceiptOwner(row);
      assertCurrent();
      bound?.assertCurrent();
    };
    const publish = async (captured: PreparedRepositoryPublicationSnapshot) => {
      assertExecution();
      if (
        captured.checkpointRef !== row.checkpoint_ref ||
        captured.digest !== row.checkpoint_digest
      ) {
        throw new Error("GitHub publication accepted checkpoint changed.");
      }
      const execution = claimRepositoryGitHubPublication(row, instanceId, assertExecution);
      active.set(row.request_id, execution.row.execution_id!);
      try {
        return await executeRepositoryGitHubPublication({
          execution,
          snapshot: captured.snapshot,
          snapshotRoot: captured.snapshotRoot,
          storePath: loaded.storePath,
          assertWorkspace: () => {
            assertReceiptOwner(row);
          },
          validateAuthority: () => {
            assertExecution();
            return true;
          },
          ...(bound
            ? {
                identity: {
                  prepare: () => preparePersonalGitHubPublicationSelection(bound, assertExecution),
                  isCurrent: (identity: PreparedGitHubPublicationIdentity) => {
                    assertExecution();
                    return (
                      identity.source === "personal" &&
                      identity.profileId === bound.profileId &&
                      identity.account.accountId === row.identity_account_id
                    );
                  },
                },
              }
            : {}),
        });
      } catch (error) {
        if (execution.ownsExecution()) {
          execution.interrupt();
        }
        throw error;
      } finally {
        active.delete(row.request_id);
      }
    };
    if (prepared) {
      return await publish(prepared);
    }
    return await withSessionRepositoryCheckpoint(
      {
        workspaceId: row.workspace_id,
        checkpointRef: row.checkpoint_ref,
        includePublication: true,
      },
      async (payload) => {
        assertExecution();
        if (
          !payload.publicationStagingRoot ||
          !payload.publicationDigest ||
          payload.publicationDigest !== row.checkpoint_digest
        ) {
          throw new Error("GitHub publication accepted checkpoint is unavailable.");
        }
        const { snapshot } = await readGitHubRepositoryPublicationMetadata(
          payload.publicationStagingRoot,
          payload.publicationDigest,
        );
        return await publish({
          snapshot,
          snapshotRoot: payload.publicationStagingRoot,
          checkpointRef: row.checkpoint_ref!,
          digest: payload.publicationDigest,
        });
      },
    );
  };
  const makeRow = (input: {
    session: SessionIdentity;
    workspace: SessionRepositoryWorkspaceRecord;
    request: { idempotencyKey: string; title?: string; body?: string };
    identity: PreparedGitHubPublicationIdentity;
    target: Awaited<ReturnType<typeof prepareRepositoryGitHubPublicationTarget>>;
    action?: PersonalGitHubSessionAction;
    generation?: string;
    claim?: WorkerSessionTurnClaim;
  }): RepositoryGitHubPublicationRow => {
    const { head: previous } = readRepositoryGitHubPublicationBranch({
      workspaceId: input.workspace.workspaceId,
      branch: input.workspace.branch,
      pushRepository: input.target.pushRepository,
    });
    const now = Date.now();
    const row: RepositoryGitHubPublicationRow = {
      request_id: randomUUID(),
      idempotency_key: input.request.idempotencyKey,
      request_digest: "",
      session_id: input.session.sessionId,
      session_lifecycle_revision: input.session.lifecycleRevision ?? null,
      session_key: input.session.sessionKey,
      agent_id: input.session.agentId,
      workspace_id: input.workspace.workspaceId,
      owner_profile_id: input.action?.owner ?? null,
      connection_generation: input.generation ?? null,
      identity_source: input.identity.source,
      identity_profile_id: input.identity.profileId ?? null,
      identity_account_id: input.identity.account.accountId,
      identity_login: input.identity.account.login,
      title: input.request.title ?? null,
      body: input.request.body ?? null,
      push_repository: input.target.pushRepository,
      repository: input.target.repository,
      base_branch: input.target.baseBranch,
      branch: input.workspace.branch,
      previous_head_commit: previous?.pushed_head_commit ?? null,
      claim_id: input.claim?.claimId ?? null,
      run_id: input.claim?.runId ?? null,
      environment_id: input.claim?.owner.environmentId ?? null,
      owner_epoch: input.claim?.owner.ownerEpoch ?? null,
      placement_generation: input.claim?.placementGeneration ?? null,
      checkpoint_ref: null,
      checkpoint_digest: null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
      status: "requested",
      execution_id: null,
      gateway_instance_id: null,
      head_commit: null,
      pushed_head_commit: null,
      pull_request_url: null,
      last_effect: null,
      effect_state: null,
      error_code: null,
      next_action: null,
      created_at_ms: now,
      updated_at_ms: now,
      reported_at_ms: null,
    };
    row.request_digest = repositoryGitHubPublicationDigest(row);
    return row;
  };
  const admitShared = async (input: SharedRequest, claim?: WorkerSessionTurnClaim) => {
    input.assertCurrent?.();
    if (!input.sessionKey) {
      throw new Error("GitHub publication requires an authoritative session.");
    }
    const loaded = loadGatewaySessionEntryReadOnly(input.sessionKey, { agentId: input.agentId });
    if (!loaded.entry?.sessionId) {
      throw new Error("GitHub publication session changed.");
    }
    const session = {
      sessionId: loaded.entry.sessionId,
      lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
      sessionKey: loaded.canonicalKey,
      agentId: input.agentId,
    };
    const initial = repositoryOwner(session);
    const assertCurrent = () => {
      input.assertCurrent?.();
      const placement = claim ? placements.get(session.sessionId) : undefined;
      if (
        !sameGitHubPublicationWorkspace(initial, repositoryOwner(session)) ||
        (claim &&
          (!placement ||
            claim.sessionId !== session.sessionId ||
            placement.agentId !== session.agentId ||
            placement.sessionKey !== session.sessionKey ||
            !resolvePlacementTurnEnvironment(placement, claim)))
      ) {
        throw new Error("GitHub publication session authority changed.");
      }
    };
    assertCurrent();
    const existing = requestByKey(session.sessionId, input.idempotencyKey, null);
    if (
      existing &&
      (existing.workspace_id !== initial.workspace.workspaceId ||
        existing.title !== (input.title ?? null) ||
        existing.body !== (input.body ?? null))
    ) {
      throw new Error("GitHub publication idempotency key was reused.");
    }
    const expected = input.selection?.source === "shared" ? input.selection.expected : undefined;
    if (existing && terminalRepositoryGitHubPublication(existing)) {
      const result = projectGitHubPublicationResult(existing);
      assertExpectedSharedGitHubPublisher(expected, result.publisher!);
      return existing;
    }
    const identity = await prepareCurrentGitHubPublicationIdentity(input.agentId);
    assertCurrent();
    assertExpectedSharedGitHubPublisher(
      expected,
      { source: identity.source, ...identity.account },
      existing
        ? undefined
        : {
            idempotencyKey: input.idempotencyKey,
            hasRequest: () => Boolean(requestByKey(session.sessionId, input.idempotencyKey, null)),
          },
    );
    if (existing) {
      if (!matchesGitHubPublicationIdentityRow(existing, identity)) {
        throw new Error("GitHub publication identity changed.");
      }
      return existing;
    }
    const target = await prepareRepositoryGitHubPublicationTarget(
      initial.workspace,
      identity,
      assertCurrent,
    );
    assertCurrent();
    const row = makeRow({
      session,
      workspace: initial.workspace,
      request: input,
      identity,
      target,
      claim,
    });
    return insertRepositoryGitHubPublication(row, assertCurrent);
  };
  const prepareClaimWorkspace = async (claim: WorkerSessionTurnClaim) => {
    const assertCurrent = () => {
      if (!placements.validateWorkspaceResultClaim(claim)) {
        throw new Error("GitHub publication lost its workspace result claim.");
      }
    };
    const pending = listRepositoryGitHubPublications({
      sessionId: claim.sessionId,
      ownerProfileId: null,
      pending: true,
    });
    for (const row of pending.filter(
      (candidate) =>
        !candidate.checkpoint_ref &&
        (candidate.claim_id === null || matchesRepositoryGitHubPublicationClaim(candidate, claim)),
    )) {
      await captureCheckpoint(row, assertCurrent, async (facts) => {
        bindRepositoryGitHubPublicationCheckpoint(row, facts, assertCurrent);
      });
    }
  };
  return {
    async requestForClaim(input: GitHubPublicationClaimRequest) {
      const expected = input.expectedPublisher;
      if (expected?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const row = await admitShared(
        {
          ...input,
          selection: {
            source: "shared",
            ...(expected
              ? {
                  expected: {
                    source: expected.source,
                    accountId: expected.accountId,
                    login: expected.login,
                  },
                }
              : {}),
          },
        },
        input.claim,
      );
      return projectGitHubPublicationResult(row);
    },
    async requestForSession(input: SharedRequest) {
      if (input.selection?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const loaded = loadGatewaySessionEntryReadOnly(input.sessionKey!, { agentId: input.agentId });
      const placement = loaded.entry?.sessionId
        ? placements.get(loaded.entry.sessionId)
        : undefined;
      const currentClaim = placement ? exactClaimForPlacement(placement) : undefined;
      if (input.expectedRunId !== undefined && input.expectedRunId !== currentClaim?.runId) {
        throw new Error("GitHub publication run identity changed.");
      }
      const claim = input.expectedRunId !== undefined ? currentClaim : undefined;
      let row = await admitShared(input, claim);
      if (
        terminalRepositoryGitHubPublication(row) ||
        claim ||
        placements.get(row.session_id)?.turnClaim
      ) {
        return projectGitHubPublicationResult(row);
      }
      const workspace = assertReceiptOwner(row).workspace;
      if (!row.checkpoint_ref && !workspace.checkpointRef) {
        return projectGitHubPublicationResult(row);
      }
      return await placements.withRepositoryWorkspaceReservation(
        {
          sessionId: row.session_id,
          sessionKey: row.session_key,
          agentId: row.agent_id,
        },
        async (assertReservation) => {
          row = requireRepositoryGitHubPublication(row.request_id);
          if (terminalRepositoryGitHubPublication(row)) {
            return projectGitHubPublicationResult(row);
          }
          const assertCurrent = () => {
            input.assertCurrent?.();
            assertReservation();
            assertReceiptOwner(row);
          };
          if (!row.checkpoint_ref) {
            return await captureCheckpoint(row, assertCurrent, async (facts, prepared) => {
              row = bindRepositoryGitHubPublicationCheckpoint(row, facts, assertCurrent);
              return await execute(row, assertCurrent, undefined, prepared);
            });
          }
          return await execute(row, assertCurrent);
        },
      );
    },
    async requestPersonalForSession(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionAction,
    ) {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const existing = requestByKey(action.sessionId, input.idempotencyKey, action.owner);
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        return personalStatus(existing, action, action).result;
      }
      const bound = bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () =>
          Boolean(requestByKey(action.sessionId, input.idempotencyKey, action.owner)),
      });
      return await placements.withRepositoryWorkspaceReservation(
        action,
        async (assertReservation) => {
          const initial = repositoryOwner(action);
          const assertCurrent = () => {
            action.assertCurrent();
            assertReservation();
            bound.assertCurrent();
            if (!sameGitHubPublicationWorkspace(initial, repositoryOwner(action))) {
              throw new Error("My GitHub repository owner changed.");
            }
          };
          const identity = await preparePersonalGitHubPublicationSelection(bound, assertCurrent);
          const target = await prepareRepositoryGitHubPublicationTarget(
            initial.workspace,
            identity,
            assertCurrent,
          );
          const row = insertRepositoryGitHubPublication(
            makeRow({
              session: action,
              workspace: initial.workspace,
              request: input,
              identity,
              target,
              action,
              generation: selected.generation,
            }),
            assertCurrent,
          );
          return await captureCheckpoint(
            row,
            assertCurrent,
            async (facts, prepared) =>
              await execute(
                bindRepositoryGitHubPublicationCheckpoint(row, facts, assertCurrent),
                assertCurrent,
                action,
                prepared,
              ),
          );
        },
      );
    },
    prepareClaimWorkspace,
    deferClaimPreparation(claim: WorkerSessionTurnClaim) {
      deferRepositoryGitHubPublicationClaims(
        listRepositoryGitHubPublications({
          sessionId: claim.sessionId,
          ownerProfileId: null,
          pending: true,
        })
          .filter((row) => matchesRepositoryGitHubPublicationClaim(row, claim))
          .map((row) => row.request_id),
      );
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      const results = [];
      for (const row of listRepositoryGitHubPublications({
        sessionId: claim.sessionId,
        ownerProfileId: null,
        pending: true,
      }).filter(
        (candidate) =>
          candidate.checkpoint_ref &&
          (candidate.claim_id === null ||
            matchesRepositoryGitHubPublicationClaim(candidate, claim)),
      )) {
        results.push(
          await placements.withWorkspaceExclusion(
            row.session_id,
            async (assertOwned) =>
              await execute(row, () => {
                assertOwned();
                if (!placements.validateWorkspaceResultClaim(claim)) {
                  throw new Error("GitHub publication lost its workspace result claim.");
                }
              }),
          ),
        );
      }
      return results;
    },
    ...createRepositoryGitHubPublicationRecovery({
      placements,
      isExecuting: (requestId) => active.has(requestId),
      execute: (row, assertCurrent, prepared) => execute(row, assertCurrent, undefined, prepared),
    }),
    personalStatus(action: PersonalGitHubAction, session: SessionIdentity, requestId: string) {
      const row = readRepositoryGitHubPublication(requestId);
      return row ? personalStatus(row, action, session) : undefined;
    },
    personalPending(action: PersonalGitHubAction, session: SessionIdentity) {
      action.assertCurrent();
      const row = listRepositoryGitHubPublications({
        ownerProfileId: action.owner,
        sessionKey: session.sessionKey,
        agentId: session.agentId,
        pending: true,
      }).at(-1);
      return row ? personalStatus(row, action, session) : null;
    },
    async confirmPersonal(input: SessionGitHubConfirmParams, action: PersonalGitHubSessionAction) {
      action.assertCurrent();
      const row = readRepositoryGitHubPublication(input.requestId);
      if (
        !row ||
        row.owner_profile_id !== action.owner ||
        row.session_id !== action.sessionId ||
        (!terminalRepositoryGitHubPublication(row) &&
          row.session_lifecycle_revision !== action.lifecycleRevision) ||
        row.session_key !== action.sessionKey ||
        row.agent_id !== action.agentId ||
        row.request_digest !== input.requestDigest ||
        row.connection_generation !== input.generation ||
        row.identity_account_id !== input.account.accountId ||
        row.identity_login.toLowerCase() !== input.account.login.toLowerCase()
      ) {
        throw new Error("My GitHub confirmation no longer matches the original request.");
      }
      if (terminalRepositoryGitHubPublication(row)) {
        return projectGitHubPublicationResult(row);
      }
      if (active.has(row.request_id)) {
        throw new Error("My GitHub publication is still running; wait for its result.");
      }
      bindPersonalGitHubPublicationSelection(action, input);
      return await placements.withRepositoryWorkspaceReservation(
        action,
        async (assertReservation) =>
          await execute(
            row,
            () => {
              action.assertCurrent();
              assertReservation();
            },
            action,
          ),
      );
    },
    read(requestId: string) {
      const row = readRepositoryGitHubPublication(requestId);
      return row && row.owner_profile_id === null ? projectGitHubPublicationResult(row) : undefined;
    },
    hasRequest: (requestId: string) => Boolean(readRepositoryGitHubPublication(requestId)),
    listUnreportedResults: () =>
      listRepositoryGitHubPublications({ pending: false, unreported: true }).map((row) => ({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        result: projectGitHubPublicationResult(row),
      })),
    markReported: markRepositoryGitHubPublicationReported,
  };
}
