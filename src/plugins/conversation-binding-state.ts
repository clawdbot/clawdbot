import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDedupeCache, type DedupeCache } from "../infra/dedupe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { normalizeChannel } from "./conversation-binding-session-key.js";

const log = createSubsystemLogger("plugins/binding");

export type PluginBindingApprovalEntry = {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
};

type PluginBindingApprovalsState = { approvals: PluginBindingApprovalEntry[] };
type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

type PluginBindingGlobalState = {
  fallbackNoticeBindingIds: DedupeCache;
  approvalsCache: PluginBindingApprovalsState | null;
};

const pluginBindingGlobalStateKey = Symbol.for("openclaw.plugins.binding.global-state");
export const pluginBindingGlobalState = resolveGlobalSingleton<PluginBindingGlobalState>(
  pluginBindingGlobalStateKey,
  () => ({
    // Retain recent outage notices without keeping every historical binding forever.
    fallbackNoticeBindingIds: createDedupeCache({ ttlMs: 0, maxSize: 4_096 }),
    approvalsCache: null,
  }),
  (state) => {
    state.fallbackNoticeBindingIds.clear();
    state.approvalsCache = null;
  },
);

function buildApprovalScopeKey(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [
    params.pluginRoot,
    normalizeChannel(params.channel),
    params.accountId.trim() || "default",
  ].join("::");
}

function loadApprovalsFromDatabase(): PluginBindingApprovalsState {
  try {
    const database = openOpenClawStateDatabase();
    const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      approvalsDb
        .selectFrom("plugin_binding_approvals")
        .select(["plugin_root", "plugin_id", "plugin_name", "channel", "account_id", "approved_at"])
        .orderBy("plugin_root", "asc")
        .orderBy("channel", "asc")
        .orderBy("account_id", "asc"),
    ).rows;
    return {
      approvals: rows.map((row) => ({
        pluginRoot: row.plugin_root,
        pluginId: row.plugin_id,
        pluginName: row.plugin_name ?? undefined,
        channel: normalizeChannel(row.channel),
        accountId: normalizeOptionalString(row.account_id) ?? "default",
        approvedAt: row.approved_at,
      })),
    };
  } catch (error) {
    log.warn(`plugin binding approvals load failed: ${String(error)}`);
    return { approvals: [] };
  }
}

function persistApprovalEntry(entry: PluginBindingApprovalEntry): void {
  const row = {
    plugin_root: entry.pluginRoot,
    channel: normalizeChannel(entry.channel),
    account_id: entry.accountId.trim() || "default",
    plugin_id: entry.pluginId,
    plugin_name: entry.pluginName ?? null,
    approved_at: entry.approvedAt,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
    executeSqliteQuerySync(
      db,
      approvalsDb
        .insertInto("plugin_binding_approvals")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["plugin_root", "channel", "account_id"]).doUpdateSet({
            plugin_id: (eb) => eb.ref("excluded.plugin_id"),
            plugin_name: (eb) => eb.ref("excluded.plugin_name"),
            approved_at: (eb) => eb.ref("excluded.approved_at"),
          }),
        ),
    );
  });
}

function getApprovals(): PluginBindingApprovalsState {
  return (pluginBindingGlobalState.approvalsCache ??= loadApprovalsFromDatabase());
}

export function hasPersistentApproval(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): boolean {
  const key = buildApprovalScopeKey(params);
  return getApprovals().approvals.some((entry) => buildApprovalScopeKey(entry) === key);
}

export function addPersistentApproval(entry: PluginBindingApprovalEntry): void {
  // Persist before publishing the grant: a failed SQLite write must not leave the
  // cache auto-approving later binds with permission that never reached disk.
  persistApprovalEntry(entry);
  const key = buildApprovalScopeKey(entry);
  const approvals = getApprovals().approvals.filter(
    (existing) => buildApprovalScopeKey(existing) !== key,
  );
  approvals.push(entry);
  pluginBindingGlobalState.approvalsCache = { approvals };
}
