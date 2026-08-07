import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import { recordAuditEvent } from "./audit-event-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-legacy-source-") } };
}

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "legacy-source-run",
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    data: { phase: "start" },
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    agentId: "coder",
    ...overrides,
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("agent audit legacy source ids", () => {
  it("keeps a shipped legacy row immutable while separating later generations", async () => {
    const database = createDatabaseOptions();
    const runId = "run-shipped-legacy-replay";
    const occurredAt = 1_786_000_000_000;
    const legacySourceId = `${runId}:1:${occurredAt}:agent.run.started`;
    recordAuditEvent(
      {
        sourceId: legacySourceId,
        sourceSequence: 1,
        occurredAt,
        kind: "agent_run",
        action: "agent.run.started",
        status: "started",
        actorType: "agent",
        actorId: "legacy",
        agentId: "legacy",
        sessionKey: "agent:legacy:main",
        sessionId: "session-legacy",
        runId,
      },
      database,
    );
    const recorder = createAgentEventAuditRecorder({
      stateDir: database.env.OPENCLAW_STATE_DIR,
      terminalSettleMs: 0,
    });
    const firstGeneration = getAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        ts: occurredAt,
        data: { phase: "start", startedAt: occurredAt },
        lifecycleGeneration: firstGeneration,
        agentId: "first",
        sessionKey: "agent:first:main",
        sessionId: "session-first",
      }),
    );
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        ts: occurredAt,
        data: { phase: "start", startedAt: occurredAt },
        lifecycleGeneration: secondGeneration,
        agentId: "second",
        sessionKey: "agent:second:main",
        sessionId: "session-second",
      }),
    );
    await recorder.stop();

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db.prepare("SELECT * FROM audit_events WHERE run_id = ? ORDER BY sequence").all(runId),
    ).toMatchObject([
      {
        source_id: legacySourceId,
        actor_id: "legacy",
        agent_id: "legacy",
        session_key: "agent:legacy:main",
        session_id: "session-legacy",
        status: "started",
      },
      {
        source_id: `lifecycle:${firstGeneration}:${legacySourceId}`,
        actor_id: "first",
        agent_id: "first",
        session_key: "agent:first:main",
        session_id: "session-first",
        status: "started",
      },
      {
        source_id: `lifecycle:${secondGeneration}:${legacySourceId}`,
        actor_id: "second",
        agent_id: "second",
        session_key: "agent:second:main",
        session_id: "session-second",
        status: "started",
      },
    ]);
  });

  it("deduplicates a generation-qualified replay against equivalent shipped provenance", () => {
    const database = createDatabaseOptions();
    const runId = "run-equivalent-shipped-replay";
    const occurredAt = 1_786_000_000_000;
    const legacySourceId = `${runId}:1:${occurredAt}:agent.run.started`;
    const provenance = {
      sourceSequence: 1,
      occurredAt,
      kind: "agent_run" as const,
      action: "agent.run.started" as const,
      status: "started" as const,
      actorType: "agent" as const,
      actorId: "coder",
      agentId: "coder",
      sessionKey: "agent:coder:main",
      sessionId: "session-coder",
      runId,
    };
    recordAuditEvent({ ...provenance, sourceId: legacySourceId }, database);
    recordAuditEvent(
      {
        ...provenance,
        sourceId: `lifecycle:generation-current:${legacySourceId}`,
        legacySourceId,
      },
      database,
    );

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT source_id FROM audit_events WHERE run_id = ? ORDER BY sequence")
        .all(runId)
        .map((row) => (row as { source_id: string }).source_id),
    ).toEqual([legacySourceId]);
  });
});
