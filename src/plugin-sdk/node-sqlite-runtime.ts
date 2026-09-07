// Narrow node:sqlite database opener for performance-critical subprocesses
// (e.g. the memory-search-knn child) that must not pull in the full
// sqlite-runtime barrel's agent-database and maintenance exports. (#140681)
export { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
