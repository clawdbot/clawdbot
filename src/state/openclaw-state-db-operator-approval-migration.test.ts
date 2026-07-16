// Operator-approval kind migration: exact-legacy fail-closed repair.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalOperatorApprovalKinds,
  repairOperatorApprovalSchema,
} from "./openclaw-state-db-operator-approval-migration.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

function canonicalOperatorApprovalCreateSql(): string {
  const marker = "CREATE TABLE IF NOT EXISTS operator_approvals (";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "\n);\n\nCREATE INDEX IF NOT EXISTS idx_operator_approvals_status_expiry",
    start,
  );
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 3);
}

function legacyTwoKindCreateSql(): string {
  return canonicalOperatorApprovalCreateSql().replace(
    /'exec',\s*'plugin',\s*'system-agent'/,
    "'exec', 'plugin'",
  );
}

function seedRow(db: DatabaseSync, kind: string): void {
  db.exec(`
    INSERT INTO operator_approvals (
      approval_id, resolution_ref, kind, status, presentation_json,
      reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
      created_at_ms, expires_at_ms, updated_at_ms
    ) VALUES (
      'a1', 'ref0000000000000000000000000000000000000000', '${kind}',
      'pending', '{}', '[]', '[]', 1, 1, 1, 1
    );
  `);
}

describe("repairOperatorApprovalKinds", () => {
  it("migrates the exact legacy two-kind schema and preserves rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(legacyTwoKindCreateSql());
    seedRow(db, "exec");
    expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).toThrow(
      "legacy operator approval schema",
    );

    expect(repairOperatorApprovalSchema(db)).toEqual([
      "Migrated shared state operator approvals → OpenClaw system changes",
    ]);

    expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
    const rows = db.prepare("SELECT approval_id, kind FROM operator_approvals").all();
    expect(rows).toEqual([{ approval_id: "a1", kind: "exec" }]);
    db.close();
  });

  it("is a no-op when the schema is already canonical", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(canonicalOperatorApprovalCreateSql());
    expect(repairOperatorApprovalSchema(db)).toEqual([]);
    db.close();
  });

  it("refuses to replace a look-alike table with the same columns but different constraints", () => {
    const db = new DatabaseSync(":memory:");
    // Same column names, but a different (non-canonical) kind constraint — the
    // fail-closed guard must not copy its rows under today's schema.
    db.exec(
      legacyTwoKindCreateSql().replace(/'exec',\s*'plugin'/, "'exec', 'plugin', 'custom-thing'"),
    );
    seedRow(db, "custom-thing");

    expect(repairOperatorApprovalSchema(db)).toEqual([]);

    // The unrecognized table is left untouched.
    const rows = db.prepare("SELECT approval_id, kind FROM operator_approvals").all();
    expect(rows).toEqual([{ approval_id: "a1", kind: "custom-thing" }]);
    db.close();
  });
});
