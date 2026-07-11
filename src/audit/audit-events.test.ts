import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  emitTrustedDiagnosticEvent,
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createAgentEventAuditRecorder,
  projectAgentEventToAudit,
  projectToolExecutionEventToAudit,
  resetAgentEventAuditForTest,
} from "./agent-event-audit.js";
import {
  auditEventStoreLimits,
  listAuditEvents,
  pruneExpiredAuditEvents,
  recordAuditEvent,
  testApi as auditStoreTestApi,
} from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

const tempDirs: string[] = [];

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-") } };
}

function auditInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  const input = {
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  } as AuditEventInput;
}

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-1",
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
    runId: "run-1",
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    toolName: "exec",
    toolCallId: "call-1",
    ...overrides,
  } as TrustedToolExecutionEvent;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetAgentEventAuditForTest();
  resetDiagnosticEventsForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit event persistence", () => {
  it("persists stable ordering, filters, and cursor pagination across reopen", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const oldest = recordAuditEvent(auditInput({ occurredAt: now, sourceSequence: 1 }), database);
    recordAuditEvent(
      auditInput({
        occurredAt: now + 1,
        sourceSequence: 2,
        kind: "tool_action",
        action: "tool.action.started",
        runId: "run-2",
        toolCallId: "call-1",
        toolName: "read",
      }),
      database,
    );
    recordAuditEvent(
      auditInput({
        occurredAt: now + 2,
        sourceSequence: 3,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "failed",
        errorCode: "tool_failed",
        runId: "run-2",
        toolCallId: "call-1",
        toolName: "read",
      }),
      database,
    );

    const first = listAuditEvents({ database, limit: 2 });
    expect(first.events.map((event) => event.sourceSequence)).toEqual([3, 2]);
    expect(first.nextCursor).toBe(first.events[1]?.sequence);

    closeOpenClawStateDatabaseForTest();
    const second = listAuditEvents({ database, limit: 2, cursor: first.nextCursor });
    expect(second.events.map((event) => event.sourceSequence)).toEqual([1]);
    expect(second.events[0]?.eventId).toBe(oldest?.eventId);
    expect(second.nextCursor).toBeUndefined();

    const filtered = listAuditEvents({
      database,
      limit: 10,
      filters: {
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-2",
        kind: "tool_action",
        status: "failed",
        after: now + 2,
        before: now + 2,
      },
    });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0]).toMatchObject({
      action: "tool.action.finished",
      errorCode: "tool_failed",
      redaction: "metadata_only",
    });
  });

  it("deduplicates replayed source events", () => {
    const database = createDatabaseOptions();
    const input = auditInput();
    expect(recordAuditEvent(input, database)).toBeDefined();
    expect(recordAuditEvent(input, database)).toBeUndefined();
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(1);
  });

  it("rejects persisted run lifecycle tuples outside the closed contract", () => {
    const database = createDatabaseOptions();
    recordAuditEvent(auditInput(), database);
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("UPDATE audit_events SET status = ? WHERE kind = 'agent_run'").run("failed");

    expect(() => listAuditEvents({ database, limit: 10 })).toThrow(
      "corrupt audit event row 1: invalid status",
    );
  });

  it("caps actual rows without treating dedupe sequence gaps as retained records", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    recordAuditEvent(auditInput({ occurredAt }), database);
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_events'").run(
      auditEventStoreLimits.maxRows + 1,
    );

    recordAuditEvent(auditInput({ occurredAt: occurredAt + 1, sourceSequence: 2 }), database);

    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(2);
  });

  it("prunes row overflow in batches instead of scanning the full cap per insert", () => {
    const database = createDatabaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    const occurredAt = Date.now();
    const insert = db.prepare(
      `INSERT INTO audit_events (
         event_id, source_id, source_sequence, occurred_at, kind, action, status,
         actor_type, actor_id, agent_id, run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      insert.run(
        `event-${sequence}`,
        `source-${sequence}`,
        sequence,
        occurredAt + sequence,
        "agent_run",
        "agent.run.started",
        "started",
        "agent",
        "main",
        "main",
        `run-${sequence}`,
      );
    }

    auditStoreTestApi.pruneAuditEventsAfterInsert(db, occurredAt + 4, {
      maxRows: 3,
      pruneBatchRows: 1,
    });
    expect(listAuditEvents({ database, limit: 10 }).events.map((event) => event.sequence)).toEqual([
      4, 3,
    ]);

    insert.run(
      "event-5",
      "source-5",
      5,
      occurredAt + 5,
      "agent_run",
      "agent.run.started",
      "started",
      "agent",
      "main",
      "main",
      "run-5",
    );
    auditStoreTestApi.pruneAuditEventsAfterInsert(db, occurredAt + 5, {
      maxRows: 3,
      pruneBatchRows: 1,
    });
    expect(listAuditEvents({ database, limit: 10 }).events.map((event) => event.sequence)).toEqual([
      5, 4, 3,
    ]);
  });

  it("rolls back an insert whose sequence cannot be represented safely", () => {
    const database = createDatabaseOptions();
    const { db } = openOpenClawStateDatabase(database);
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_events', ?)").run(
      Number.MAX_SAFE_INTEGER,
    );

    expect(() => recordAuditEvent(auditInput(), database)).toThrow(
      "audit event sequence is outside the supported integer range",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
  });

  it("keeps reused run ids distinct across actual event timestamps", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    expect(recordAuditEvent(auditInput({ occurredAt }), database)).toBeDefined();
    expect(recordAuditEvent(auditInput({ occurredAt: occurredAt + 1 }), database)).toBeDefined();
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(2);
  });

  it("excludes and physically prunes records outside the fixed retention window", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    recordAuditEvent(auditInput({ occurredAt }), database);
    const expiredAt = occurredAt + auditEventStoreLimits.retentionMs + 1;

    expect(listAuditEvents({ database, limit: 10, now: expiredAt }).events).toEqual([]);
    pruneExpiredAuditEvents({ database, now: expiredAt });
    expect(listAuditEvents({ database, limit: 10, now: occurredAt }).events).toEqual([]);
  });
});

describe("agent activity audit projection", () => {
  it("preserves explicit agent identity for unscoped session keys", () => {
    const projected = projectAgentEventToAudit(
      agentEvent({ sessionKey: "global", agentId: "support" }),
    );

    expect(projected).toMatchObject({
      actorType: "agent",
      actorId: "support",
      agentId: "support",
      sessionKey: "global",
    });
  });

  it("keeps a valid unknown agent id distinct from missing provenance", () => {
    const runId = "run-agent-named-unknown";
    const started = projectAgentEventToAudit(
      agentEvent({ runId, sessionKey: "global", agentId: "unknown" }),
    );
    const finished = projectAgentEventToAudit(
      agentEvent({
        runId,
        seq: 2,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    const tool = projectToolExecutionEventToAudit(
      toolEvent({
        runId,
        seq: 3,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
      }),
    );
    const missing = projectAgentEventToAudit(
      agentEvent({
        runId: "run-missing-provenance",
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
      }),
    );

    expect([started, finished, tool]).toEqual([
      expect.objectContaining({ actorType: "agent", actorId: "unknown", agentId: "unknown" }),
      expect.objectContaining({ actorType: "agent", actorId: "unknown", agentId: "unknown" }),
      expect.objectContaining({ actorType: "agent", actorId: "unknown", agentId: "unknown" }),
    ]);
    expect(missing).toMatchObject({
      actorType: "system",
      actorId: "unknown",
      agentId: "unknown",
    });
  });

  it("keeps tool actions on the canonical lifecycle session", () => {
    const runId = "run-channel-routed";
    projectAgentEventToAudit(
      agentEvent({
        runId,
        sessionKey: "agent:support:channel:customer",
        sessionId: "session-canonical",
        agentId: "support",
      }),
    );

    const projected = projectToolExecutionEventToAudit(
      toolEvent({
        runId,
        sessionKey: "agent:main:sandbox:temporary",
        sessionId: "session-sandbox",
        agentId: "main",
      }),
    );

    expect(projected).toMatchObject({
      actorId: "support",
      agentId: "support",
      sessionKey: "agent:support:channel:customer",
      sessionId: "session-canonical",
    });
  });

  it("prefers authoritative tool lifecycle time over diagnostic observation time", () => {
    const sourceTimestampMs = 1_750_000_000_000;
    const projected = projectToolExecutionEventToAudit(
      toolEvent({ ts: sourceTimestampMs + 30_000, sourceTimestampMs }),
    );

    expect(projected?.occurredAt).toBe(sourceTimestampMs);
    expect(projectToolExecutionEventToAudit(toolEvent({ ts: sourceTimestampMs }))?.occurredAt).toBe(
      sourceTimestampMs,
    );
  });

  it("prefers authoritative run lifecycle time over listener observation time", () => {
    const startedAt = 1_750_000_000_000;
    const endedAt = startedAt + 1_000;
    const observedAt = endedAt + 30_000;

    expect(
      projectAgentEventToAudit(agentEvent({ ts: observedAt, data: { phase: "start", startedAt } }))
        ?.occurredAt,
    ).toBe(startedAt);
    expect(
      projectAgentEventToAudit(
        agentEvent({
          seq: 2,
          ts: observedAt,
          data: { phase: "end", startedAt, endedAt },
        }),
      )?.occurredAt,
    ).toBe(endedAt);
    expect(
      projectAgentEventToAudit(
        agentEvent({ ts: observedAt, data: { phase: "start", startedAt: "invalid" } }),
      )?.occurredAt,
    ).toBe(observedAt);
  });

  it("omits prompt, arguments, results, and raw errors from run and tool records", () => {
    const secret = "super-secret-payload";
    projectAgentEventToAudit(agentEvent({ data: { phase: "start", prompt: secret }, seq: 1 }));
    const started = projectToolExecutionEventToAudit(
      toolEvent({ seq: 2, sessionKey: undefined, sessionId: undefined }),
    );
    const failed = projectToolExecutionEventToAudit(
      toolEvent({
        type: "tool.execution.error",
        seq: 3,
        sessionKey: undefined,
        sessionId: undefined,
        durationMs: 10,
        errorCategory: secret,
        errorCode: secret,
      }),
    );

    expect(started).toMatchObject({
      status: "started",
      agentId: "coder",
      sessionKey: "agent:coder:main",
      toolName: "exec",
    });
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "tool_failed",
      action: "tool.action.finished",
    });
    expect(JSON.stringify({ started, failed })).not.toContain(secret);
    expect(started).not.toHaveProperty("args");
    expect(failed).not.toHaveProperty("result");
    expect(failed).not.toHaveProperty("error");
  });

  it("redacts provider-controlled tool identities at the durable boundary", () => {
    const secret = `secret-${"x".repeat(600)}`;
    const projected = projectToolExecutionEventToAudit(
      toolEvent({ toolName: secret, toolCallId: secret }),
    );
    const repeated = projectToolExecutionEventToAudit(
      toolEvent({ toolName: secret, toolCallId: secret }),
    );

    expect(projected).toMatchObject({
      toolName: "unknown",
      toolCallId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(repeated?.toolCallId).toBe(projected?.toolCallId);
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it.each([
    [{ phase: "error", error: "raw failure" }, "failed", "run_failed"],
    [{ phase: "end", aborted: true }, "cancelled", "run_cancelled"],
    [
      { phase: "end", aborted: true, stopReason: "aborted", providerStarted: true },
      "cancelled",
      "run_cancelled",
    ],
    [
      { phase: "end", aborted: true, stopReason: "rpc", providerStarted: true },
      "cancelled",
      "run_cancelled",
    ],
    [
      { phase: "end", aborted: true, stopReason: "stop", providerStarted: true },
      "cancelled",
      "run_cancelled",
    ],
    [
      { phase: "end", aborted: true, stopReason: "relay-closed", status: "cancelled" },
      "cancelled",
      "run_cancelled",
    ],
    [{ phase: "end", aborted: true, livenessState: "abandoned" }, "cancelled", "run_cancelled"],
    [{ phase: "error", timeoutPhase: "provider" }, "timed_out", "run_timed_out"],
    [{ phase: "error", livenessState: "blocked" }, "blocked", "run_blocked"],
    [{ phase: "end", livenessState: "abandoned", replayInvalid: true }, "failed", "run_failed"],
  ] as const)("classifies terminal run metadata %#", (data, status, errorCode) => {
    const projected = projectAgentEventToAudit(agentEvent({ seq: 4, data, stream: "lifecycle" }));
    expect(projected).toMatchObject({
      action: "agent.run.finished",
      status,
      errorCode,
    });
    expect(projected).not.toHaveProperty("error");
  });

  it("preserves timeout precedence when terminal cleanup is also aborted", () => {
    const projected = projectAgentEventToAudit(
      agentEvent({
        data: { phase: "end", aborted: true, stopReason: "timeout", timeoutPhase: "provider" },
      }),
    );

    expect(projected).toMatchObject({ status: "timed_out", errorCode: "run_timed_out" });
  });

  it.each([
    ["tool.execution.completed", "succeeded", undefined],
    ["tool.execution.error", "failed", "tool_failed"],
    ["tool.execution.blocked", "blocked", "tool_blocked"],
  ] as const)("classifies trusted tool terminal event %s", (type, status, errorCode) => {
    const projected = projectToolExecutionEventToAudit(
      toolEvent({
        type,
        ...(type === "tool.execution.completed" || type === "tool.execution.error"
          ? { durationMs: 10 }
          : { deniedReason: "policy", reason: "secret detail" }),
        ...(type === "tool.execution.error" ? { errorCategory: "test" } : {}),
      }),
    );

    expect(projected).toMatchObject({ status });
    expect(projected?.errorCode).toBe(errorCode);
    expect(projected).not.toHaveProperty("reason");
  });

  it("does not project pre-invocation schema quarantine as a tool action", () => {
    const projected = projectToolExecutionEventToAudit(
      toolEvent({
        type: "tool.execution.blocked",
        toolCallId: undefined,
        deniedReason: "unsupported_tool_schema",
        reason: "unsupported input schema",
      }),
    );

    expect(projected).toBeUndefined();
  });

  it.each(["aborted", "AbortError", "cancelled"])(
    "classifies trusted tool error category %s as cancellation",
    (errorCategory) => {
      const projected = projectToolExecutionEventToAudit(
        toolEvent({
          type: "tool.execution.error",
          durationMs: 10,
          errorCategory,
        }),
      );

      expect(projected).toMatchObject({ status: "cancelled", errorCode: "tool_cancelled" });
    },
  );

  it.each([
    ["cancelled", "runtime_tool_error", "cancelled", "tool_cancelled"],
    ["timed_out", "aborted", "timed_out", "tool_timed_out"],
    ["failed", "AbortError", "failed", "tool_failed"],
  ] as const)(
    "projects trusted tool terminal reason %s ahead of error category %s",
    (terminalReason, errorCategory, status, errorCode) => {
      const projected = projectToolExecutionEventToAudit(
        toolEvent({
          type: "tool.execution.error",
          durationMs: 10,
          errorCategory,
          terminalReason,
        }),
      );

      expect(projected).toMatchObject({ status, errorCode });
    },
  );

  it.each(["failed", "cancelled", "timed_out"] as const)(
    "keeps an unavailable tool outcome explicitly unknown despite %s provenance",
    (terminalReason) => {
      const projected = projectToolExecutionEventToAudit(
        toolEvent({
          type: "tool.execution.error",
          durationMs: 10,
          errorCategory: "codex_native_tool_outcome_unknown",
          errorCode: "tool_outcome_unknown",
          terminalReason,
        }),
      );

      expect(projected).toMatchObject({
        status: "unknown",
        errorCode: "tool_outcome_unknown",
      });
    },
  );

  it("keeps the trusted tool lifecycle active when optional diagnostics are disabled", () => {
    const seen: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => seen.push(event));
    setDiagnosticsEnabledForProcess(false);

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-disabled-diagnostics",
      toolName: "message",
      toolCallId: "call-1",
    });

    stop();
    expect(seen).toMatchObject([
      {
        type: "tool.execution.started",
        runId: "run-disabled-diagnostics",
        toolName: "message",
      },
    ]);
  });

  it("preserves exact identifiers without capturing content", () => {
    const runId = `run-${"x".repeat(600)}`;
    const projected = projectAgentEventToAudit(agentEvent({ runId }));

    expect(projected?.runId).toBe(runId);
  });

  it("settles an error followed by a cleanup end as one failed outcome", async () => {
    const inputs: AuditEventInput[] = [];
    const writer: AuditEventWriter = {
      ready: Promise.resolve(),
      record: (input) => {
        inputs.push(input);
        return true;
      },
      stop: async () => {},
    };
    const recorder = createAgentEventAuditRecorder({ writer });
    const lifecycleGeneration = "gateway-1";

    recorder.record(agentEvent({ lifecycleGeneration, seq: 1 }));
    recorder.record(
      agentEvent({
        lifecycleGeneration,
        seq: 2,
        data: { phase: "error", error: "request failed" },
      }),
    );
    recorder.record(agentEvent({ lifecycleGeneration, seq: 3, data: { phase: "end" } }));
    await recorder.stop();

    expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "failed" },
    ]);
  });

  it("keeps one start when a retry cancels a pending terminal", async () => {
    const inputs: AuditEventInput[] = [];
    const writer: AuditEventWriter = {
      ready: Promise.resolve(),
      record: (input) => {
        inputs.push(input);
        return true;
      },
      stop: async () => {},
    };
    const recorder = createAgentEventAuditRecorder({ writer, terminalSettleMs: 60_000 });
    const lifecycleGeneration = "gateway-retry";

    recorder.record(agentEvent({ lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 2, data: { phase: "error" } }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 3 }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 4, data: { phase: "end" } }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 5 }));
    recorder.record(agentEvent({ lifecycleGeneration, seq: 6, data: { phase: "end" } }));

    expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "succeeded" },
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "succeeded" },
    ]);
    await recorder.stop();
  });

  it("persists definitive successful terminals immediately in source order", async () => {
    const inputs: AuditEventInput[] = [];
    const writer: AuditEventWriter = {
      ready: Promise.resolve(),
      record: (input) => {
        inputs.push(input);
        return true;
      },
      stop: async () => {},
    };
    const recorder = createAgentEventAuditRecorder({ writer, terminalSettleMs: 60_000 });

    recorder.record(agentEvent({ seq: 1 }));
    recorder.record(agentEvent({ seq: 2, data: { phase: "end" } }));
    recorder.recordTool(
      toolEvent({
        type: "tool.execution.completed",
        seq: 3,
        durationMs: 1,
      }),
    );

    expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "agent.run.started", status: "started" },
      { action: "agent.run.finished", status: "succeeded" },
      { action: "tool.action.finished", status: "succeeded" },
    ]);
    await recorder.stop();
  });

  it("merges multiple terminal observations through the canonical outcome contract", async () => {
    const inputs: AuditEventInput[] = [];
    const writer: AuditEventWriter = {
      ready: Promise.resolve(),
      record: (input) => {
        inputs.push(input);
        return true;
      },
      stop: async () => {},
    };
    const recorder = createAgentEventAuditRecorder({ writer });

    recorder.record(agentEvent({ seq: 1 }));
    recorder.record(agentEvent({ seq: 2, data: { phase: "error" } }));
    recorder.record(agentEvent({ seq: 3, data: { phase: "end", aborted: true } }));
    await recorder.stop();

    expect(inputs.at(-1)).toMatchObject({
      action: "agent.run.finished",
      status: "cancelled",
      errorCode: "run_cancelled",
    });
  });
});
