import { createHash, randomUUID } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureRepositoryGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createGitHubPublicationExecutionEffects } from "./github-publication-execution-effects.js";

export type RepositoryGitHubPublicationRow = DB["github_repository_publication_requests"];
const checkpointColumns = [
  "checkpoint_ref",
  "checkpoint_digest",
  "source_head_commit",
  "source_index_tree",
  "workspace_tree",
] satisfies (keyof RepositoryGitHubPublicationRow)[];
const table = "github_repository_publication_requests";
const query = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<Pick<DB, typeof table>>(db);

export function repositoryGitHubPublicationDigest(row: RepositoryGitHubPublicationRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.request_id,
        row.owner_profile_id,
        row.connection_generation,
        row.idempotency_key,
        row.session_id,
        row.session_lifecycle_revision,
        row.session_key,
        row.agent_id,
        row.workspace_id,
        row.identity_source,
        row.identity_profile_id,
        row.identity_account_id,
        row.identity_login,
        row.title,
        row.body,
        row.push_repository,
        row.repository,
        row.branch,
        row.base_branch,
        row.checkpoint_ref,
        row.checkpoint_digest,
        row.source_head_commit,
        row.source_index_tree,
        row.workspace_tree,
        row.previous_head_commit,
        row.created_at_ms,
      ]),
    )
    .digest("hex");
}

function checked(row: RepositoryGitHubPublicationRow): RepositoryGitHubPublicationRow {
  if (
    repositoryGitHubPublicationDigest(row) !== row.request_digest ||
    (row.identity_source === "personal") !== (row.owner_profile_id !== null)
  ) {
    throw new Error("GitHub repository publication receipt is corrupt.");
  }
  return row;
}

export function listRepositoryGitHubPublications(
  filter: {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    workspaceId?: string;
    ownerProfileId?: string | null;
    idempotencyKey?: string;
    pending?: boolean;
    unreported?: boolean;
  } = {},
): RepositoryGitHubPublicationRow[] {
  const db = openOpenClawStateDatabase().db;
  if (!tableExists(db, table)) {
    return [];
  }
  let selection = query(db).selectFrom(table).selectAll();
  if (filter.sessionId !== undefined) {
    selection = selection.where("session_id", "=", filter.sessionId);
  }
  if (filter.sessionKey !== undefined) {
    selection = selection.where("session_key", "=", filter.sessionKey);
  }
  if (filter.agentId !== undefined) {
    selection = selection.where("agent_id", "=", filter.agentId);
  }
  if (filter.workspaceId !== undefined) {
    selection = selection.where("workspace_id", "=", filter.workspaceId);
  }
  if (filter.ownerProfileId !== undefined) {
    selection = selection.where(
      "owner_profile_id",
      filter.ownerProfileId === null ? "is" : "=",
      filter.ownerProfileId,
    );
  }
  if (filter.idempotencyKey !== undefined) {
    selection = selection.where("idempotency_key", "=", filter.idempotencyKey);
  }
  if (filter.pending !== undefined) {
    selection = selection.where(
      "status",
      "in",
      filter.pending ? ["requested", "publishing", "needs_confirmation"] : ["published", "failed"],
    );
  }
  if (filter.unreported) {
    selection = selection.where("reported_at_ms", "is", null);
  }
  return executeSqliteQuerySync(
    db,
    selection.orderBy("updated_at_ms").orderBy("request_id"),
  ).rows.map(checked);
}

/** A pushed branch outlives its publisher and the request's PR outcome. */
export function readRepositoryGitHubPublicationBranch(input: {
  workspaceId: string;
  branch: string;
  pushRepository: string;
}) {
  const rows = listRepositoryGitHubPublications({ workspaceId: input.workspaceId }).filter(
    (row) => row.branch === input.branch && row.push_repository === input.pushRepository,
  );
  const pushed = rows.filter((row) => row.pushed_head_commit !== null);
  // Retried ancestors may have newer timestamps; follow recorded parent links instead.
  const ancestors = new Set(pushed.map((row) => row.previous_head_commit));
  return {
    head: pushed.findLast((row) => !ancestors.has(row.pushed_head_commit)),
    unsettled: rows.some(
      (row) => !terminalRepositoryGitHubPublication(row) && row.effect_state === "dispatched",
    ),
  };
}

export function readRepositoryGitHubPublication(
  requestId: string,
): RepositoryGitHubPublicationRow | undefined {
  const db = openOpenClawStateDatabase().db;
  if (!tableExists(db, table)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db).selectFrom(table).selectAll().where("request_id", "=", requestId),
  );
  return row ? checked(row) : undefined;
}

