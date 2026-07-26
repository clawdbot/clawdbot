/** Test-only reset for process-global plugin conversation binding state. */
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

type PluginBindingGlobalState = {
  fallbackNoticeBindingIds: Set<string>;
  approvalsCache: unknown;
  approvalsLoaded: boolean;
  approvalsSaveChain: Promise<void>;
};

export function resetPluginConversationBindingStateForTest(): void {
  resolveGlobalMap(Symbol.for("openclaw.pluginBindingPendingRequests")).clear();
  const state = resolveGlobalSingleton<PluginBindingGlobalState>(
    Symbol.for("openclaw.plugins.binding.global-state"),
    () => ({
      fallbackNoticeBindingIds: new Set(),
      approvalsCache: null,
      approvalsLoaded: false,
      approvalsSaveChain: Promise.resolve(),
    }),
  );
  state.approvalsCache = null;
  state.approvalsLoaded = false;
  state.approvalsSaveChain = Promise.resolve();
  state.fallbackNoticeBindingIds.clear();
}

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
  resetPluginConversationBindingStateForTest();
}
