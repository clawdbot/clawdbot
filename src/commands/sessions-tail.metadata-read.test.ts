// Sessions tail metadata-projection tests verify target selection does not
// decode unrelated saved prompt payloads from every session in the store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand } from "./sessions-tail.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

const targetKey = "agent:main:telegram:direct:owner";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function makeEvent(
  params: Partial<TrajectoryEvent> & { type: string; ts: string },
): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-meta",
    source: "runtime",
    seq: 1,
    sessionId: "target-session",
    sessionKey: targetKey,
    ...params,
  };
}

describe("sessionsTailCommand metadata projection", () => {
  let tmpDir: string;
  let storePath: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-tail-meta-"));
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        list: [{ id: "main" }],
      },
    });
    storePath = path.join(tmpDir, "sessions.sqlite");
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not decode unrelated saved prompts in a large session store", async () => {
    // Seed 20 unrelated sessions whose skillsSnapshot.prompt is a 4 KiB blob
    // tagged with a marker that should never reach JSON.parse during READ.
    for (let i = 0; i < 20; i++) {
      replaceSessionEntrySync(
        { sessionKey: `agent:main:telegram:direct:other-${i}`, storePath },
        {
          sessionId: `other-${i}`,
          updatedAt: 1,
          status: "done",
          skillsSnapshot: {
            prompt: `UNRELATED_PAYLOAD_${"x".repeat(4096)}`,
            skills: [],
          },
        },
      );
    }

    // Seed the one target session the tail actually consumes.
    replaceSessionEntrySync(
      { sessionKey: targetKey, storePath },
      {
        sessionId: "target-session",
        updatedAt: 2000,
        status: "running",
      },
    );

    appendSqliteTrajectoryRuntimeEvents(
      { agentId: "main", sessionId: "target-session", storePath },
      [
        makeEvent({
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "proof", success: true },
        }),
      ],
    );

    // Spy on JSON.parse AFTER seeding so write-path parses are excluded.
    const parse = vi.spyOn(JSON, "parse");
    const runtime = makeRuntime();

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey: targetKey }, runtime);

    const output = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    // The target session's trajectory must still appear.
    expect(output).toContain("tool.result");
    expect(output).toContain("proof ok");

    // No unrelated prompt payload should have been parsed during the read.
    const unrelatedParses = parse.mock.calls.filter(
      ([value]) => typeof value === "string" && value.includes("UNRELATED_PAYLOAD_"),
    ).length;
    expect(unrelatedParses).toBe(0);
  });
});
