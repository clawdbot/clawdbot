import type { DatabaseSync } from "node:sqlite";
import { saveCronJobsStore } from "../store.js";
import type { CronStoreFile } from "../types.js";

export type CronStoreTransactionHooks = {
  beforeWrite?: (db: DatabaseSync) => void;
  afterWrite?: (db: DatabaseSync) => void;
};

type SaveCronJobsStoreOptions = NonNullable<Parameters<typeof saveCronJobsStore>[2]>;
type InternalSaveCronJobsStore = (
  storePath: string,
  store: CronStoreFile,
  opts: SaveCronJobsStoreOptions & { transactionHooks: CronStoreTransactionHooks },
) => Promise<void>;

export async function saveCronJobsStoreWithTransactionHooks(
  storePath: string,
  store: CronStoreFile,
  opts: SaveCronJobsStoreOptions | undefined,
  transactionHooks: CronStoreTransactionHooks,
): Promise<void> {
  await (saveCronJobsStore as InternalSaveCronJobsStore)(storePath, store, {
    ...opts,
    transactionHooks,
  });
}
