import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

function tableCount(
  database: DatabaseSync,
  tableName: "execution_identity_contexts" | "execution_decision_facts",
): number {
  const table = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!table) {
    return 0;
  }
  const countSql =
    tableName === "execution_identity_contexts"
      ? "SELECT COUNT(*) AS count FROM execution_identity_contexts"
      : "SELECT COUNT(*) AS count FROM execution_decision_facts";
  const row = database.prepare(countSql).get() as {
    count: number;
  };
  return row.count;
}

/** Return only bounded row counts for deterministic no-synthetic-run proof. */
export function inspectQaExecutionIdentityStorage(env: Pick<QaSuiteRuntimeEnv, "gateway">): {
  contextCount: number;
  decisionCount: number;
} {
  const stateDir = env.gateway.runtimeEnv.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      contextCount: tableCount(database, "execution_identity_contexts"),
      decisionCount: tableCount(database, "execution_decision_facts"),
    };
  } finally {
    database.close();
  }
}
