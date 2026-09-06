import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";

/** A serving process cannot attest drainage while another receipt owner remains active. */
export function hasActiveCronRunReceiptsForAgent(agentId: string): boolean {
  const { db } = openOpenClawStateDatabase();
  if (!tableExists(db, "cron_run_receipts")) {
    return false;
  }
  const owners = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "cron_run_receipts">>(db)
      .selectFrom("cron_run_receipts")
      .select(["owner_pid", "owner_start_time"])
      .distinct()
      .where("status", "=", "running")
      .where("agent_id", "=", agentId),
  ).rows;
  return owners.some((owner) => {
    if (isPidDefinitelyDead(owner.owner_pid)) {
      return false;
    }
    const startedAt = getFileLockProcessStartTime(owner.owner_pid);
    // Unlike scheduling recovery, cleanup cannot use age to dismiss an unverifiable owner.
    return (
      owner.owner_start_time === null || startedAt === null || owner.owner_start_time === startedAt
    );
  });
}
