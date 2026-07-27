import path from "node:path";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

afterEach(async () => {
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
});
