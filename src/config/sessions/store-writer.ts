// Session store writes are serialized per store path to avoid lost updates.
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

type RunExclusiveSessionStoreWriteOptions = {
  reentrant?: boolean;
};

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: RunExclusiveSessionStoreWriteOptions = {},
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath,
    label: "runExclusiveSessionStoreWrite",
    fn,
    reentrant: opts.reentrant,
  });
}
