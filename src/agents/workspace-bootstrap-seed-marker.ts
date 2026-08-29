// The seed marker and the BOOTSTRAP.md it describes are one fact. An attempt that rolls back the
// file it seeded must drop the marker with it, or the next seed reads "already seeded, file gone"
// as consumed and silently writes nothing.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";

type WorkspaceSetupStateDatabase = Pick<OpenClawStateKyselyDatabase, "workspace_setup_state">;

export function clearWorkspaceBootstrapSeedMarker(
  workspaceDir: string,
  nowMs = Date.now(),
  options: OpenClawStateDatabaseOptions = {},
): void {
  const identity = resolveWorkspaceStateIdentity(workspaceDir);
  runOpenClawStateWriteTransaction((database) => {
    const kysely = getNodeSqliteKysely<WorkspaceSetupStateDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      kysely
        .updateTable("workspace_setup_state")
        .set({ bootstrap_seeded_at: null, updated_at: nowMs })
        .where("workspace_key", "=", identity.workspaceKey),
    );
  }, options);
}
