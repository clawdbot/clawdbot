import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryIsolationCutoverForTest } from "../plugins/memory-cutover.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runDoctorMemoryIsolation } from "./doctor-memory-isolation.js";

describe("runDoctorMemoryIsolation", () => {
  let stateDir = "";
  const cfg = {
    agents: { list: [{ id: "main", default: true }, { id: "support" }] },
  } as const;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-memory-isolation-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO session_memory_subjects
         (session_key, binding_id, principal_id, subject_kind, subject_revision, created_at)
         VALUES ('agent:main:pilot', NULL, 'principal-alice', 'agent', 'pilot-revision', 1)`,
      )
      .run();
  });

  afterEach(() => {
    resetMemoryIsolationCutoverForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  it("owns the reversible configured-agent shadow lifecycle", () => {
    expect(runDoctorMemoryIsolation({ action: "status", cfg })).toEqual({
      agentId: "main",
      mode: "legacy",
      restartRequired: false,
    });
    expect(runDoctorMemoryIsolation({ action: "shadow-read-only", cfg, nowMs: 1 })).toEqual({
      agentId: "main",
      mode: "shadow-read-only",
      restartRequired: true,
    });
    expect(runDoctorMemoryIsolation({ action: "legacy", cfg })).toEqual({
      agentId: "main",
      mode: "legacy",
      restartRequired: true,
    });
  });

  it("refuses an agent outside runtime configuration", () => {
    expect(() =>
      runDoctorMemoryIsolation({ action: "shadow-read-only", agentId: "missing", cfg }),
    ).toThrow('Unknown configured agent id "missing".');
  });
});