export function requireRepositoryGitHubPublication(
  requestId: string,
): RepositoryGitHubPublicationRow {
  const row = readRepositoryGitHubPublication(requestId);
  if (!row) {
    throw new Error("GitHub publication request no longer exists.");
  }
  return row;
}

export function insertRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  assertCurrent: () => void,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      ensureRepositoryGitHubPublicationSchema(db);
      checked(row);
      executeSqliteQuerySync(
        db,
        query(db)
          .insertInto(table)
          .values(row)
          .onConflict((conflict) => conflict.doNothing()),
      );
      const stored = executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom(table)
          .selectAll()
          .where("session_id", "=", row.session_id)
          .where("idempotency_key", "=", row.idempotency_key)
          .where(
            "owner_profile_id",
            row.owner_profile_id === null ? "is" : "=",
            row.owner_profile_id,
          ),
      );
      if (
        !stored ||
        (
          [
            "session_key",
            "session_lifecycle_revision",
            "agent_id",
            "workspace_id",
            "owner_profile_id",
            "connection_generation",
            "identity_source",
            "identity_profile_id",
            "identity_account_id",
            "identity_login",
            "title",
            "body",
            "claim_id",
            "run_id",
            "placement_generation",
            "environment_id",
            "owner_epoch",
          ] satisfies (keyof RepositoryGitHubPublicationRow)[]
        ).some((key) => stored[key] !== row[key])
      ) {
        throw new Error("GitHub publication idempotency key was reused.");
      }
      return checked(stored);
    },
    undefined,
    { operationLabel: "github-repository-publication.request" },
  );
}

export function bindRepositoryGitHubPublicationCheckpoint(
  row: RepositoryGitHubPublicationRow,
  checkpoint: Pick<RepositoryGitHubPublicationRow, (typeof checkpointColumns)[number]>,
  assertCurrent: () => void,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      const current = readRepositoryGitHubPublication(row.request_id);
      if (
        !current ||
        current.request_digest !== row.request_digest ||
        current.status !== "requested"
      ) {
        throw new Error("GitHub publication checkpoint owner changed.");
      }
      if (current.checkpoint_ref !== null) {
        if (checkpointColumns.some((key) => current[key] !== checkpoint[key])) {
          throw new Error("GitHub publication accepted checkpoint changed.");
        }
        return current;
      }
      const bound = { ...current, ...checkpoint, updated_at_ms: Date.now() };
      bound.request_digest = repositoryGitHubPublicationDigest(bound);
      const updated = executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .updateTable(table)
          .set(bound)
          .where("request_id", "=", row.request_id)
          .where("checkpoint_ref", "is", null)
          .where("request_digest", "=", current.request_digest)
          .returningAll(),
      );
      if (!updated) {
        throw new Error("GitHub publication checkpoint ownership changed.");
      }
      return updated;
    },
    undefined,
    { operationLabel: "github-repository-publication.checkpoint" },
  );
}

export function failRepositoryGitHubPublicationPreparation(
  row: RepositoryGitHubPublicationRow,
  nextAction: string,
  assertCurrent: () => void,
): RepositoryGitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      const updated = executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .updateTable(table)
          .set({
            status: "failed",
            error_code: "unavailable",
            next_action: nextAction,
            updated_at_ms: Date.now(),
          })
          .where("request_id", "=", row.request_id)
          .where("request_digest", "=", row.request_digest)
          .where("status", "=", "requested")
          .where("checkpoint_ref", "is", null)
          .where("execution_id", "is", null)
          .returningAll(),
      );
      if (!updated) {
        throw new Error("GitHub publication preparation owner changed.");
      }
      return checked(updated);
    },
    undefined,
    { operationLabel: "github-repository-publication.unavailable" },
  );
}

