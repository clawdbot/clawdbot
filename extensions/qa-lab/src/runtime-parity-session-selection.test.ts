import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  closeOpenClawAgentDatabasesForTest,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

afterEach(async () => {
  // Fixtures point a state dir at these temp workspaces, so the shared and per-agent
  // SQLite handles stay cached and Windows fails the removal with EBUSY. The agent close
  // releases its leases through shared state and reopens it, so the store is released second.
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await tempDirs.cleanup();
});

async function seedSession(params: {
  messages: Array<Record<string, unknown>>;
  parentSessionKey?: string;
  sessionId: string;
  sessionKey: string;
  tempRoot?: string;
  trajectoryEvents?: Array<{ data?: Record<string, unknown>; type: string }>;
  updatedAt: number;
}) {
  const tempRoot = params.tempRoot ?? (await tempDirs.makeTempDir("qa-runtime-selection-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const storePath = resolveStorePath(undefined, { agentId: "qa", env });
  await upsertSessionEntry({
    agentId: "qa",
    env,
    sessionKey: params.sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "qa",
        sessionId: params.sessionId,
        storePath,
      }),
      updatedAt: params.updatedAt,
      ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
    },
  });
  for (const message of params.messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath,
      message: message as never,
    });
  }
  if (params.trajectoryEvents?.length) {
    appendSqliteTrajectoryRuntimeEvents(
      { agentId: "qa", env, sessionId: params.sessionId, storePath },
      params.trajectoryEvents.map((event, index) => ({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.sessionId,
        source: "runtime",
        type: event.type,
        ts: new Date(index + 1).toISOString(),
        seq: index + 1,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: "run-1",
        data: event.data,
      })),
    );
  }
  return tempRoot;
}

describe("runtime parity session selection", () => {
  it("keeps fixture-owned tool sessions when Codex attaches parent metadata", async () => {
    const now = Date.now();
    const rootSessionKey = "agent:qa:unrelated-root";
    const tempRoot = await seedSession({
      sessionId: "unrelated-root",
      sessionKey: rootSessionKey,
      messages: [{ role: "assistant", content: "Setup complete." }],
      updatedAt: now,
    });
    await seedSession({
      tempRoot,
      sessionId: "web-fetch-fixture",
      sessionKey: "agent:qa:runtime-tool:web_fetch:failure",
      parentSessionKey: rootSessionKey,
      messages: [{ role: "user", content: "failure target=web_fetch" }],
      updatedAt: now - 1_000,
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "web-fetch-1",
            name: "web_fetch",
            arguments: { __qaFailureMode: "denied-input" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "web-fetch-1",
            name: "web_fetch",
            status: "failed",
            success: false,
            result: { error: "url required" },
          },
        },
      ],
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: {
        status: "pass",
        details: "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:web_fetch:failure",
      },
      wallClockMs: 10,
    });

    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "web_fetch" })]);
  });

  it("retains parent sessions_spawn evidence when the spawned child is newer", async () => {
    const now = Date.now();
    const parentSessionKey = "agent:qa:runtime-tool:sessions_spawn:happy";
    const tempRoot = await seedSession({
      sessionId: "sessions-spawn-parent",
      sessionKey: parentSessionKey,
      messages: [{ role: "user", content: "tool search qa check target=sessions_spawn" }],
      updatedAt: now - 1_000,
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "sessions-spawn-1",
            name: "sessions_spawn",
            arguments: { task: "reply exactly RUNTIME-TOOL-FIXTURE", mode: "run" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "sessions-spawn-1",
            name: "sessions_spawn",
            status: "completed",
            success: true,
            result: { status: "accepted", childSessionKey: "agent:qa:subagent:child" },
          },
        },
      ],
    });
    await seedSession({
      tempRoot,
      sessionId: "sessions-spawn-child",
      sessionKey: "agent:qa:subagent:child",
      parentSessionKey,
      messages: [{ role: "assistant", content: "RUNTIME-TOOL-FIXTURE" }],
      updatedAt: now,
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: {
        status: "pass",
        details: `RUNTIME_PARITY_SESSION_KEY=${parentSessionKey}`,
      },
      wallClockMs: 10,
    });

    expect(cell.transcriptBytes).toContain("target=sessions_spawn");
    expect(cell.transcriptBytes).not.toContain("RUNTIME-TOOL-FIXTURE");
    expect(cell.toolCalls).toEqual([
      expect.objectContaining({
        tool: "sessions_spawn",
      }),
    ]);
    expect(cell.toolCalls[0]).not.toHaveProperty("errorClass");
    expect(cell.toolCalls[0]?.resultHash).not.toBe("");
  });
});
