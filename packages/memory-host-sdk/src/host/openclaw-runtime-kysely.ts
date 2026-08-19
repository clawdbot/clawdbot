// Narrow core bridge for Kysely-backed sync query helpers. Split from
// openclaw-runtime-sqlite so schema/transaction consumers stay off the kysely
// value graph, which doctor/setup control-plane paths must not cold-load.
export { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../../src/infra/kysely-sync.js";
