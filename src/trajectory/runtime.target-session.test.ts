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
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
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
  it("redacts trusted target echoes through completion, SQLite, and export", async () => {
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
      {
        type: "message",
        id: "entry-user",
        parentId: null,
        timestamp: "2026-08-07T12:00:01.000Z",
        message: {
          role: "user",
          content: `transcript echo ${targetSessionKey}`,
          timestamp: 1,
        },
      },
    ]);
    const result = jsonResult({ sessionKey: targetSessionKey });
    const originalResult = structuredClone(result);
    const messagesSnapshot = [
      {
        role: "assistant",
        content: [{ type: "text", text: `terminal echo ${targetSessionKey}` }],
      },
    ];
    const originalMessagesSnapshot = structuredClone(messagesSnapshot);
    const transcriptBefore = await loadTranscriptEvents(sessionTarget);
    const originalTranscript = structuredClone(transcriptBefore);
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
    recorder.recordEvent("model.completed", {
      assistantTexts: [`assistant echo ${targetSessionKey}`],
      finalPromptText: `final echo ${targetSessionKey}`,
      messagesSnapshot,
    });
    await recorder.flush();

    expect(result).toEqual(originalResult);
    expect(messagesSnapshot).toEqual(originalMessagesSnapshot);
    expect(await loadTranscriptEvents(sessionTarget)).toEqual(originalTranscript);
    expect(JSON.stringify(result)).toContain(targetSessionKey);
    expect(JSON.stringify(messagesSnapshot)).toContain(targetSessionKey);
    expect(JSON.stringify(originalTranscript)).toContain(targetSessionKey);
    const targetSessionHash = hashTrajectoryIdentifier(
      TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
      targetSessionKey,
    );
    const targetTextHash = hashTrajectoryIdentifier(PROVENANCE_TEXT_HASH_DOMAIN, targetSessionKey);
    const storedEvents = await loadSqliteTrajectoryRuntimeEvents({ sessionId, storePath });
    expect(storedEvents).toHaveLength(2);
    const storedResult = expectDefined(
      storedEvents.find((event) => event.type === "tool.result"),
      "stored tool.result event",
    );
    const storedCompletion = expectDefined(
      storedEvents.find((event) => event.type === "model.completed"),
      "stored model.completed event",
    );
    expect(storedResult.data?.targetSessionHash).toBe(targetSessionHash);
    expect(storedCompletion.data?.targetSessionHash).toBeUndefined();
    expect(JSON.stringify(storedCompletion.data?.messagesSnapshot)).toContain(targetTextHash);
    const storedEventText = JSON.stringify(storedEvents);
    expect(storedEventText).not.toContain(targetSessionKey);
    expect(storedEventText).toContain(targetTextHash);
    expect(storedEventText.match(/"targetSessionHash"/gu)).toHaveLength(1);

    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
    const rows = database.db
      .prepare(
        "SELECT event_json FROM trajectory_runtime_events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as Array<{ event_json: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.event_json).not.toContain(targetSessionKey);
    }
    expect(rows.map((row) => row.event_json).join("\n")).toContain(targetTextHash);

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
    expect(bundle.events.every((event) => event.source === "runtime")).toBe(true);
    expect(bundle.manifest.transcriptEventCount).toBe(0);
    expect(bundle.manifest.leafId).toBeNull();
    const sessionBranch = JSON.parse(
      fs.readFileSync(path.join(outputDir, "session-branch.json"), "utf8"),
    ) as { entries?: unknown[]; leafId?: unknown };
    expect(sessionBranch.entries).toEqual([]);
    expect(sessionBranch.leafId).toBeNull();
    expect(await loadTranscriptEvents(sessionTarget)).toEqual(originalTranscript);
    expect(messagesSnapshot).toEqual(originalMessagesSnapshot);
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
    recorder.recordEvent("model.completed", { finalPromptText: targetSessionKey });

    const event = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(event.data).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
      targetSessionHash: hashTrajectoryIdentifier(
        TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
        targetSessionKey,
      ),
    });
    const laterEvent = JSON.parse(expectDefined(writes[1], "writes[1] test invariant"));
    expect(laterEvent.data).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
    });
    expect(JSON.stringify(event)).not.toContain(targetSessionKey);
    expect(JSON.stringify(result)).toContain(targetSessionKey);
  });

  it("fails closed after 64 distinct targets while duplicates remain safe", () => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const targetSessionKeys = Array.from(
      { length: 65 },
      (_value, index) => `agent:worker:${index}:main`,
    );

    for (const [index, targetSessionKey] of targetSessionKeys.slice(0, 64).entries()) {
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
    const firstTarget = expectDefined(targetSessionKeys[0], "first target");
    recorder.recordToolResult(
      {
        name: "sessions_send",
        toolCallId: "call-duplicate",
        success: true,
        result: jsonResult({ sessionKey: firstTarget }),
      },
      targetSessionSnapshot(firstTarget),
    );
    const overflowTarget = expectDefined(targetSessionKeys[64], "overflow target");
    recorder.recordToolResult(
      {
        name: "sessions_send",
        toolCallId: "call-overflow",
        success: true,
        result: jsonResult({ sessionKey: overflowTarget }),
      },
      targetSessionSnapshot(overflowTarget),
    );
    recorder.recordEvent("model.completed", { finalPromptText: firstTarget });

    expect(writes).toHaveLength(67);
    for (const [index, targetSessionKey] of targetSessionKeys.slice(0, 64).entries()) {
      const event = JSON.parse(expectDefined(writes[index], `writes[${index}] test invariant`));
      expect(event.data.redacted).not.toBe(true);
      expect(event.data.targetSessionHash).toBe(
        hashTrajectoryIdentifier(TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN, targetSessionKey),
      );
      expect(JSON.stringify(event)).not.toContain(targetSessionKey);
    }
    expect(JSON.parse(expectDefined(writes[64], "duplicate target event")).data.redacted).not.toBe(
      true,
    );
    expect(JSON.parse(expectDefined(writes[65], "overflow target event")).data).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
      targetSessionHash: hashTrajectoryIdentifier(
        TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
        overflowTarget,
      ),
    });
    expect(JSON.parse(expectDefined(writes[66], "post-overflow event")).data).toEqual({
      redacted: true,
      reason: "trajectory-target-sanitization-limit",
    });
  });
});
