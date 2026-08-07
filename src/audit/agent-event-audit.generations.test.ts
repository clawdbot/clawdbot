import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  type AgentEventPayload,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { claimAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  emitTrustedDiagnosticEvent,
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import { listAuditEvents } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let testRunSequence = 0;
let currentRunId = "generation-run-0";

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-generation-") } };
}

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: currentRunId,
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

function toolEvent(overrides: Partial<TrustedToolExecutionEvent> = {}): TrustedToolExecutionEvent {
  return {
    type: "tool.execution.started",
    seq: 1,
    ts: Date.now(),
    runId: currentRunId,
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    toolName: "exec",
    toolCallId: "call-1",
    ...overrides,
  } as TrustedToolExecutionEvent;
}

function captureAuditWriter(inputs: AuditEventInput[]): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      inputs.push(input);
      return true;
    },
    recordExecutionIdentity: () => true,
    stop: async () => {},
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
  currentRunId = `generation-run-${++testRunSequence}`;
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetDiagnosticEventsForTest();
});

describe("agent audit lifecycle generations", () => {
  it("seeds authoritative starts from registry provenance before event fallback", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-authoritative-start-provenance";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:registered:main",
      sessionId: "session-registered",
      agentId: "registered",
    });

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        sessionKey: "agent:forged:main",
        sessionId: "session-forged",
        agentId: "forged",
      }),
    );
    await recorder.stop();

    expect(inputs.find((input) => input.action === "agent.run.started")).toMatchObject({
      actorId: "registered",
      agentId: "registered",
      sessionKey: "agent:registered:main",
      sessionId: "session-registered",
    });
  });

  it("keeps reused run ids isolated by lifecycle generation", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-reused-across-generations";
    const occurredAt = 1_786_000_000_000;
    const firstGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: firstGeneration,
        sessionKey: "agent:first:main",
        sessionId: "session-first",
        agentId: "first",
      }),
    );
    recorder.recordTool(
      toolEvent({ runId, seq: 2, ts: occurredAt, sourceTimestampMs: occurredAt }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: firstGeneration,
        seq: 3,
        data: { phase: "end" },
      }),
    );
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: secondGeneration,
        seq: 1,
        sessionKey: "agent:second:main",
        sessionId: "session-second",
        agentId: "second",
      }),
    );
    recorder.recordTool(
      toolEvent({ runId, seq: 2, ts: occurredAt, sourceTimestampMs: occurredAt }),
    );
    await recorder.stop();

    const toolInputs = inputs.filter((input) => input.kind === "tool_action");
    expect(
      toolInputs.map((input) => ({
        actorId: input.actorId,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
      })),
    ).toEqual([
      {
        actorId: "first",
        sessionKey: "agent:first:main",
        sessionId: "session-first",
      },
      {
        actorId: "second",
        sessionKey: "agent:second:main",
        sessionId: "session-second",
      },
    ]);
    expect(toolInputs.map((input) => input.sourceId)).toEqual([
      `lifecycle:${firstGeneration}:${runId}:2:${occurredAt}:tool.action.started`,
      `lifecycle:${secondGeneration}:${runId}:2:${occurredAt}:tool.action.started`,
    ]);
  });

  it("persists colliding tool tuples with registry-resolved generations", async () => {
    const database = createDatabaseOptions();
    const recorder = createAgentEventAuditRecorder({
      stateDir: database.env.OPENCLAW_STATE_DIR,
      terminalSettleMs: 0,
    });
    const runId = "run-reused-tool-registry";
    const occurredAt = 1_786_000_000_000;
    const firstGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration: firstGeneration,
      sessionKey: "agent:first:main",
      agentId: "first",
    });

    recorder.recordTool(
      toolEvent({ runId, seq: 2, ts: occurredAt, sourceTimestampMs: occurredAt }),
    );
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext(runId, {
      lifecycleGeneration: secondGeneration,
      sessionKey: "agent:second:main",
      agentId: "second",
    });
    recorder.recordTool(
      toolEvent({ runId, seq: 2, ts: occurredAt, sourceTimestampMs: occurredAt }),
    );
    await recorder.stop();

    const persisted = listAuditEvents({ database, limit: 10 }).events.filter(
      (event) => event.runId === runId && event.action === "tool.action.started",
    );
    expect(persisted.map((event) => event.actorId)).toEqual(["second", "first"]);
    const { db } = openOpenClawStateDatabase(database);
    const sourceIds = db
      .prepare(
        "SELECT source_id FROM audit_events WHERE run_id = ? AND action = ? ORDER BY sequence",
      )
      .all(runId, "tool.action.started")
      .map((row) => (row as { source_id: string }).source_id);
    expect(new Set(sourceIds)).toEqual(
      new Set([
        `lifecycle:${firstGeneration}:${runId}:2:${occurredAt}:tool.action.started`,
        `lifecycle:${secondGeneration}:${runId}:2:${occurredAt}:tool.action.started`,
      ]),
    );
  });

  it("persists colliding run tuples from distinct lifecycle generations", async () => {
    const database = createDatabaseOptions();
    const recorder = createAgentEventAuditRecorder({
      stateDir: database.env.OPENCLAW_STATE_DIR,
      terminalSettleMs: 0,
    });
    const runId = "run-reused-persisted";
    const occurredAt = 1_786_000_000_000;
    const firstGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        seq: 1,
        ts: occurredAt,
        data: { phase: "start", startedAt: occurredAt },
        lifecycleGeneration: firstGeneration,
        sessionKey: "agent:first:main",
        sessionId: "session-first",
        agentId: "first",
      }),
    );
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        seq: 1,
        ts: occurredAt,
        data: { phase: "start", startedAt: occurredAt },
        lifecycleGeneration: secondGeneration,
        sessionKey: "agent:second:main",
        sessionId: "session-second",
        agentId: "second",
      }),
    );
    await recorder.stop();

    const persisted = listAuditEvents({ database, limit: 10 }).events.filter(
      (event) => event.runId === runId && event.action === "agent.run.started",
    );
    expect(persisted.map((event) => event.actorId)).toEqual(["second", "first"]);
    const { db } = openOpenClawStateDatabase(database);
    const sourceIds = db
      .prepare(
        "SELECT source_id FROM audit_events WHERE run_id = ? AND action = ? ORDER BY sequence",
      )
      .all(runId, "agent.run.started")
      .map((row) => (row as { source_id: string }).source_id);
    expect(new Set(sourceIds)).toEqual(
      new Set([
        `lifecycle:${firstGeneration}:${runId}:1:${occurredAt}:agent.run.started`,
        `lifecycle:${secondGeneration}:${runId}:1:${occurredAt}:agent.run.started`,
      ]),
    );
  });

  it("does not let a late old-generation terminal reactivate provenance", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-late-old-terminal";
    const oldGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration: oldGeneration,
      sessionKey: "agent:old:main",
      agentId: "old",
    });

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        sessionKey: "agent:old:main",
        agentId: "old",
      }),
    );
    const newGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext(runId, {
      lifecycleGeneration: newGeneration,
      sessionKey: "agent:new:main",
      agentId: "new",
    });
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: newGeneration,
        seq: 1,
        sessionKey: "agent:new:main",
        agentId: "new",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        seq: 2,
        data: { phase: "error" },
      }),
    );
    recorder.recordTool(toolEvent({ runId, seq: 2 }));
    await recorder.stop();

    expect(
      inputs.find(
        (input) =>
          input.action === "agent.run.finished" &&
          input.sourceSequence === 2 &&
          input.actorId === "old",
      ),
    ).toBeDefined();
    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "new",
      agentId: "new",
      sessionKey: "agent:new:main",
    });
  });

  it("keeps delayed tool diagnostics on their originating lifecycle generation", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-delayed-tool-generation";
    const oldGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        sessionKey: "agent:old:main",
        sessionId: "session-old",
        agentId: "old",
      }),
    );
    const newGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: newGeneration,
        sessionKey: "agent:new:main",
        sessionId: "session-new",
        agentId: "new",
      }),
    );
    const stop = onTrustedToolExecutionEvent((event) => recorder.recordTool(event));
    withAgentRunLifecycleGeneration(oldGeneration, () => {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        sessionKey: "agent:old:main",
        sessionId: "session-old",
        agentId: "old",
        toolName: "exec",
        toolCallId: "call-delayed-old",
      });
    });
    stop();
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "old",
      agentId: "old",
      sessionKey: "agent:old:main",
      sessionId: "session-old",
    });
  });

  it("retains terminal provenance for delayed tools under cache pressure", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-terminal-retention";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        sessionKey: "agent:retained:main",
        sessionId: "session-retained",
        agentId: "retained",
      }),
    );
    for (let index = 0; index < 1_023; index += 1) {
      recorder.record(
        agentEvent({
          runId: `retention-pressure-${index}`,
          lifecycleGeneration,
        }),
      );
    }
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        data: { phase: "error" },
      }),
    );
    recorder.record(
      agentEvent({
        runId: "retention-pressure-tail-1",
        lifecycleGeneration,
      }),
    );
    recorder.record(
      agentEvent({
        runId: "retention-pressure-tail-2",
        lifecycleGeneration,
      }),
    );
    const stop = onTrustedToolExecutionEvent((event) => recorder.recordTool(event));
    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolName: "exec",
        toolCallId: "call-delayed-retained",
      });
    });
    stop();
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "retained",
      agentId: "retained",
      sessionKey: "agent:retained:main",
      sessionId: "session-retained",
    });
  });

  it("derives evicted live provenance from the authoritative run registry", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const retainedRunId = "active-run-0";

    for (let index = 0; index < 1_025; index += 1) {
      const runId = `active-run-${index}`;
      registerAgentRunContext(runId, {
        lifecycleGeneration,
        sessionKey: `agent:active-${index}:main`,
        sessionId: `session-active-${index}`,
        agentId: `active-${index}`,
      });
      recorder.record(
        agentEvent({
          runId,
          lifecycleGeneration,
          sessionKey: `agent:active-${index}:main`,
          sessionId: `session-active-${index}`,
          agentId: `active-${index}`,
        }),
      );
    }

    recorder.recordTool(
      toolEvent({
        runId: retainedRunId,
        seq: 2,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        toolCallId: "call-active-evicted",
      }),
    );
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      runId: retainedRunId,
      actorId: "active-0",
      agentId: "active-0",
      sessionKey: "agent:active-0:main",
      sessionId: "session-active-0",
    });
  });

  it("keeps an admitted pre-rotation terminal after provenance cache pressure", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-open-through-cache-pressure";
    const oldGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration: oldGeneration,
      sessionKey: "agent:retained:main",
      sessionId: "session-retained",
      agentId: "retained",
    });

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        sessionKey: "agent:retained:main",
        sessionId: "session-retained",
        agentId: "retained",
      }),
    );
    for (let index = 0; index < 1_025; index += 1) {
      recorder.record(
        agentEvent({
          runId: `terminal-pressure-${index}`,
          lifecycleGeneration: oldGeneration,
          sessionKey: `agent:pressure-${index}:main`,
          sessionId: `session-pressure-${index}`,
          agentId: `pressure-${index}`,
        }),
      );
    }
    rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        seq: 2,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(
      inputs.find(
        (input) =>
          input.kind === "agent_run" &&
          input.action === "agent.run.finished" &&
          input.runId === runId &&
          input.sourceSequence === 2,
      ),
    ).toMatchObject({
      actorId: "retained",
      agentId: "retained",
      sessionKey: "agent:retained:main",
      sessionId: "session-retained",
    });
  });

  it("does not let a duplicate old-generation start reactivate provenance", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-duplicate-old-start";
    const oldGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        sessionKey: "agent:old:main",
        agentId: "old",
      }),
    );
    const newGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: newGeneration,
        seq: 1,
        sessionKey: "agent:new:main",
        agentId: "new",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        seq: 2,
        sessionKey: "agent:old:main",
        agentId: "old",
      }),
    );
    recorder.recordTool(toolEvent({ runId, seq: 2 }));
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "new",
      agentId: "new",
      sessionKey: "agent:new:main",
    });
  });

  it("lets an authoritative pre-rotation retry cancel its provisional terminal", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-authoritative-old-retry";
    const oldGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration: oldGeneration,
      sessionKey: "agent:old:main",
      agentId: "old",
    });

    recorder.record(agentEvent({ runId, lifecycleGeneration: oldGeneration }));
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        seq: 2,
        data: { phase: "error" },
      }),
    );
    rotateAgentEventLifecycleGeneration();
    recorder.record(agentEvent({ runId, lifecycleGeneration: oldGeneration, seq: 3 }));
    await recorder.stop();

    expect(inputs.filter((input) => input.action === "agent.run.started")).toHaveLength(1);
    expect(inputs.filter((input) => input.action === "agent.run.finished")).toEqual([]);
  });

  it("rejects an evicted old-generation start after newer admission", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-evicted-old-start";
    const oldGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        sessionKey: "agent:old:main",
        agentId: "old",
      }),
    );
    const newGeneration = rotateAgentEventLifecycleGeneration();
    for (let index = 0; index < 1_025; index += 1) {
      recorder.record(
        agentEvent({
          runId: `pressure-${index}`,
          lifecycleGeneration: newGeneration,
          data: { phase: "end" },
        }),
      );
    }
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: newGeneration,
        sessionKey: "agent:new:main",
        agentId: "new",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        seq: 2,
        sessionKey: "agent:old:main",
        agentId: "old",
      }),
    );
    recorder.recordTool(
      toolEvent({
        runId,
        seq: 2,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
      }),
    );
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "new",
      agentId: "new",
      sessionKey: "agent:new:main",
    });
  });

  it("lets a lifecycle start replace provisional terminal provenance", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-terminal-before-start";
    const oldGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: oldGeneration,
        sessionKey: "agent:old:main",
        agentId: "old",
      }),
    );
    const lifecycleGeneration = rotateAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 1,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "error" },
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        sessionKey: "agent:admitted:main",
        sessionId: "session-admitted",
        agentId: "admitted",
      }),
    );
    recorder.recordTool(toolEvent({ runId, seq: 3 }));
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "admitted",
      agentId: "admitted",
      sessionKey: "agent:admitted:main",
      sessionId: "session-admitted",
    });
  });

  it("does not let a generation-less start replace current admission", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-generationless-start";

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionKey: "agent:current:main",
        agentId: "current",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 2,
        sessionKey: "agent:legacy:main",
        agentId: "legacy",
      }),
    );
    recorder.recordTool(
      toolEvent({
        runId,
        seq: 3,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
      }),
    );
    await recorder.stop();

    expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
      actorId: "current",
      agentId: "current",
      sessionKey: "agent:current:main",
    });
  });

  it("rejects a generation-less terminal for a generated admission", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-generationless-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const admitted = {
      runId,
      lifecycleGeneration,
      sessionKey: "agent:admitted:main",
      sessionId: "session-admitted",
      agentId: "admitted",
    };

    recorder.record(agentEvent({ ...admitted, seq: 1 }));
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 2,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    recorder.record(agentEvent({ ...admitted, seq: 3 }));
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 4,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.kind === "agent_run")
        .map(({ action, status, actorId, sessionKey, sessionId }) => ({
          action,
          status,
          actorId,
          sessionKey,
          sessionId,
        })),
    ).toEqual([
      {
        action: "agent.run.started",
        status: "started",
        actorId: "admitted",
        sessionKey: "agent:admitted:main",
        sessionId: "session-admitted",
      },
    ]);
  });

  it("keeps a generation-less start and terminal isolated from generated provenance", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-generated-then-legacy";

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionKey: "agent:generated:main",
        sessionId: "session-generated",
        agentId: "generated",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 2,
        sessionKey: "agent:legacy:main",
        sessionId: "session-legacy",
        agentId: "legacy",
      }),
    );
    const latestTerminal = agentEvent({
      runId,
      lifecycleGeneration: undefined,
      seq: 3,
      sessionKey: undefined,
      sessionId: undefined,
      agentId: undefined,
      data: { phase: "end" },
    });
    recorder.record(latestTerminal);
    recorder.record(latestTerminal);
    await recorder.stop();

    expect(inputs.at(-1)).toMatchObject({
      action: "agent.run.finished",
      actorId: "legacy",
      agentId: "legacy",
      sessionKey: "agent:legacy:main",
      sessionId: "session-legacy",
    });
  });

  it("uses explicit generations in persistent terminal identity", async () => {
    const database = createDatabaseOptions();
    const recorder = createAgentEventAuditRecorder({
      stateDir: database.env.OPENCLAW_STATE_DIR,
      terminalSettleMs: 0,
    });
    const runId = "run-reused-generationless-terminal";
    const occurredAt = 1_786_000_000_000;
    const firstGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: firstGeneration,
        seq: 1,
        ts: occurredAt - 1,
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: firstGeneration,
        seq: 2,
        ts: occurredAt,
        data: { phase: "end", endedAt: occurredAt },
      }),
    );
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: secondGeneration,
        seq: 1,
        ts: occurredAt - 1,
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: secondGeneration,
        seq: 3,
        ts: occurredAt + 1,
        data: { phase: "end", endedAt: occurredAt + 1 },
      }),
    );
    await recorder.stop();

    const terminals = listAuditEvents({ database, limit: 10 }).events.filter(
      (event) => event.runId === runId && event.action === "agent.run.finished",
    );
    expect(terminals).toHaveLength(2);
    const { db } = openOpenClawStateDatabase(database);
    const sourceIds = db
      .prepare(
        "SELECT source_id FROM audit_events WHERE run_id = ? AND action = ? ORDER BY sequence",
      )
      .all(runId, "agent.run.finished")
      .map((row) => (row as { source_id: string }).source_id);
    expect(new Set(sourceIds)).toEqual(
      new Set([
        `lifecycle:${firstGeneration}:${runId}:2:${occurredAt}:agent.run.finished`,
        `lifecycle:${secondGeneration}:${runId}:3:${occurredAt + 1}:agent.run.finished`,
      ]),
    );
  });
});
