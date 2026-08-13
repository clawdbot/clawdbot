import type { DatabaseSync } from "node:sqlite";

export type CronStoreTransactionHooks = {
  beforeWrite?: (db: DatabaseSync) => void;
  afterWrite?: (db: DatabaseSync) => void;
};
