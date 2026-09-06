import { randomUUID, createHash } from "node:crypto";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensurePersonalGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolvePersonalGitHubOwner } from "../state/user-github-connections.js";
import { projectGitHubPublicationResult } from "./github-publication-store.js";

export type PersonalGitHubPublicationRow = DB["github_personal_publication_requests"];
const table = "github_personal_publication_requests";
const query = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<Pick<DB, typeof table>>(db);

export function personalGitHubRequestDigest(row: PersonalGitHubPublicationRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.request_id,
        row.owner_profile_id,
        row.session_id,
        row.session_key,
        row.agent_id,
        row.idempotency_key,
        row.connection_generation,
        row.identity_source,
        row.identity_profile_id,
        row.identity_account_id,
        row.identity_login,
        row.worktree_id,
        row.repository_fingerprint,
        row.push_repository,
        row.repository,
        row.branch,
        row.base_branch,
        row.source_head_commit,
        row.source_index_tree,
        row.workspace_tree,
        row.title,
        row.body,
        row.created_at_ms,
      ]),
    )
    .digest("hex");
}

function assertOwner(owner: string): void {
  if (resolvePersonalGitHubOwner(owner) !== owner) {
    throw new Error("My GitHub publication owner changed.");
  }
}

/** Ownership is checked before every lookup; request IDs and digests are never bearer authority. */
export function readPersonalGitHubPublication(
  owner: string,
  request:
    | { requestId: string }
    | { sessionId: string; idempotencyKey: string }
    | { sessionKey: string; agentId: string },
): PersonalGitHubPublicationRow | undefined {
  assertOwner(owner);
  const db = openOpenClawStateDatabase().db;
  if (!tableExists(db, table)) {
    return undefined;
  }
  let selection = query(db).selectFrom(table).selectAll().where("owner_profile_id", "=", owner);
  selection =
    "requestId" in request
      ? selection.where("request_id", "=", request.requestId)
      : "sessionId" in request
        ? selection
            .where("session_id", "=", request.sessionId)
            .where("idempotency_key", "=", request.idempotencyKey)
        : selection
            .where("session_key", "=", request.sessionKey)
            .where("agent_id", "=", request.agentId)
            .where("status", "in", ["requested", "publishing", "needs_confirmation"])
            .orderBy("created_at_ms", "desc")
            .orderBy("request_id", "desc")
            .limit(1);
  const row = executeSqliteQueryTakeFirstSync(db, selection);
  if (
    row &&
    (row.identity_source !== "personal" || row.request_digest !== personalGitHubRequestDigest(row))
  ) {
    throw new Error("My GitHub publication receipt is corrupt; create a new publication request.");
  }
  return row;
}

export function personalGitHubPublicationStatus(
  row: PersonalGitHubPublicationRow,
  executing: boolean,
): SessionGitHubStatusResult {
  const unfinished = row.status === "requested" || row.status === "publishing";
  const projected = unfinished && !executing ? { ...row, status: "needs_confirmation" } : row;
  return {
    result: projectGitHubPublicationResult(projected),
    confirmation:
      projected.status !== "needs_confirmation"
        ? null
        : {
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
          },
  };
}

export function insertPersonalGitHubPublication(
  row: PersonalGitHubPublicationRow,
  assertCurrent: () => void,
): PersonalGitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      assertOwner(row.owner_profile_id);
      ensurePersonalGitHubPublicationSchema(db);
      executeSqliteQuerySync(db, query(db).insertInto(table).values(row));
      return row;
    },
    undefined,
    { operationLabel: "github-personal-publication.request" },
  );
}

