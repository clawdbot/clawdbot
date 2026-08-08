import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readLatestSessionUsageFromTranscriptAsync } from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript reader SQLite usage marker", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = tempDirs.make("openclaw-transcript-readers-marker-");
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  test("retires a stale cumulative SQLite total at an unavailable context marker", async () => {
    const sessionId = "reader-sqlite-unavailable-marker";
    const sessionKey = `agent:main:${sessionId}`;
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    const assistantUsageMessage = (usage: Record<string, unknown>) => ({
      message: {
        role: "assistant",
        provider: "minimax",
        model: "Minimax-M3",
        usage,
      },
    });

    await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        assistantUsageMessage({
          input: 285_000,
          output: 1_200,
          cacheRead: 214_656,
          cacheWrite: 0,
          total: 500_856,
        }),
        assistantUsageMessage({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          contextUsage: { state: "unavailable" },
        }),
      ],
      touchSessionEntry: false,
    });

    const afterMarker = await readLatestSessionUsageFromTranscriptAsync(scope);
    expect(afterMarker).not.toBeNull();
    expect(afterMarker?.totalTokens).toBeUndefined();
    expect(afterMarker?.totalTokensFresh).not.toBe(true);
    expect(afterMarker?.contextUsage).toEqual({ state: "unavailable" });

    await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        assistantUsageMessage({
          input: 12_000,
          output: 800,
          total: 12_800,
        }),
      ],
      touchSessionEntry: false,
    });

    const afterValidUsage = await readLatestSessionUsageFromTranscriptAsync(scope);
    expect(afterValidUsage).toMatchObject({
      totalTokens: 12_000,
      totalTokensFresh: true,
    });
    expect(afterValidUsage?.contextUsage).toBeUndefined();
  });
});
