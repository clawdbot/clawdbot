import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

/** Read-only admission: a missing canonical DB is not proof of a fresh install. */
export async function assertUpdateRecoveryAdmission(
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  try {
    await fs.lstat(databasePath);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    // An entirely absent state directory is a normal first invocation. Do not
    // swallow ENOENT from discovery itself: a changing family is not admission.
    try {
      await fs.lstat(path.dirname(databasePath));
    } catch (parentError) {
      if (!hasNodeErrorCode(parentError, "ENOENT")) {
        throw parentError;
      }
      return;
    }
    const { discoverUpdateCheckpointRestoreFamilies } =
      await import("./update-checkpoint-restore.js");
    const families = await discoverUpdateCheckpointRestoreFamilies(databasePath);
    if (families.length > 0) {
      // Locators are not authority. In particular, never create a new DB when a
      // staged/displaced record cannot be read. Checkpoint must reconcile the
      // exact bound plan and DB family before any claim or history writes.
      throw new Error(
        "Interrupted shared-database publication requires reconciliation before updating",
        { cause: error },
      );
    }
  }
  assertNoPendingUpdateRecovery(options);
}
