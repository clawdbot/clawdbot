import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

const trailingSchema = vi.hoisted(() => ({
  tableName: "future_lazy_state",
  sql: "CREATE TABLE IF NOT EXISTS future_lazy_state (id TEXT PRIMARY KEY) STRICT;",
}));

vi.mock("./openclaw-state-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-schema.js")>();
  return {
    ...actual,
    OPENCLAW_STATE_SCHEMA_SQL: `${actual.OPENCLAW_STATE_SCHEMA_SQL}\n${trailingSchema.sql}\n`,
  };
});

import {
  ensureAdditiveStateColumns,
  ensureSecretStoreSchema,
} from "./openclaw-state-db-schema-additive.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

it("keeps secret-store first use from installing later additive schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    ensureSecretStoreSchema(database);
    const names = database
      .prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?) ORDER BY name")
      .all("secret_store_entries", "secret_store_entries_live_idx", trailingSchema.tableName)
      .map((row) => row.name);

    expect(names).toEqual(["secret_store_entries", "secret_store_entries_live_idx"]);
  } finally {
    database.close();
  }
const ATTACHMENT_ID = "12345678-1234-4123-8123-123456789abc";

describe("ensureAdditiveStateColumns", () => {
  it("retires shipped unconfined attachment cleanup before registry reads", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    const workspaceDir = path.resolve("/tmp/openclaw-additive-workspace");
    const attachmentsRootDir = path.join(workspaceDir, ".openclaw", "attachments");
    db.prepare(`
      INSERT INTO subagent_runs (
        run_id, child_session_key, requester_session_key, requester_display_key,
        task, cleanup, created_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-attachment-root",
      "agent:worker:subagent:child",
      "agent:main:main",
      "agent:main:main",
      "test",
      "delete",
      1,
      JSON.stringify({
        attachmentsRootDir,
        attachmentsDir: path.join(attachmentsRootDir, ATTACHMENT_ID),
      }),
    );

    ensureAdditiveStateColumns(db);

    const row = db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get("legacy-attachment-root") as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("attachmentsDir");
    expect(payload).not.toHaveProperty("attachmentsRootDir");
  });
});
