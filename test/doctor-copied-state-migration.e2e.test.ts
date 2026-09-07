// Regression for the copied shared-state upgrade reported from 2026.6.1-beta.1.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const HISTORICAL_DEVICE_BOOTSTRAP_TOKENS_SQL = `
CREATE TABLE device_bootstrap_tokens (
  token_key TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  device_id TEXT,
  public_key TEXT,
  profile_json TEXT,
  redeemed_profile_json TEXT,
  pending_profile_json TEXT,
  issued_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER
);

CREATE INDEX idx_device_bootstrap_tokens_ts
  ON device_bootstrap_tokens(ts);
`;

const HISTORICAL_OPERATOR_APPROVALS_SQL = `
CREATE TABLE operator_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(approval_id) > 0 AND approval_id NOT IN ('.', '..')
  ),
  resolution_ref TEXT NOT NULL CHECK (
    length(resolution_ref) = 43 AND resolution_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('exec', 'plugin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  presentation_json TEXT NOT NULL,
  requested_by_device_id TEXT,
  requested_by_client_id TEXT,
  requested_by_device_token_auth INTEGER NOT NULL DEFAULT 0,
  reviewer_device_ids_json TEXT NOT NULL,
  source_agent_id TEXT,
  source_session_key TEXT,
  source_session_id TEXT,
  source_run_id TEXT,
  source_tool_call_id TEXT,
  source_tool_name TEXT,
  audience_session_keys_json TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('allow-once', 'allow-always', 'deny')),
  terminal_reason TEXT CHECK (
    terminal_reason IN (
      'user',
      'timeout',
      'malformed-verdict',
      'no-route',
      'run-aborted',
      'gateway-restart',
      'storage-corrupt'
    )
  ),
  resolved_at_ms INTEGER,
  resolver_kind TEXT CHECK (resolver_kind IN ('device', 'channel', 'runtime', 'system')),
  resolver_id TEXT,
  consumed_at_ms INTEGER,
  consumed_by TEXT,
  CHECK (expires_at_ms >= created_at_ms),
  CHECK (updated_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms <= updated_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= resolved_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms <= updated_at_ms),
  CHECK (requested_by_device_token_auth IN (0, 1)),
  CHECK (
    (
      status = 'pending'
      AND decision IS NULL
      AND terminal_reason IS NULL
      AND resolved_at_ms IS NULL
      AND resolver_kind IS NULL
      AND resolver_id IS NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'allowed'
      AND decision IN ('allow-once', 'allow-always')
      AND terminal_reason = 'user'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
    )
    OR (
      status = 'denied'
      AND decision = 'deny'
      AND terminal_reason IN ('user', 'malformed-verdict', 'no-route', 'storage-corrupt')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'expired'
      AND decision = 'deny'
      AND terminal_reason = 'timeout'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'cancelled'
      AND decision = 'deny'
      AND terminal_reason IN ('run-aborted', 'gateway-restart')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
  ),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_by IS NULL)
    OR (
      status = 'allowed'
      AND decision = 'allow-once'
      AND consumed_at_ms IS NOT NULL
      AND consumed_by IS NOT NULL
    )
  )
);

CREATE INDEX idx_operator_approvals_status_expiry
  ON operator_approvals(status, expires_at_ms, approval_id);

CREATE UNIQUE INDEX idx_operator_approvals_resolution_ref
  ON operator_approvals(resolution_ref);

CREATE INDEX idx_operator_approvals_source_session_created
  ON operator_approvals(source_session_key, created_at_ms DESC, approval_id);

CREATE INDEX idx_operator_approvals_resolved
  ON operator_approvals(resolved_at_ms, approval_id)
  WHERE resolved_at_ms IS NOT NULL;

CREATE INDEX idx_operator_approvals_runtime_pending
  ON operator_approvals(runtime_epoch, approval_id)
  WHERE status = 'pending';
`;

function writeHistoricalCopiedStateFixture(stateDir: string): void {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    database.exec(`
      DROP TABLE device_bootstrap_tokens;
      ${HISTORICAL_DEVICE_BOOTSTRAP_TOKENS_SQL}
      DROP TABLE operator_approvals;
      ${HISTORICAL_OPERATOR_APPROVALS_SQL}
      PRAGMA user_version = 2;
      INSERT INTO schema_meta (
        meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
      ) VALUES ('primary', 'global', 2, NULL, NULL, 0, 0);
      INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms)
      VALUES ('fixture-bootstrap', 'fixture-token', 1000, 1000);
    `);
  } finally {
    database.close();
  }
}

describe("doctor copied-state migration", () => {
  it(
    "repairs the retained 2026.6.1-beta.1 shared state before gateway readiness",
    { timeout: 180_000 },
    async () => {
      const instance = await createOpenClawTestInstance({ name: "doctor-copied-state" });
      try {
        writeHistoricalCopiedStateFixture(instance.stateDir);

        const doctor = await instance.cli(
          ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
          { timeoutMs: 120_000 },
        );

        expect(doctor.code, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
        expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain(
          "Failed migrating shared state database schema",
        );
        await instance.startGateway();
      } finally {
        await instance.cleanup();
      }
    },
  );
});
