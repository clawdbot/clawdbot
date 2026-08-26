import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readTrajectoryDetail, readTrajectoryPage } from "./read-model.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("trajectory read model", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:main";
  const sessionId = "trajectory-session";

  beforeEach(async () => {
    tempDir = tempDirs.make("openclaw-trajectory-read-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, updatedAt: Date.parse("2026-08-22T12:00:00.000Z") },
    );
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-22T12:00:01.000Z",
        message: { role: "user", content: "Inspect the deployment", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-08-22T12:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Deployment is healthy." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.6-luna",
          usage: {
            input: 12,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 16,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 4,
        },
      },
    ]);
    appendSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId, storePath }, [
      runtimeEvent("session.started", "2026-08-22T12:00:02.000Z"),
      runtimeEvent("model.completed", "2026-08-22T12:00:03.000Z", {
        usage: { input: 12, output: 4 },
      }),
    ]);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("pages the merged durable timeline without duplicating semantic rows", () => {
    const target = { agentId: "main", sessionId, sessionKey, storePath };
    const tail = readTrajectoryPage({ target, limit: 2 });

    expect(tail.records.map((record) => record.id)).toEqual([
      "runtime:1",
      "transcript:assistant-1",
    ]);
    expect(tail.hasMore).toBe(true);
    expect(tail.cursor).toBeTruthy();

    const earlier = readTrajectoryPage({ target, cursor: tail.cursor, limit: 2 });
    expect(earlier.records.map((record) => record.id)).toEqual(["transcript:user-1", "runtime:0"]);
    expect(new Set([...earlier.records, ...tail.records].map((record) => record.id)).size).toBe(4);
  });

  it("returns a bounded display detail for a selected transcript record", () => {
    const result = readTrajectoryDetail({
      target: { agentId: "main", sessionId, sessionKey, storePath },
      recordId: "transcript:assistant-1",
    });

    expect(result).toMatchObject({
      ok: true,
      record: {
        id: "transcript:assistant-1",
        kind: "assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
      },
    });
    expect(JSON.stringify(result.detail)).toContain("Deployment is healthy.");
  });

  it("returns only display-projected runtime detail fields", () => {
    const result = readTrajectoryDetail({
      target: { agentId: "main", sessionId, sessionKey, storePath },
      recordId: "runtime:1",
    });

    expect(result).toMatchObject({
      ok: true,
      detail: {
        type: "model.completed",
        data: { usage: { input: 12, output: 4 } },
      },
    });
    expect(result.detail).not.toHaveProperty("traceId");
    expect(result.detail).not.toHaveProperty("sessionId");
    expect(result.detail).not.toHaveProperty("sessionKey");
    expect(result.detail).not.toHaveProperty("workspaceDir");
  });

  it("deduplicates matching runtime and transcript tool results across page boundaries", async () => {
    const target = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceTranscriptEvents(target, [
      {
        type: "message",
        id: "user-tool",
        parentId: null,
        timestamp: "2026-08-22T12:00:01.000Z",
        message: { role: "user", content: "Run the check", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-tool",
        parentId: "user-tool",
        timestamp: "2026-08-22T12:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.6-luna",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 4,
        },
      },
      {
        type: "message",
        id: "transcript-tool-result",
        parentId: "assistant-tool",
        timestamp: "2026-08-22T12:00:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "exec",
          content: [{ type: "text", text: "passed" }],
          isError: false,
          timestamp: 5,
        },
      },
      {
        type: "message",
        id: "assistant-final",
        parentId: "transcript-tool-result",
        timestamp: "2026-08-22T12:00:07.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The check passed." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.6-luna",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 7,
        },
      },
    ]);
    appendSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId, storePath }, [
      runtimeEvent("tool.result", "2026-08-22T12:00:06.000Z", {
        toolCallId: "call-1",
        name: "exec",
        result: "passed",
        isError: false,
      }),
    ]);

    const records = [];
    let cursor: string | undefined;
    let finalHasMore = true;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = readTrajectoryPage({ target, cursor, limit: 1 });
      records.push(...page.records);
      finalHasMore = page.hasMore;
      if (!page.hasMore || !page.cursor) {
        break;
      }
      cursor = page.cursor;
    }

    expect(records.map((record) => record.id)).toEqual([
      "transcript:assistant-final",
      "runtime:2",
      "transcript:assistant-tool",
      "runtime:1",
      "runtime:0",
      "transcript:user-tool",
    ]);
    expect(
      records.filter((record) => record.toolCallId === "call-1" && record.status === "completed"),
    ).toHaveLength(1);
    expect(finalHasMore).toBe(false);
  });

  it("reports the existing capture override without hiding transcript facts", () => {
    const result = readTrajectoryPage({
      target: { agentId: "main", sessionId, sessionKey, storePath },
      env: { OPENCLAW_TRAJECTORY: "0" },
    });

    expect(result.capture).toBe("disabled");
    expect(result.records.some((record) => record.kind === "user")).toBe(true);
  });

  function runtimeEvent(type: string, ts: string, data?: Record<string, unknown>): TrajectoryEvent {
    return {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: sessionId,
      source: "runtime",
      type,
      ts,
      seq: 1,
      sessionId,
      sessionKey,
      runId: "run-1",
      workspaceDir: "/private/workspace",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      ...(data ? { data } : {}),
    };
  }
});
