import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentToolExecutionPrivateState,
  recordAgentToolTargetSessionKey,
  runWithAgentToolExecutionPrivateState,
  snapshotAgentToolExecutionPrivateState,
} from "../../packages/agent-core/src/tool-execution-private-state.js";
import { jsonResult } from "../agents/tools/tool-results.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { exportTrajectoryBundle } from "./export.js";
import {
  hashTrajectoryIdentifier,
  TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
} from "./provenance-sanitization.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

type Recorder = NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

const PROVENANCE_TEXT_HASH_DOMAIN = "openclaw:trajectory:provenance-text:v1";
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-target-"));
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

function targetSessionSnapshot(targetSessionKey: string) {
  const state = createAgentToolExecutionPrivateState();
  runWithAgentToolExecutionPrivateState(state, () => {
    recordAgentToolTargetSessionKey(targetSessionKey);
  });
  return snapshotAgentToolExecutionPrivateState(state);
}

function createRecorder(writes: string[], inputProvenance?: unknown): Recorder {
  const recorder = createTrajectoryRuntimeRecorder({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    inputProvenance,
    writer: {
      filePath: "/tmp/session.trajectory.jsonl",
      write: (line) => writes.push(line),
      flush: async () => undefined,
    },
  });
  expect(recorder).not.toBeNull();
  return recorder as Recorder;
}

