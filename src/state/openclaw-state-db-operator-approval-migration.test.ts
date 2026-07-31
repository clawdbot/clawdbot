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
  const tableTerminator = "\n) STRICT;";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    `${tableTerminator}\n\nCREATE INDEX IF NOT EXISTS idx_operator_approvals_status_expiry`,
    start,
  );
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + tableTerminator.length);
}

function legacyTwoKindCreateSql(): string {
  return canonicalOperatorApprovalCreateSql()
    .replace(/\) STRICT;$/u, ");")
    .replace(/'exec',\s*'plugin',\s*'system-agent'/, "'exec', 'plugin'");
}

function withoutResolutionRefColumn(sql: string): string {
  const resolutionRefStart = sql.indexOf("\n  resolution_ref ");
  const followingColumnStart = sql.indexOf("\n  kind ", resolutionRefStart);
  if (resolutionRefStart < 0 || followingColumnStart < 0) {
    throw new Error("resolution_ref column not found");
  }
  return sql.slice(0, resolutionRefStart) + sql.slice(followingColumnStart);
}

function createAlterAppendedLegacyTable(db: DatabaseSync, strict: boolean): void {
  const createSql = withoutResolutionRefColumn(
    strict ? legacyTwoKindCreateSql().replace(/\);$/u, ") STRICT;") : legacyTwoKindCreateSql(),
  );
  db.exec(createSql);
  db.exec("ALTER TABLE operator_approvals ADD COLUMN resolution_ref TEXT;");
}

const RESOLUTION_REF = "ref0000000000000000000000000000000000000000";

function seedRow(
  db: DatabaseSync,
  kind: string,
  resolutionRef: string | null = RESOLUTION_REF,
  approvalId = "a1",
): void {
  db.prepare(`
    INSERT INTO operator_approvals (
      approval_id, resolution_ref, kind, status, presentation_json,
      reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
      created_at_ms, expires_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, 'pending', '{}', '[]', '[]', 1, 1, 1, 1
    );
  `).run(approvalId, resolutionRef, kind);
}

function expectAlterAppendedLegacyRepair(strict: boolean): void {
  const db = new DatabaseSync(":memory:");
  createAlterAppendedLegacyTable(db, strict);
  seedRow(db, "exec");

  expect(repairOperatorApprovalSchema(db)).toEqual([
    "Migrated shared state operator approvals → OpenClaw system changes",
  ]);

  expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
  expect(
    db.prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals").all(),
  ).toEqual([{ approval_id: "a1", kind: "exec", resolution_ref: RESOLUTION_REF }]);
  expect(
    db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'operator_approvals'").get(),
  ).toEqual({ strict: 1 });
  db.close();
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
    const rows = db
      .prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals")
      .all();
    expect(rows).toEqual([{ approval_id: "a1", kind: "exec", resolution_ref: RESOLUTION_REF }]);
    expect(
      db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'operator_approvals'").get(),
    ).toEqual({ strict: 1 });
    db.close();
  });

  it("migrates the ALTER-appended non-STRICT legacy shape", () => {
    expectAlterAppendedLegacyRepair(false);
  });

  it("migrates the ALTER-appended STRICT legacy shape", () => {
    expectAlterAppendedLegacyRepair(true);
  });

  it("drops pre-ref rows that violate the canonical resolution_ref shape", () => {
    const db = new DatabaseSync(":memory:");
    createAlterAppendedLegacyTable(db, false);
    seedRow(db, "exec");
    seedRow(db, "exec", null, "a2-null-ref");
    seedRow(db, "plugin", "short", "a3-bad-ref");
    // Non-STRICT legacy tables can hold a BLOB in the TEXT column; it must be
    // filtered out or the STRICT destination insert aborts the whole repair.
    db.prepare(`
      INSERT INTO operator_approvals (
        approval_id, resolution_ref, kind, status, presentation_json,
        reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
        created_at_ms, expires_at_ms, updated_at_ms
      ) VALUES ('a4-blob-ref', ?, 'exec', 'pending', '{}', '[]', '[]', 1, 1, 1, 1);
    `).run(Buffer.from("ref0000000000000000000000000000000000000000"));

    expect(repairOperatorApprovalSchema(db)).toEqual([
      "Migrated shared state operator approvals → OpenClaw system changes",
    ]);

    expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
    expect(db.prepare("SELECT approval_id, resolution_ref FROM operator_approvals").all()).toEqual([
      { approval_id: "a1", resolution_ref: RESOLUTION_REF },
    ]);
    db.close();
  });

  it("is a no-op when the schema is already canonical", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(canonicalOperatorApprovalCreateSql());
    expect(repairOperatorApprovalSchema(db)).toEqual([]);
    db.close();
  });

  it("refuses to replace an arbitrarily different table", () => {
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
