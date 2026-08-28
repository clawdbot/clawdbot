import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  createSessionRecipientAuthorityEpoch,
  readSessionRecipientAuthorityEpoch,
  sessionRecipientAuthorityMatches,
  type SessionRecipientAuthority,
} from "./session-recipient-authority-types.js";

type SessionRecipientAuthorityDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_recipient_authority"
>;

function getSessionRecipientAuthorityKysely(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<SessionRecipientAuthorityDatabase>(database.db);
}

export function advanceSessionRecipientAuthorityInTransaction(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  const now = Date.now();
  executeSqliteQuerySync(
    database.db,
    getSessionRecipientAuthorityKysely(database)
      .insertInto("session_recipient_authority")
      .values({
        session_key: sessionKey,
        epoch: createSessionRecipientAuthorityEpoch(),
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          epoch: createSessionRecipientAuthorityEpoch(),
          updated_at: now,
        }),
      ),
  );
}

export function captureSessionRecipientAuthority(
  scope: SessionAccessScope,
): SessionRecipientAuthority {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getSessionRecipientAuthorityKysely(database);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_recipient_authority")
        .select("epoch")
        .where("session_key", "=", resolved.sessionKey),
    );
    const current = readSessionRecipientAuthorityEpoch(row?.epoch);
    if (current.state === "malformed") {
      throw new Error(`Invalid recipient authority epoch for session ${resolved.sessionKey}`);
    }
    if (current.state === "present") {
      return { state: "bound", epoch: current.epoch };
    }
    const epoch = createSessionRecipientAuthorityEpoch();
    const now = Date.now();
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_recipient_authority").values({
        session_key: resolved.sessionKey,
        epoch,
        created_at: now,
        updated_at: now,
      }),
    );
    return { state: "bound", epoch };
  }, toDatabaseOptions(resolved));
}

export function isSessionRecipientAuthorityCurrent(
  scope: SessionAccessScope,
  authority: SessionRecipientAuthority,
): boolean {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getSessionRecipientAuthorityKysely(database)
          .selectFrom("session_recipient_authority")
          .select("epoch")
          .where("session_key", "=", resolved.sessionKey),
      );
      return sessionRecipientAuthorityMatches(
        authority,
        readSessionRecipientAuthorityEpoch(row?.epoch),
      );
    },
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  return result.found && result.value;
}
