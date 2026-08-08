import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { exportTrajectoryBundle } from "./export.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-ancestor-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("trajectory sensitive ancestor persistence", () => {
  it("redacts nested values before SQLite and export without mutating source data", async () => {
    const tempDir = makeTempDir();
    const outputDir = path.join(tempDir, "bundle");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "session-ancestor";
    const sessionTarget = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:session-ancestor",
      storePath,
    };
    await replaceTranscriptEvents(sessionTarget, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-07T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "entry-user",
        parentId: null,
        timestamp: "2026-08-07T12:00:01.000Z",
        message: {
          role: "user",
          content: "ordinary transcript content",
          timestamp: 1,
        },
      },
    ]);
    const secrets = {
      authorization: "opaque-persisted-authorization-1234567890",
      key: "opaque-persisted-key-1234567890",
      session: "opaque-persisted-session-1234567890",
      signature: "opaque-persisted-signature-1234567890",
      token: "opaque-persisted-token-1234567890",
    };
    const sourceData = {
      diagnostics: {
        key: { nested: secrets.key, values: [secrets.key, 17] },
        session: { nested: secrets.session, values: [secrets.session, false] },
        signature: { nested: secrets.signature, values: [secrets.signature, 23] },
        token: { nested: secrets.token },
        authorization: { nested: secrets.authorization },
        sessionCount: { nested: "visible-session-count-value" },
      },
      error: { code: "ERR_VISIBLE_OUTSIDE_SENSITIVE_ANCESTOR" },
      assistantTexts: ["ordinary assistant output"],
    };
    const originalSourceData = structuredClone(sourceData);
    const recorder = expectDefined(
      createTrajectoryRuntimeRecorder({
        sessionId,
        sessionKey: sessionTarget.sessionKey,
        sessionTarget,
        workspaceDir: tempDir,
      }),
      "SQLite trajectory recorder",
    );

    recorder.recordEvent("model.completed", sourceData);
    await recorder.flush();

    expect(sourceData).toEqual(originalSourceData);
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(sourceData)).toContain(secret);
    }

    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
    const rows = database.db
      .prepare(
        "SELECT event_json FROM trajectory_runtime_events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as Array<{ event_json: string }>;
    expect(rows).toHaveLength(1);
    const storedText = expectDefined(rows[0], "stored trajectory event").event_json;
    for (const secret of Object.values(secrets)) {
      expect(storedText).not.toContain(secret);
    }
    expect(storedText).toContain("visible-session-count-value");
    expect(storedText).toContain("ERR_VISIBLE_OUTSIDE_SENSITIVE_ANCESTOR");

    await exportTrajectoryBundle({
      outputDir,
      sessionTarget,
      sessionId,
      sessionKey: sessionTarget.sessionKey,
      workspaceDir: tempDir,
    });
    const exportedFiles = fs.readdirSync(outputDir);
    expect(exportedFiles.length).toBeGreaterThan(0);
    for (const file of exportedFiles) {
      const contents = fs.readFileSync(path.join(outputDir, file), "utf8");
      for (const secret of Object.values(secrets)) {
        expect(contents, file).not.toContain(secret);
      }
    }
    expect(sourceData).toEqual(originalSourceData);
  });
});
