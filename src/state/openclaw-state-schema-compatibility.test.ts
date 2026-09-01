import { describe, expect, it } from "vitest";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";

describe("OpenClaw state runtime schema projection", () => {
  it("lets a previous reader accept a database carrying the lazy attempts trigger", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { assertSqliteSchemaContains } = await import("../infra/sqlite-schema-contract.js");
    const { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } =
      await import("./openclaw-state-schema-compatibility.js");
    const db = new DatabaseSync(":memory:");
    // A current database that has installed the external-verification feature:
    // the attempts table plus the close trigger on the core approvals table.
    db.exec(getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: true }));
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_operator_approval_closes_external_verification'",
        )
        .get(),
    ).toEqual({ name: "trg_operator_approval_closes_external_verification" });
    // A previous reader (predating the feature: attempts table projected out)
    // must accept the trigger's presence rather than reject it as noncanonical.
    expect(() =>
      assertSqliteSchemaContains(
        db,
        "previous reader",
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
        OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
      ),
    ).not.toThrow();
    db.close();
  });

  it("omits lazy additive tables and their unique indexes before first use", () => {
    const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false });

    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cron_run_receipts");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS worker_session_placement_moves");
    expect(schema).not.toContain("idx_cron_run_receipts_active_job");
    expect(schema).not.toContain("idx_cron_run_receipts_job_history");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_progress");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings");
    expect(schema).not.toContain("outbound_message_execution_bindings_execution_event_idx");
    expect(schema).not.toContain("outbound_message_progress_occurred_idx");
    expect(schema).not.toContain("outbound_message_progress_run_occurred_idx");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS github_publication_requests");
    expect(schema).not.toContain("idx_github_publication_requests_pending");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS config_revision_keys");
    // The trigger references the lazy attempts table in its body; SQLite only
    // validates that at fire time, so a projected schema keeping the trigger
    // would break the first ordinary approval resolution on an upgraded
    // database that has never used external verification.
    expect(schema).not.toContain("plugin_external_verification_attempts");
    expect(schema).not.toContain("trg_operator_approval_closes_external_verification");
  });

  it("keeps the attempts ledger trigger with its table when lazy tables are included", () => {
    const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: true });
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS plugin_external_verification_attempts");
    expect(schema).toContain(
      "CREATE TRIGGER IF NOT EXISTS trg_operator_approval_closes_external_verification",
    );
  });

  it("resolves an ordinary approval on a database opened without the lazy ledger", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }));
    db.exec(`
      INSERT INTO operator_approvals (
        approval_id, resolution_ref, kind, status, presentation_json,
        reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
        created_at_ms, expires_at_ms, updated_at_ms
      ) VALUES (
        'plugin:upgrade-probe', '${"A".repeat(43)}', 'plugin', 'pending', '{}',
        '[]', '[]', 'epoch-1',
        1, 10000, 1
      );
    `);
    // Fires any terminal-transition trigger left in the projected schema.
    db.exec(
      "UPDATE operator_approvals SET status = 'denied', decision = 'deny', terminal_reason = 'user', resolver_kind = 'runtime', resolved_at_ms = 2, updated_at_ms = 2 WHERE approval_id = 'plugin:upgrade-probe';",
    );
    const row = db
      .prepare("SELECT status FROM operator_approvals WHERE approval_id = 'plugin:upgrade-probe'")
      .get() as { status: string };
    expect(row.status).toBe("denied");
    db.close();
  });
});
