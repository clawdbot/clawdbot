import type { DatabaseSync } from "node:sqlite";

export type CronStoreTransactionHooks = {
  // void accepts Promise-returning functions; every hook must finish before its caller proceeds.
  beforeWrite?: (db: DatabaseSync) => undefined;
  afterWrite?: (db: DatabaseSync) => undefined;
  afterCommit?: () => undefined;
};
