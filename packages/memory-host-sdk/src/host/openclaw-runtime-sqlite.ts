// Narrow core bridge for shared SQLite schema migration primitives.

export { migrateSqliteSchemaToStrict } from "../../../../src/infra/sqlite-strict.js";
export { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
export { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../../src/infra/kysely-sync.js";
