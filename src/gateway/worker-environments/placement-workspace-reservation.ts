import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import { find } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";

const SCOPE = "session-workspace-action";
const PERSONAL_SCOPE = "session-workspace-personal-publication";
export class SessionWorkspaceReservationBusyError extends Error {}
const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<
    Pick<
      DB,
      "state_leases" | "worker_workspace_pending_results" | "worker_workspace_reconciliations"
    >
  >(db);

/** Run admission and placement movement consult the same SQLite exclusion as publishers. */
export function assertSessionWorkspaceUnreserved(db: DatabaseSync, sessionId: string): void {
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("state_leases")
        .select("owner")
        .where("scope", "=", PERSONAL_SCOPE)
        .where("lease_key", "=", sessionId)
        .where("expires_at", ">", Date.now()),
    )
  ) {
    throw new SessionWorkspaceReservationBusyError(
      "The session workspace is being published; wait for publication to finish and retry.",
    );
  }
}

function assertReconciled(
  db: DatabaseSync,
  identity: WorkerSessionPlacementIdentity,
  workspace: "local" | "repository",
): void {
  const placement = find(db, identity.sessionId);
  if (
    placement &&
    (placement.agentId !== identity.agentId || placement.sessionKey !== identity.sessionKey)
  ) {
    throw new Error("The session workspace placement identity changed.");
  }
  if (
    placement &&
    ((placement.state !== "local" &&
      placement.state !== "reclaimed" &&
      !(
        workspace === "repository" &&
        (placement.state === "active" || placement.state === "failed")
      )) ||
      placement.turnClaim)
  ) {
    throw new SessionWorkspaceReservationBusyError(
      workspace === "repository"
        ? "The repository checkpoint is busy; finish the current turn or worker operation before publishing."
        : "My GitHub publication requires an idle local workspace; finish the turn and reclaim remote work first.",
    );
  }
  const pending = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .select("session_id")
      .where("session_id", "=", identity.sessionId),
  );
  const reconciliation = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_workspace_reconciliations")
      .select("session_id")
      .where("session_id", "=", identity.sessionId),
  );
  if (pending || reconciliation) {
    throw new SessionWorkspaceReservationBusyError(
      "The session workspace is still reconciling; wait for reclaim to finish before publishing with My GitHub.",
    );
  }
}

export function createPlacementWorkspaceReservationOps(runtime: PlacementStoreRuntime) {
  const withReservation = async <T>(
    scope: string,
    sessionId: string,
    run: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> =>
    await withOpenClawStateLease(
      {
        scope,
        key: sessionId,
        database: { scope: "shared", options: { path: runtime.path } },
        leaseMs: 60000,
        waitMs: 0,
        leaseLabel: "session publication exclusion",
      },
      async (lease) => await run(() => lease.assertOwned()),
    );
  const withWorkspaceExclusion = <T>(
    sessionId: string,
    run: (assertOwned: () => void) => Promise<T>,
  ) => withReservation(SCOPE, sessionId, run);
  const withWorkspaceReservation = async <T>(
    identity: WorkerSessionPlacementIdentity,
    workspace: "local" | "repository",
    run: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> => {
    return await withWorkspaceExclusion(
      identity.sessionId,
      async (assertPublisherExclusion) =>
        await withReservation(PERSONAL_SCOPE, identity.sessionId, async (assertOwned) => {
          assertReconciled(runtime.read(), identity, workspace);
          const initial = find(runtime.read(), identity.sessionId);
          const assertCurrent = () => {
            assertPublisherExclusion();
            assertOwned();
            assertReconciled(runtime.read(), identity, workspace);
            const current = find(runtime.read(), identity.sessionId);
            if (
              current?.generation !== initial?.generation ||
              current?.state !== initial?.state ||
              current?.environmentId !== initial?.environmentId ||
              current?.activeOwnerEpoch !== initial?.activeOwnerEpoch
            ) {
              throw new Error("The session workspace placement changed during publication.");
            }
          };
          // This lease is exclusion only: it never creates a model run, turn claim, or identity.
          return await run(assertCurrent);
        }),
    );
  };
  return {
    withWorkspaceExclusion,
    withLocalWorkspaceReservation: <T>(
      identity: WorkerSessionPlacementIdentity,
      run: (assertCurrent: () => void) => Promise<T>,
    ) => withWorkspaceReservation(identity, "local", run),
    withRepositoryWorkspaceReservation: <T>(
      identity: WorkerSessionPlacementIdentity,
      run: (assertCurrent: () => void) => Promise<T>,
    ) => withWorkspaceReservation(identity, "repository", run),
  };
}