/** One execution closure owns writes; a later socket must explicitly confirm before claiming. */
export function claimPersonalGitHubPublication(
  row: PersonalGitHubPublicationRow,
  instanceId: string,
  assertCurrent: () => void,
) {
  const executionId = randomUUID();
  const claimed = runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      assertOwner(row.owner_profile_id);
      const update = executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(table)
          .set({
            status: "publishing",
            gateway_instance_id: instanceId,
            execution_id: executionId,
            updated_at_ms: Date.now(),
          })
          .where("owner_profile_id", "=", row.owner_profile_id)
          .where("request_id", "=", row.request_id)
          .where("request_digest", "=", row.request_digest)
          .where("status", "=", row.status)
          .where("execution_id", row.execution_id === null ? "is" : "=", row.execution_id),
      );
      if (update.numAffectedRows !== 1n) {
        throw new Error("My GitHub publication execution changed.");
      }
      return {
        ...row,
        status: "publishing",
        gateway_instance_id: instanceId,
        execution_id: executionId,
      };
    },
    undefined,
    { operationLabel: "github-personal-publication.claim" },
  );
  const ownsExecution = () => {
    const latest = readPersonalGitHubPublication(row.owner_profile_id, {
      requestId: row.request_id,
    });
    return (
      latest?.status === "publishing" &&
      latest.gateway_instance_id === instanceId &&
      latest.execution_id === executionId &&
      latest.request_digest === row.request_digest
    );
  };
  const write = (
    values: Partial<PersonalGitHubPublicationRow>,
    requireAction: boolean,
  ): PersonalGitHubPublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (requireAction) {
          assertCurrent();
        }
        const current = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .selectFrom(table)
            .selectAll()
            .where("owner_profile_id", "=", row.owner_profile_id)
            .where("request_id", "=", row.request_id),
        );
        if (
          !current ||
          current.request_digest !== row.request_digest ||
          personalGitHubRequestDigest(current) !== row.request_digest
        ) {
          throw new Error("My GitHub publication receipt changed during execution.");
        }
        const updated = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .updateTable(table)
            .set({ ...values, updated_at_ms: Date.now() })
            .where("owner_profile_id", "=", row.owner_profile_id)
            .where("request_id", "=", row.request_id)
            .where("status", "=", "publishing")
            .where("gateway_instance_id", "=", instanceId)
            .where("execution_id", "=", executionId)
            .returningAll(),
        );
        if (!updated) {
          throw new Error("My GitHub publication execution is no longer current.");
        }
        return updated;
      },
      undefined,
      { operationLabel: "github-personal-publication.record" },
    );
  return {
    row: claimed,
    ownsExecution,
    updateHead(headCommit: string): PersonalGitHubPublicationRow {
      return write({ head_commit: headCommit }, true);
    },
    complete(result: SessionGitHubPublicationResult): PersonalGitHubPublicationRow {
      if (result.status === "published") {
        return write(
          {
            status: "published",
            head_commit: result.headCommit,
            pull_request_url: result.url,
            error_code: null,
            next_action: null,
          },
          true,
        );
      }
      if (result.status !== "failed") {
        throw new Error("My GitHub publication result is not terminal.");
      }
      return write(
        { status: "failed", error_code: result.code, next_action: result.nextAction },
        true,
      );
    },
    recordEffect(
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ): void {
      // Observation preserves already-dispatched effects after revocation; it grants no further action.
      write(
        {
          last_effect: effect,
          effect_state: observed?.headCommit || observed?.url ? "observed" : "dispatched",
          ...(observed?.headCommit ? { head_commit: observed.headCommit } : {}),
          ...(observed?.url ? { pull_request_url: observed.url } : {}),
        },
        !observed,
      );
    },
    interrupt(): PersonalGitHubPublicationRow {
      // This is the execution owner's monotonic stop record, not a new authenticated action.
      return write({ status: "needs_confirmation", error_code: null, next_action: null }, false);
    },
  };
}

export function requirePersonalGitHubPublicationConfirmation(instanceId: string): void {
  const database = openOpenClawStateDatabase();
  if (!tableExists(database.db, table)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(table)
          .set({ status: "needs_confirmation", updated_at_ms: Date.now() })
          .where("status", "in", ["requested", "publishing"])
          .where((eb) =>
            eb.or([
              eb("gateway_instance_id", "is", null),
              eb("gateway_instance_id", "!=", instanceId),
            ]),
          ),
      );
    },
    undefined,
    { operationLabel: "github-personal-publication.restart" },
  );
}

export function listUnreportedPersonalGitHubPublications() {
  const db = openOpenClawStateDatabase().db;
  if (!tableExists(db, table)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("status", "in", ["published", "failed"])
      .where("reported_at_ms", "is", null)
      .orderBy("updated_at_ms"),
  ).rows.map((row) => {
    if (row.request_digest !== personalGitHubRequestDigest(row)) {
      throw new Error(
        "My GitHub publication receipt is corrupt; reconnect and create a new request.",
      );
    }
    return {
      sessionId: row.session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      result: projectGitHubPublicationResult(row),
    };
  });
}

export function markPersonalGitHubPublicationReported(requestId: string): void {
  const database = openOpenClawStateDatabase();
  if (!tableExists(database.db, table)) {
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
    { operationLabel: "github-personal-publication.report" },
  );
}
