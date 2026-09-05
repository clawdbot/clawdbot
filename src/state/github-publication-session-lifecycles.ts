import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureGitHubPublicationSessionLifecycleSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const table = "github_publication_session_lifecycles";
type PublicationIdentity = { publicationKind: "shared" | "personal"; requestId: string };
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

/** The receipt and its captured generation commit together; replay never rebinds it. */
export function insertGitHubPublicationSessionLifecycle(
  db: DatabaseSync,
  input: PublicationIdentity & { lifecycleRevision: string | null },
): void {
  ensureGitHubPublicationSessionLifecycleSchema(db);
  executeSqliteQuerySync(
    db,
    query(db).insertInto(table).values({
      publication_kind: input.publicationKind,
      request_id: input.requestId,
      lifecycle_revision: input.lifecycleRevision,
    }),
  );
}

/** A missing binding is unproven; a retained NULL records an originally absent revision. */
export function readGitHubPublicationSessionLifecycle(input: PublicationIdentity) {
  const db = openOpenClawStateDatabase().db;
  return tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom(table)
          .select("lifecycle_revision")
          .where("publication_kind", "=", input.publicationKind)
          .where("request_id", "=", input.requestId),
      )
    : undefined;
}
