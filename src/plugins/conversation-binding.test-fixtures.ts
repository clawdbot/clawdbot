import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

export function seedPluginConversationBindingApprovalForTest(params: {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt?: number;
}): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
    executeSqliteQuerySync(
      db,
      approvalsDb
        .insertInto("plugin_binding_approvals")
        .values({
          plugin_root: params.pluginRoot,
          channel: params.channel.trim().toLowerCase(),
          account_id: params.accountId.trim() || "default",
          plugin_id: params.pluginId,
          plugin_name: params.pluginName ?? null,
          approved_at: params.approvedAt ?? Date.now(),
        })
        .onConflict((conflict) =>
          conflict.columns(["plugin_root", "channel", "account_id"]).doUpdateSet({
            plugin_id: (eb) => eb.ref("excluded.plugin_id"),
            plugin_name: (eb) => eb.ref("excluded.plugin_name"),
            approved_at: (eb) => eb.ref("excluded.approved_at"),
          }),
        ),
    );
  });
  // Seeded rows must become visible even if another test loaded the process cache first.
  void drainGlobalSingletonLifecycleState();
}
