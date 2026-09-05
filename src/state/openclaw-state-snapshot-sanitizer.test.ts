import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeOpenClawGlobalStateSnapshot } from "./openclaw-state-snapshot-sanitizer.js";

describe("OpenClaw state snapshot sanitizer", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE exec_approvals_config (
        config_key TEXT PRIMARY KEY,
        raw_json TEXT NOT NULL,
        socket_path TEXT,
        has_socket_token INTEGER NOT NULL,
        default_security TEXT,
        default_ask TEXT,
        default_ask_fallback TEXT,
        auto_allow_skills INTEGER,
        agent_count INTEGER NOT NULL,
        allowlist_count INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
  });

  afterEach(() => database.close());

  it("redacts the exec approvals socket token without dropping policy", () => {
    const raw = JSON.stringify({
      version: 1,
      socket: { path: "/tmp/exec.sock", token: "secret-token" },
      defaults: { security: "allowlist" },
      agents: {},
    });
    database
      .prepare(
        `INSERT INTO exec_approvals_config (
          config_key, raw_json, socket_path, has_socket_token,
          default_security, default_ask, default_ask_fallback, auto_allow_skills,
          agent_count, allowlist_count, updated_at_ms
        ) VALUES (?, ?, '/stale.sock', 1, 'full', 'always', 'full', 1, 9, 9, 1)`,
      )
      .run("current", raw);

    sanitizeOpenClawGlobalStateSnapshot(database);

    const row = database
      .prepare("SELECT * FROM exec_approvals_config WHERE config_key = 'current'")
      .get() as Record<string, unknown> & { raw_json: string };
    expect(row).toMatchObject({
      socket_path: "/tmp/exec.sock",
      has_socket_token: 0,
      default_security: "allowlist",
      default_ask: null,
      default_ask_fallback: null,
      auto_allow_skills: null,
      agent_count: 0,
      allowlist_count: 0,
    });
    expect(JSON.parse(row.raw_json)).toEqual({
      version: 1,
      socket: { path: "/tmp/exec.sock" },
      defaults: { security: "allowlist" },
      agents: {},
    });
    expect(row.raw_json).not.toContain("secret-token");
  });

  it.each([
    ["invalid JSON", "{malformed-secret-token", "secret-token"],
    [
      "invalid structure",
      JSON.stringify({ version: 1, socket: [{ token: "nested-secret-token" }], agents: {} }),
      "nested-secret-token",
    ],
  ])("replaces %s policy with a fail-closed secret-free document", (_label, raw, secret) => {
    database
      .prepare(
        `INSERT INTO exec_approvals_config (
          config_key, raw_json, socket_path, has_socket_token,
          default_security, default_ask, default_ask_fallback, auto_allow_skills,
          agent_count, allowlist_count, updated_at_ms
        ) VALUES (?, ?, '/stale.sock', 1, 'full', 'always', 'full', 1, 9, 9, 1)`,
      )
      .run("current", raw);

    sanitizeOpenClawGlobalStateSnapshot(database);

    const row = database
      .prepare("SELECT * FROM exec_approvals_config WHERE config_key = 'current'")
      .get() as Record<string, unknown> & { raw_json: string };
    expect(row).toMatchObject({
      socket_path: null,
      has_socket_token: 0,
      default_security: "deny",
      default_ask: "off",
      default_ask_fallback: "deny",
      auto_allow_skills: 0,
      agent_count: 0,
      allowlist_count: 0,
    });
    expect(JSON.parse(row.raw_json).defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(row.raw_json).not.toContain(secret);
  });
});