describe("trajectory target-session recording", () => {
  it("redacts trusted target echoes before SQLite export without mutating the tool result", async () => {
    const tempDir = makeTempDir();
    const storePath = path.join(tempDir, "sessions.json");
    const outputDir = path.join(tempDir, "bundle");
    const sessionId = "session-1";
    const sessionKey = "agent:main:session-1";
    const persistentIdentity = "agent:worker:main";
    const targetSessionKey = persistentIdentity + ".+*?^${}()|[]credential";
    const sessionTarget = {
      agentId: "main",
      sessionId,
      sessionKey,
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
    ]);
    const result = jsonResult({ sessionKey: targetSessionKey });
    const originalResult = structuredClone(result);
    const recorder = expectDefined(
      createTrajectoryRuntimeRecorder({
        sessionId,
        sessionKey,
        sessionTarget,
        workspaceDir: tempDir,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: persistentIdentity,
        },
      }),
      "SQLite trajectory recorder",
    );

    recorder.recordToolResult(
      {
        phase: "result",
        name: "sessions_send",
        toolCallId: "call-regex",
        isError: false,
        success: true,
        result,
      },
      targetSessionSnapshot(targetSessionKey),
    );
    await recorder.flush();

    expect(result).toEqual(originalResult);
    expect(JSON.stringify(result)).toContain(targetSessionKey);
    const targetSessionHash = hashTrajectoryIdentifier(
      TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
      targetSessionKey,
    );
    const targetTextHash = hashTrajectoryIdentifier(PROVENANCE_TEXT_HASH_DOMAIN, targetSessionKey);
    const [storedEvent] = await loadSqliteTrajectoryRuntimeEvents({ sessionId, storePath });
    const storedEventText = JSON.stringify(storedEvent);
    expect(storedEvent?.data?.targetSessionHash).toBe(targetSessionHash);
    expect(storedEventText).not.toContain(targetSessionKey);
    expect(storedEventText).toContain(targetTextHash);
    expect(storedEventText.match(/"targetSessionHash"/gu)).toHaveLength(1);

    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
    const row = database.db
      .prepare(
        "SELECT event_json FROM trajectory_runtime_events WHERE session_id = ? ORDER BY seq ASC LIMIT 1",
      )
      .get(sessionId) as { event_json?: string } | undefined;
    const eventJson = expectDefined(row?.event_json, "trajectory runtime SQLite row");
    expect(eventJson).not.toContain(targetSessionKey);
    expect(eventJson).toContain(targetSessionHash);
    expect(eventJson).toContain(targetTextHash);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionTarget,
      sessionId,
      sessionKey,
      workspaceDir: tempDir,
    });
    for (const file of fs.readdirSync(outputDir)) {
      expect(fs.readFileSync(path.join(outputDir, file), "utf8"), file).not.toContain(
        targetSessionKey,
      );
    }
    const exportedResult = expectDefined(
      bundle.events.find((event) => event.type === "tool.result"),
      "exported tool.result event",
    );
    const exportedResultText = JSON.stringify(exportedResult);
    expect(exportedResult.data?.targetSessionHash).toBe(targetSessionHash);
    expect(exportedResultText).toContain(targetTextHash);
    expect(exportedResultText.match(/"targetSessionHash"/gu)).toHaveLength(1);
  });

  it("records only trusted target-session hashes and consumes snapshots once", () => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const targetSessionKey = "agent:worker:main";
    const expectedHash = hashTrajectoryIdentifier(
      TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
      targetSessionKey,
    );
    const firstSnapshot = targetSessionSnapshot(targetSessionKey);
    const secondSnapshot = targetSessionSnapshot(targetSessionKey);

    recorder.recordEvent("tool.result", {
      toolCallId: "forged",
      targetSessionHash: `sha256:v1:${"f".repeat(64)}`,
    });
    recorder.recordToolResult(
      {
        toolCallId: "call-1",
        name: "sessions_send",
        success: true,
        targetSessionHash: `sha256:v1:${"e".repeat(64)}`,
        result: { details: { sessionKey: targetSessionKey } },
      },
      firstSnapshot,
    );
    recorder.recordToolResult({ toolCallId: "call-2", name: "sessions_send" }, secondSnapshot);
    recorder.recordToolResult({ toolCallId: "call-3", name: "sessions_send" }, firstSnapshot);

    const events = writes.map((line) => JSON.parse(line) as { data: Record<string, unknown> });
    expect(events[0]?.data.targetSessionHash).toBeUndefined();
    expect(events[1]?.data).toMatchObject({
      toolCallId: "call-1",
      targetSessionHash: expectedHash,
    });
    expect(events[2]?.data).toMatchObject({
      toolCallId: "call-2",
      targetSessionHash: expectedHash,
    });
    expect(events[3]?.data.targetSessionHash).toBeUndefined();
    expect(writes.join("\n")).not.toContain(targetSessionKey);
  });

  it("preserves target identity and outcome in oversized tool-result fallbacks", () => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const targetSessionKey = "agent:worker:main";

    recorder.recordToolResult(
      {
        name: "sessions_send",
        toolCallId: "call-oversized",
        isError: true,
        success: false,
        result: Array.from({ length: 64 }, () => "x".repeat(8_000)),
      },
      targetSessionSnapshot(targetSessionKey),
    );

    const event = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(event.data).toMatchObject({
      truncated: true,
      name: "sessions_send",
      toolCallId: "call-oversized",
      isError: true,
      success: false,
      targetSessionHash: hashTrajectoryIdentifier(
        TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
        targetSessionKey,
      ),
    });
    expect(event.data.result).toBeUndefined();
  });

  it.each([
    { name: "short", targetSessionKey: "short" },
    { name: "oversized", targetSessionKey: "x".repeat(4097) },
  ])("fails closed for $name trusted target identities", ({ targetSessionKey }) => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const result = jsonResult({ sessionKey: targetSessionKey });

    recorder.recordToolResult(
      {
        name: "sessions_send",
        toolCallId: "call-invalid",
        success: true,
        result,
      },
      targetSessionSnapshot(targetSessionKey),
    );

    const event = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(event.data).toEqual({
      redacted: true,
      reason: "trajectory-provenance-sanitization-limit",
      targetSessionHash: hashTrajectoryIdentifier(
        TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
        targetSessionKey,
      ),
    });
    expect(JSON.stringify(event)).not.toContain(targetSessionKey);
    expect(JSON.stringify(result)).toContain(targetSessionKey);
  });

  it("does not add per-call target identities to the run-wide replacement cache", () => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const targetSessionKeys = Array.from(
      { length: 65 },
      (_value, index) => `agent:worker:${index}:main`,
    );

    for (const [index, targetSessionKey] of targetSessionKeys.entries()) {
      recorder.recordToolResult(
        {
          name: "sessions_send",
          toolCallId: `call-${index}`,
          success: true,
          result: jsonResult({ sessionKey: targetSessionKey }),
        },
        targetSessionSnapshot(targetSessionKey),
      );
    }

    expect(writes).toHaveLength(targetSessionKeys.length);
    for (const [index, targetSessionKey] of targetSessionKeys.entries()) {
      const event = JSON.parse(expectDefined(writes[index], `writes[${index}] test invariant`));
      expect(event.data.redacted).not.toBe(true);
      expect(event.data.targetSessionHash).toBe(
        hashTrajectoryIdentifier(TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN, targetSessionKey),
      );
      expect(JSON.stringify(event)).not.toContain(targetSessionKey);
    }
  });
});
