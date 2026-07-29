import fs from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { withOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

/** Reads proven session-scoped sandbox ownership without creating a state database. */
export function readRegisteredSandboxSessionKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!fs.existsSync(resolveOpenClawStateSqlitePath(env))) {
    return [];
  }

  return withOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      if (!tableExists(db, "sandbox_registry_entries")) {
        return [];
      }

      const stateDb =
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "sandbox_registry_entries">>(db);
      const rows = executeSqliteQuerySync(
        db,
        stateDb
          .selectFrom("sandbox_registry_entries")
          .select("session_key")
          .where("registry_kind", "=", "container")
          .orderBy("container_name", "asc"),
      ).rows;

      // Scope changes leave agent/shared rows behind. Their keys are not raw
      // session identities and must never authorize destructive Doctor repair.
      return [
        ...new Set(
          rows.flatMap(({ session_key: scopeKey }) => {
            const sessionKey = scopeKey?.trim();
            return sessionKey && (sessionKey === "global" || parseAgentSessionKey(sessionKey))
              ? [sessionKey]
              : [];
          }),
        ),
      ];
    },
    { env },
  );
}
