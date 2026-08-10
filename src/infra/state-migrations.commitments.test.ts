// Covers Doctor-only removal of retired inferred-commitment state.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  detectRetiredCommitments,
  discardRetiredCommitments,
} from "./state-migrations.commitments.js";

describe("retired commitments Doctor cleanup", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  function useStateDir(): string {
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
    const stateDir = tempDirs.make("openclaw-retired-commitments-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  function seedRetiredRow(): void {
    openOpenClawStateDatabase()
      .db.prepare(
        `INSERT INTO commitments (
        id, agent_id, session_key, channel, kind, sensitivity, source, status,
        reason, suggested_text, dedupe_key, confidence, due_earliest_ms,
        due_latest_ms, due_timezone, created_at_ms, updated_at_ms, attempts, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "cm_retired",
        "main",
        "agent:main:main",
        "telegram",
        "followup",
        "normal",
        "unknown",
        "pending",
        "retired",
        "retired",
        "retired",
        1,
        1,
        2,
        "UTC",
        1,
        1,
        0,
        "{}",
      );
  }

  it("detects retired state only during explicit Doctor repair", async () => {
    const stateDir = useStateDir();
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, "{}", "utf8");
    seedRetiredRow();

    expect(detectRetiredCommitments({ stateDir })).toMatchObject({
      hasLegacy: false,
      hasLegacyFile: false,
      rowCount: 0,
    });
    expect(detectRetiredCommitments({ stateDir, doctorOnlyStateMigrations: true })).toMatchObject({
      hasLegacy: true,
      hasLegacyFile: true,
      rowCount: 1,
    });
  });

  it("removes legacy JSON and stored rows without dropping the inert table", async () => {
    const stateDir = useStateDir();
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, "{}", "utf8");
    seedRetiredRow();

    const result = discardRetiredCommitments({
      detected: detectRetiredCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result).toEqual({
      changes: ["Removed 1 retired commitment row", "Removed retired commitments JSON"],
      warnings: [],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(
      openOpenClawStateDatabase().db.prepare("SELECT COUNT(*) AS count FROM commitments").get(),
    ).toEqual({ count: 0 });
  });

  it("keeps a symlinked legacy source while still removing database rows", async () => {
    const stateDir = useStateDir();
    const realPath = path.join(stateDir, "outside.json");
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fsp.writeFile(realPath, "{}", "utf8");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.symlink(realPath, sourcePath);
    seedRetiredRow();

    const result = discardRetiredCommitments({
      detected: detectRetiredCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.changes).toEqual(["Removed 1 retired commitment row"]);
    expect(result.warnings[0]).toContain("non-symlink file");
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
  });
});
