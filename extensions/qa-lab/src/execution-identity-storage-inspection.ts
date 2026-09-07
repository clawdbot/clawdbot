import path from "node:path";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

function tableCount(
  database: ReturnType<typeof openNodeSqliteDatabase>,
  tableName: "execution_identity_contexts" | "execution_decision_facts",
  decisionFilter?: { actionFamily: string; reasonCode: string; runId: string },
): number {
  const table = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!table) {
    return 0;
  }
  const row =
    tableName === "execution_identity_contexts"
      ? database.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get()
      : decisionFilter
        ? database
            .prepare(
              `SELECT COUNT(*) AS count FROM execution_decision_facts
               WHERE run_id = ? AND action_family = ? AND reason_code = ?`,
            )
            .get(decisionFilter.runId, decisionFilter.actionFamily, decisionFilter.reasonCode)
        : database.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts").get();
  return (
    row as {
      count: number;
    }
  ).count;
}

/** Return only bounded row counts for deterministic no-synthetic-run proof. */
export function inspectQaExecutionIdentityStorage(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  decisionFilter?: { actionFamily: string; reasonCode: string; runId: string },
): {
  contextCount: number;
  decisionCount: number;
} {
  const stateDir = env.gateway.runtimeEnv.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = openNodeSqliteDatabase(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      contextCount: tableCount(database, "execution_identity_contexts"),
      decisionCount: tableCount(database, "execution_decision_facts", decisionFilter),
    };
  } finally {
    database.close();
  }
}
