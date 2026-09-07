import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "../plugins/installed-plugin-index-row.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

const rowSchema = z
  .object({
    state_key: z.string().refine((value): boolean => value === INSTALLED_PLUGIN_INDEX_STATE_KEY),
    value_json: z.string(),
    updated_at_ms: z.number().int().safe(),
  })
  .strict();
/** Raw committed facts from InstalledPluginIndexWriteReceipt.mutation; never authority. */
export const UpdateCheckpointPluginIndexMutationSchema = z
  .object({
    databasePath: z
      .string()
      .refine((value) => path.isAbsolute(value) && path.normalize(value) === value),
    before: rowSchema.nullable(),
    after: rowSchema.nullable(),
  })
  .strict();
export type UpdateCheckpointPluginIndexMutation = z.infer<
  typeof UpdateCheckpointPluginIndexMutationSchema
>;

function readCheckpointPluginIndexRow(db: DatabaseSync) {
  if (!tableExists(db, "config_machine_state")) {
    return null;
  }
  // Exact snapshot primitive: preserve raw bytes and the transaction timestamp,
  // never parse/reserialize the plugin index or open a runtime owner here.
  return rowSchema
    .nullable()
    .parse(
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<Pick<DB, "config_machine_state">>(db)
          .selectFrom("config_machine_state")
          .select(["state_key", "value_json", "updated_at_ms"])
          .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
      ) ?? null,
    );
}

/** Match a contiguous owner receipt chain to immutable snapshot endpoints. */
export function checkpointPluginIndexMutationsMatch(params: {
  mutations: readonly UpdateCheckpointPluginIndexMutation[];
  databasePath: string;
  checkpoint?: DatabaseSync;
  afterUpdate: DatabaseSync;
}): boolean {
  const mutations = params.mutations;
  const after = readCheckpointPluginIndexRow(params.afterUpdate);
  if (!mutations.length) {
    return (
      !params.checkpoint ||
      isDeepStrictEqual(readCheckpointPluginIndexRow(params.checkpoint), after)
    );
  }
  if (
    mutations.some(
      (mutation, index) =>
        mutation.databasePath !== params.databasePath ||
        (index > 0 && !isDeepStrictEqual(mutations[index - 1]!.after, mutation.before)),
    )
  ) {
    return false;
  }
  return (
    isDeepStrictEqual(mutations.at(-1)!.after, after) &&
    (!params.checkpoint ||
      isDeepStrictEqual(mutations[0]!.before, readCheckpointPluginIndexRow(params.checkpoint)))
  );
}
