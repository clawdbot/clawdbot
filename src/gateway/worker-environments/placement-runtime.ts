import type { DatabaseSync } from "node:sqlite";

/** Shared database runtime for the placement-store operation modules. */
export type PlacementStoreRuntime = {
  path: string;
  instanceId: string;
  now: () => number;
  read: () => DatabaseSync;
  write: <T>(operation: (db: DatabaseSync) => T) => T;
};
