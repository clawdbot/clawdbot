import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { repairCanonicalSessionResolvedSkills } from "./doctor-session-resolved-skills.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function insertSessionRow(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  entry: Record<string, unknown>,
  agentId = "main",
): void {
  const database = openOpenClawAgentDatabase({ agentId, env });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key, spawned_by) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      sessionKey,
      String(entry.sessionId),
      JSON.stringify(entry),
      Number(entry.updatedAt),
      typeof entry.parentSessionKey === "string" ? entry.parentSessionKey : null,
      typeof entry.spawnedBy === "string" ? entry.spawnedBy : null,
    );
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, channel, account_id) VALUES (?, ?, 'conversation', ?, ?, ?, ?)",
    )
    .run(
      String(entry.sessionId),
      sessionKey,
      Number(entry.updatedAt),
      Number(entry.updatedAt),
      null,
      null,
    );
}

function readEntryJson(env: NodeJS.ProcessEnv, sessionKey: string): string {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const row = database.db
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { entry_json: string };
  return row.entry_json;
}

/** Mirrors a pre-fix durable row: the full parsed SKILL.md catalog was persisted. */
function bloatedSkillsSnapshot(): Record<string, unknown> {
  return {
    prompt: "skill prompt",
    skills: [{ name: "demo-skill" }],
    resolvedSkills: [{ name: "demo-skill", description: "x".repeat(200_000) }],
    version: 1,
  };
}

describe("doctor canonical session resolved skills", () => {
  it("strips the runtime-only skills catalog from durable session rows", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-skills-strip-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:skill-strip", {
      sessionId: "skill-strip-1",
      updatedAt: 1234,
      skillsSnapshot: bloatedSkillsSnapshot(),
    });

    expect(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });

    // The catalog is gone from the durable row; the persisted snapshot fields survive.
    const onDisk = JSON.parse(readEntryJson(env, "agent:main:skill-strip"));
    expect(onDisk.skillsSnapshot.resolvedSkills).toBeUndefined();
    expect(onDisk.skillsSnapshot.prompt).toBe("skill prompt");
    expect(onDisk.skillsSnapshot.skills).toEqual([{ name: "demo-skill" }]);

    // The read path (no catalog hydration at this layer) reflects the stripped row.
    const entry = listSessionEntriesCore({ agentId: "main", env })[0]?.entry;
    expect(entry?.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(entry?.skillsSnapshot?.skills).toEqual([{ name: "demo-skill" }]);
  });

  it("is idempotent: a second run finds nothing left to strip", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-skills-idempotent-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:skill-idem", {
      sessionId: "skill-idem-1",
      updatedAt: 1234,
      skillsSnapshot: bloatedSkillsSnapshot(),
    });

    expect(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env })).toEqual({
      found: 0,
      repaired: 0,
      scannedStores: 1,
    });
  });

  it("dry-run reports found rows without mutating the durable catalog", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-skills-dryrun-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:skill-dry", {
      sessionId: "skill-dry-1",
      updatedAt: 1234,
      skillsSnapshot: bloatedSkillsSnapshot(),
    });

    expect(repairCanonicalSessionResolvedSkills({ apply: false, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 0,
      scannedStores: 1,
    });
    expect(
      JSON.parse(readEntryJson(env, "agent:main:skill-dry")).skillsSnapshot.resolvedSkills,
    ).toBeDefined();
  });

  it("leaves rows that never carried the catalog untouched", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-skills-clean-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:skill-clean", {
      sessionId: "skill-clean-1",
      updatedAt: 1234,
      skillsSnapshot: { prompt: "skill prompt", skills: [{ name: "demo-skill" }], version: 1 },
    });

    expect(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env })).toEqual({
      found: 0,
      repaired: 0,
      scannedStores: 1,
    });
  });
});
