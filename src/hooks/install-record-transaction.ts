import type { PackageDirInstallTransaction } from "../infra/install-package-dir.js";
import type { PluginInstallTransaction } from "../plugins/install-transaction.js";
import type { PluginLifecycleLeaseContext } from "../plugins/plugin-lifecycle-lease.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  recordHookInstall,
  restoreHookInstallIfCurrent,
  type HookInstallUpdate,
  type HookInstallWriteReceipt,
} from "./installs.js";

/** Retain hook record and payload compensation until their config owner commits. */
export async function stageHookInstall(params: {
  update: HookInstallUpdate;
  payloadTransaction?: PackageDirInstallTransaction;
  lease: PluginLifecycleLeaseContext;
  beforePersistentApply?: () => void;
}): Promise<PluginInstallTransaction> {
  const { lease, payloadTransaction } = params;
  const storeOptions = { path: lease.databasePath };
  let receipt: HookInstallWriteReceipt;
  try {
    receipt = runOpenClawStateWriteTransaction((database) => {
      lease.assertOwnedInTransaction(database.db);
      params.beforePersistentApply?.();
      return recordHookInstall(params.update, { database });
    }, storeOptions);
  } catch (error) {
    if (payloadTransaction) {
      try {
        lease.assertOwned();
        await payloadTransaction.rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Hook install payload rollback failed", {
          cause: rollbackError,
        });
      }
    }
    throw error;
  }

  let settled = false;
  return {
    async commit() {
      if (settled) {
        return;
      }
      // Config is durable. Cleanup or output failures must never undo the committed install.
      settled = true;
      try {
        lease.assertOwned();
        await payloadTransaction?.commit();
      } catch (error) {
        throw new Error("Hook install committed, but payload backup cleanup failed", {
          cause: error,
        });
      }
    },
    async rollback() {
      if (settled) {
        return;
      }
      settled = true;
      const restored = runOpenClawStateWriteTransaction((database) => {
        // Compensation uses retained lifecycle ownership, not the now-revoked install authority.
        lease.assertOwnedInTransaction(database.db);
        return restoreHookInstallIfCurrent(receipt, { database });
      }, storeOptions);
      if (!restored) {
        throw new Error("Hook install changed before rollback; newer record and payload retained");
      }
      lease.assertOwned();
      await payloadTransaction?.rollback();
    },
  };
}
