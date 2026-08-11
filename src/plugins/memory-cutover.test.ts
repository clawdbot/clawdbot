import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  disableMemoryShadowReadOnlyMode,
  enableMemoryShadowReadOnlyMode,
  isMemoryIsolationCutoverAgent,
  resetMemoryIsolationCutoverForTest,
  resolveMemoryIsolationMode,
} from "./memory-cutover.js";

describe("memory isolation lifecycle", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-isolation-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    resetMemoryIsolationCutoverForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  function insertPilotSubject(params: { principalId: string; sessionKey?: string }) {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO session_memory_subjects
         (session_key, binding_id, principal_id, subject_kind, subject_revision, created_at)
         VALUES (?, NULL, ?, 'agent', ?, 1)`,
      )
      .run(params.sessionKey ?? "agent:main:pilot", params.principalId, randomUUID());
  }

  it("does not borrow an agent cutover state when the caller has no agent scope", () => {
    expect(isMemoryIsolationCutoverAgent("")).toBe(false);
    expect(isMemoryIsolationCutoverAgent("   ")).toBe(false);
  });

  it("persists a verified shadow-read-only marker and activates it only after a cache reset", () => {
    insertPilotSubject({ principalId: "principal-alice" });
    expect(resolveMemoryIsolationMode("main")).toBe("legacy");

    expect(enableMemoryShadowReadOnlyMode({ agentId: "main", nowMs: 1 })).toBe("shadow-read-only");
    // Doctor is a separate process. A running gateway retains its request-time posture until
    // restart, so an operator cannot flip memory authority in the middle of a run.
    expect(isMemoryIsolationCutoverAgent("main")).toBe(false);

    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("shadow-read-only");
    expect(isMemoryIsolationCutoverAgent("main")).toBe(true);

    expect(disableMemoryShadowReadOnlyMode({ agentId: "main" })).toBe("legacy");
    expect(isMemoryIsolationCutoverAgent("main")).toBe(true);
    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("legacy");
  });

  it("fails closed for a malformed reserved shadow marker", () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES ('memory-isolation-shadow-read-only-v1', 'memory-isolation-shadow-read-only',
                 'wrong-source-hash', 'verified', '{"mode":"shadow-read-only","version":1}',
                 'sha256:46920e4ef88f60e8d1f0c271dc0a1b95', 1, NULL, 1)`,
      )
      .run();

    expect(resolveMemoryIsolationMode("main")).toBe("unavailable");
    expect(isMemoryIsolationCutoverAgent("main")).toBe(true);
  });

  it("keeps final cutover exclusive and irreversible through the P1C command", () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES ('phase-6-cutover', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
      )
      .run();

    expect(resolveMemoryIsolationMode("main")).toBe("cutover");
    expect(() => enableMemoryShadowReadOnlyMode({ agentId: "main", nowMs: 2 })).toThrow(
      "final cutover",
    );
    expect(() => disableMemoryShadowReadOnlyMode({ agentId: "main" })).toThrow("final cutover");
  });
});