export function claimRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  instanceId: string,
  assertCurrent: () => void,
) {
  const executionId = randomUUID();
  const claimed = runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      if (!row.checkpoint_ref || !row.checkpoint_digest || !row.workspace_tree) {
        throw new Error("GitHub publication requires its accepted checkpoint.");
      }
      const current = readRepositoryGitHubPublication(row.request_id);
      if (!current || current.request_digest !== row.request_digest) {
        throw new Error("GitHub publication receipt changed.");
      }
      const updated = executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .updateTable(table)
          .set({
            status: "publishing",
            gateway_instance_id: instanceId,
            execution_id: executionId,
            updated_at_ms: Date.now(),
          })
          .where("request_id", "=", row.request_id)
          .where("request_digest", "=", row.request_digest)
          .where("status", "=", row.status)
          .where("execution_id", row.execution_id === null ? "is" : "=", row.execution_id)
          .returningAll(),
      );
      if (!updated) {
        throw new Error("GitHub publication execution changed.");
      }
      return updated;
    },
    undefined,
    { operationLabel: "github-repository-publication.claim" },
  );
  const ownsExecution = () => {
    const current = readRepositoryGitHubPublication(row.request_id);
    return (
      current?.status === "publishing" &&
      current.gateway_instance_id === instanceId &&
      current.execution_id === executionId &&
      current.request_digest === row.request_digest
    );
  };
  const write = (values: Partial<RepositoryGitHubPublicationRow>, requireAction: boolean) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (requireAction) {
          assertCurrent();
        }
        const current = readRepositoryGitHubPublication(row.request_id);
        if (!current || current.request_digest !== row.request_digest) {
          throw new Error("GitHub publication receipt changed.");
        }
        const updated = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .updateTable(table)
            .set({ ...values, updated_at_ms: Date.now() })
            .where("request_id", "=", row.request_id)
            .where("request_digest", "=", row.request_digest)
            .where("status", "=", "publishing")
            .where("gateway_instance_id", "=", instanceId)
            .where("execution_id", "=", executionId)
            .returningAll(),
        );
        if (!updated) {
          throw new Error("GitHub publication execution is no longer current.");
        }
        return updated;
      },
      undefined,
      { operationLabel: "github-repository-publication.record" },
    );
  const effects = createGitHubPublicationExecutionEffects({
    write,
    interruptedStatus: row.owner_profile_id === null ? "requested" : "needs_confirmation",
  });
  return {
    row: claimed,
    ownsExecution,
    ...effects,
    recordEffect(...[effect, observed]: Parameters<typeof effects.recordEffect>): void {
      if (effect === "push" && observed?.headCommit) {
        write(
          {
            last_effect: "push",
            effect_state: "observed",
            head_commit: observed.headCommit,
            pushed_head_commit: observed.headCommit,
          },
          false,
        );
      } else {
        effects.recordEffect(effect, observed);
      }
    },
  };
}

export function markRepositoryGitHubPublicationReported(requestId: string): void {
  const database = openOpenClawStateDatabase().db;
  if (!tableExists(database, table)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(table)
          .set({ reported_at_ms: Date.now() })
          .where("request_id", "=", requestId)
          .where("status", "in", ["published", "failed"]),
      );
    },
    undefined,
    { operationLabel: "github-repository-publication.report" },
  );
}

export function failStaleRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  sessionIsCurrent: () => boolean,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readRepositoryGitHubPublication(row.request_id);
      if (
        !current ||
        terminalRepositoryGitHubPublication(current) ||
        current.request_digest !== row.request_digest ||
        sessionIsCurrent()
      ) {
        return;
      }
      // Retention preserves the original effects, not authority to publish after
      // archive/reset. Clearing the execution also fences awaited response writers.
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(table)
          .set({
            status: "failed",
            error_code: "session_changed",
            next_action:
              "Review any recorded GitHub effects, then request publication from a current session.",
            execution_id: null,
            gateway_instance_id: null,
            updated_at_ms: Date.now(),
          })
          .where("request_id", "=", row.request_id)
          .where("request_digest", "=", row.request_digest),
      );
    },
    undefined,
    { operationLabel: "github-repository-publication.retire" },
  );
}

export function deferRepositoryGitHubPublicationClaims(requestIds: readonly string[]): void {
  if (requestIds.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(table)
          .set({
            claim_id: null,
            run_id: null,
            environment_id: null,
            owner_epoch: null,
            placement_generation: null,
            updated_at_ms: Date.now(),
          })
          .where("request_id", "in", requestIds)
          .where("owner_profile_id", "is", null)
          .where("status", "in", ["requested", "publishing"]),
      );
    },
    undefined,
    { operationLabel: "github-repository-publication.defer" },
  );
}

export function terminalRepositoryGitHubPublication(row: RepositoryGitHubPublicationRow): boolean {
  return row.status === "published" || row.status === "failed";
}

export type RepositoryGitHubPublicationExecution = ReturnType<
  typeof claimRepositoryGitHubPublication
>;
