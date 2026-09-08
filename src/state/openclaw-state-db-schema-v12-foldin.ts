import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export const FOLDED_SINGLETON_STATE_TABLES_V12 = [
  "skill_curator_state",
  "update_check_state",
  "clawhub_promotions_feed_state",
  "model_catalog_remote",
  "voicewake_triggers",
  "voicewake_routing_routes",
  "voicewake_routing_config",
  "onboarding_recommendations",
  "cron_store_epochs",
  "tui_last_sessions",
  "sidebar_sections",
  "node_host_config",
  "web_push_vapid_keys",
] as const;

export function migrateSingletonStateFoldInV12(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 12) {
    return false;
  }
  // Older schemas can reach this migration before canonical schema creation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_machine_state (
      state_key TEXT NOT NULL PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const importState = db.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(state_key) DO NOTHING",
  );

  if (tableExists(db, "update_check_state")) {
    const row = db.prepare("SELECT * FROM update_check_state WHERE state_key = 'default'").get();
    if (row) {
      importState.run(
        "update.checkState",
        JSON.stringify({
          lastCheckedAt: row.last_checked_at ?? undefined,
          lastNotifiedVersion: row.last_notified_version ?? undefined,
          lastNotifiedTag: row.last_notified_tag ?? undefined,
          lastAvailableVersion: row.last_available_version ?? undefined,
          lastAvailableTag: row.last_available_tag ?? undefined,
          autoInstallId: row.auto_install_id ?? undefined,
          autoFirstSeenVersion: row.auto_first_seen_version ?? undefined,
          autoFirstSeenTag: row.auto_first_seen_tag ?? undefined,
          autoFirstSeenAt: row.auto_first_seen_at ?? undefined,
          autoLastAttemptVersion: row.auto_last_attempt_version ?? undefined,
          autoLastAttemptAt: row.auto_last_attempt_at ?? undefined,
          autoLastSuccessVersion: row.auto_last_success_version ?? undefined,
          autoLastSuccessAt: row.auto_last_success_at ?? undefined,
        }),
        Number(row.updated_at_ms),
      );
    }
  }

  if (tableExists(db, "voicewake_triggers")) {
    const rows = db
      .prepare(
        "SELECT trigger, updated_at_ms FROM voicewake_triggers WHERE config_key = 'default' ORDER BY position",
      )
      .all();
    if (rows.length > 0) {
      importState.run(
        "voicewake.triggers",
        JSON.stringify(rows.map((row) => row.trigger)),
        Math.max(...rows.map((row) => Number(row.updated_at_ms))),
      );
    }
  }

  if (tableExists(db, "voicewake_routing_config")) {
    const config = db
      .prepare("SELECT * FROM voicewake_routing_config WHERE config_key = 'default'")
      .get();
    if (config) {
      const routes = tableExists(db, "voicewake_routing_routes")
        ? db
            .prepare(
              "SELECT trigger, target_mode, target_agent_id, target_session_key FROM voicewake_routing_routes WHERE config_key = 'default' ORDER BY position",
            )
            .all()
        : [];
      const targetFromColumns = (mode: unknown, agentId: unknown, sessionKey: unknown) =>
        mode === "agent" && typeof agentId === "string" && agentId
          ? { agentId }
          : mode === "session" && typeof sessionKey === "string" && sessionKey
            ? { sessionKey }
            : { mode: "current" };
      importState.run(
        "voicewake.routing",
        JSON.stringify({
          version: 1,
          defaultTarget: targetFromColumns(
            config.default_target_mode,
            config.default_target_agent_id,
            config.default_target_session_key,
          ),
          routes: routes.map((route) => ({
            trigger: route.trigger,
            target: targetFromColumns(
              route.target_mode,
              route.target_agent_id,
              route.target_session_key,
            ),
          })),
          updatedAtMs: config.updated_at_ms,
        }),
        Number(config.updated_at_ms),
      );
    }
  }

  if (tableExists(db, "onboarding_recommendations")) {
    const rows = db.prepare("SELECT * FROM onboarding_recommendations").all();
    for (const row of rows) {
      importState.run(
        `onboarding.recommendations.${String(row.config_key)}`,
        JSON.stringify({
          inventoryHash: row.inventory_hash,
          matches: JSON.parse(String(row.matches_json)),
          offeredAt: row.offered_at_ms,
          acceptedAt: row.accepted_at_ms,
          updatedAt: row.updated_at_ms,
        }),
        Number(row.updated_at_ms),
      );
    }
  }

  if (tableExists(db, "sidebar_sections")) {
    const sections = db
      .prepare("SELECT section_id FROM sidebar_sections ORDER BY position, section_id")
      .all();
    if (sections.length > 0) {
      importState.run(
        "sidebar.sectionOrder",
        JSON.stringify(sections.map((section) => section.section_id)),
        Date.now(),
      );
    }
  }

  if (tableExists(db, "node_host_config")) {
    const nodeHost = db
      .prepare("SELECT * FROM node_host_config WHERE config_key = 'current'")
      .get();
    if (nodeHost) {
      const gateway = {
        ...(nodeHost.gateway_host == null ? {} : { host: nodeHost.gateway_host }),
        ...(nodeHost.gateway_port == null ? {} : { port: nodeHost.gateway_port }),
        ...(nodeHost.gateway_tls == null ? {} : { tls: nodeHost.gateway_tls === 1 }),
        ...(nodeHost.gateway_tls_fingerprint == null
          ? {}
          : { tlsFingerprint: nodeHost.gateway_tls_fingerprint }),
        ...(nodeHost.gateway_context_path == null
          ? {}
          : { contextPath: nodeHost.gateway_context_path }),
        ...(nodeHost.gateway_cloudflare_access_json == null
          ? {}
          : { cloudflareAccess: JSON.parse(String(nodeHost.gateway_cloudflare_access_json)) }),
      };
      importState.run(
        "nodeHost.config",
        JSON.stringify({
          version: nodeHost.version,
          nodeId: nodeHost.node_id,
          ...(nodeHost.display_name == null ? {} : { displayName: nodeHost.display_name }),
          ...(Object.keys(gateway).length === 0 ? {} : { gateway }),
          installedAppsSharing: nodeHost.installed_apps_sharing === 1,
        }),
        Number(nodeHost.updated_at_ms),
      );
    }
  }

  if (tableExists(db, "web_push_vapid_keys")) {
    const vapidKeys = db
      .prepare("SELECT * FROM web_push_vapid_keys WHERE key_id = 'default'")
      .get();
    if (vapidKeys) {
      importState.run(
        "webPush.vapidKeys",
        JSON.stringify({
          publicKey: vapidKeys.public_key,
          privateKey: vapidKeys.private_key,
          subject: vapidKeys.subject,
        }),
        Number(vapidKeys.updated_at_ms),
      );
    }
  }

  let dropped = false;
  for (const tableName of FOLDED_SINGLETON_STATE_TABLES_V12) {
    if (tableExists(db, tableName)) {
      db.exec(`DROP TABLE IF EXISTS ${tableName};`);
      dropped = true;
    }
  }
  return dropped;
}
