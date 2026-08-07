import { afterEach, beforeEach, expect, it } from "vitest";
import {
  emitAgentAuditEvent,
  getAgentEventLifecycleGeneration,
  onAgentAuditEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  emitTrustedDiagnosticEvent,
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

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

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-same-generation",
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
  resetDiagnosticEventsForTest();
});

it("uses a newly claimed same-generation context after the prior token retires", async () => {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    terminalSettleMs: 0,
  });
  const runId = "run-same-generation-rebound";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  claimAgentRunContext(runId, {
    lifecycleGeneration,
    sessionKey: "agent:first:main",
    sessionId: "session-first",
    agentId: "first",
  });
  recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));

  clearAgentRunContext(runId, lifecycleGeneration);
  claimAgentRunContext(runId, {
    lifecycleGeneration,
    sessionKey: "agent:second:main",
    sessionId: "session-second",
    agentId: "second",
  });
  recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2 }));
  recorder.recordTool({
    type: "tool.execution.started",
    runId,
    seq: 3,
    ts: Date.now(),
    toolName: "exec",
    toolCallId: "call-second",
  });
  await recorder.stop();

  expect(
    inputs
      .filter((input) => input.action === "agent.run.started")
      .map(({ actorId, sessionKey, sessionId }) => ({ actorId, sessionKey, sessionId })),
  ).toEqual([
    { actorId: "first", sessionKey: "agent:first:main", sessionId: "session-first" },
    { actorId: "second", sessionKey: "agent:second:main", sessionId: "session-second" },
  ]);
  expect(inputs.findLast((input) => input.kind === "tool_action")).toMatchObject({
    actorId: "second",
    agentId: "second",
    sessionKey: "agent:second:main",
    sessionId: "session-second",
  });
});

it("settles a retired pending terminal before a same-generation rebound", async () => {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    terminalSettleMs: 60_000,
  });
  const runId = "run-same-generation-pending-rebound";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  claimAgentRunContext(runId, {
    lifecycleGeneration,
    sessionKey: "agent:first:main",
    agentId: "first",
  });
  recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
  recorder.record(
    agentEvent({
      runId,
      lifecycleGeneration,
      seq: 2,
      data: { phase: "error" },
    }),
  );

  clearAgentRunContext(runId, lifecycleGeneration);
  claimAgentRunContext(runId, {
    lifecycleGeneration,
    sessionKey: "agent:second:main",
    agentId: "second",
  });
  recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
  await recorder.stop();

  expect(inputs.map(({ action, actorId, status }) => ({ action, actorId, status }))).toEqual([
    { action: "agent.run.started", actorId: "first", status: "started" },
    { action: "agent.run.finished", actorId: "first", status: "failed" },
    { action: "agent.run.started", actorId: "second", status: "started" },
  ]);
});

it("cancels a pending unowned terminal after the attempt gains an owner", async () => {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    terminalSettleMs: 60_000,
  });
  const runId = "run-unowned-pending-adoption";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
  recorder.record(
    agentEvent({
      runId,
      lifecycleGeneration,
      seq: 2,
      data: { phase: "error" },
    }),
  );

  claimAgentRunContext(runId, {
    lifecycleGeneration,
    sessionKey: "agent:owned:main",
    agentId: "owned",
  });
  recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
  await recorder.stop();

  expect(inputs.map(({ action, status }) => ({ action, status }))).toEqual([
    { action: "agent.run.started", status: "started" },
  ]);
});

it("keeps delayed same-generation events on the retired execution token", async () => {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    terminalSettleMs: 0,
  });
  const stopAudit = onAgentAuditEvent((event) => recorder.record(event));
  const stopTool = onTrustedToolExecutionEvent((event) => recorder.recordTool(event));
  const runId = "run-same-generation-delayed-retired";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let releaseOldExecution!: () => void;
  const oldExecutionGate = new Promise<void>((resolve) => {
    releaseOldExecution = resolve;
  });

  const oldExecution = withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
    claimAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:first:main",
      sessionId: "session-first",
      agentId: "first",
    });
    emitAgentAuditEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    await oldExecutionGate;
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      verboseLevel: "full",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId,
      toolName: "exec",
      toolCallId: "call-first-delayed",
    });
    emitAgentAuditEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 3_000 },
    });
  });

  clearAgentRunContext(runId, lifecycleGeneration);
  withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
    claimAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:second:main",
      sessionId: "session-second",
      agentId: "second",
    });
    emitAgentAuditEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 2_000 },
    });
  });

  releaseOldExecution();
  await oldExecution;

  withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId,
      toolName: "exec",
      toolCallId: "call-second",
    });
    emitAgentAuditEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 4_000 },
    });
  });
  stopAudit();
  stopTool();
  await recorder.stop();

  expect(
    inputs.filter((input) => input.action === "agent.run.started").map((input) => input.actorId),
  ).toEqual(["first", "second"]);
  expect(
    inputs.filter((input) => input.action === "agent.run.finished").map((input) => input.actorId),
  ).toEqual(["first", "second"]);
  expect(
    inputs.filter((input) => input.kind === "tool_action").map((input) => input.actorId),
  ).toEqual(["first", "second"]);
});

it("does not let a retired synthetic terminal release the rebound owner", async () => {
  const runId = "run-same-generation-synthetic-rebound";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let finishFirst!: () => void;
  let emitDuplicateTerminal!: () => void;
  let signalFirstFinished!: () => void;
  const finishFirstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const duplicateTerminalGate = new Promise<void>((resolve) => {
    emitDuplicateTerminal = resolve;
  });
  const firstFinished = new Promise<void>((resolve) => {
    signalFirstFinished = resolve;
  });

  const oldExecution = withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
    emitAgentAuditEvent({
      runId,
      sessionKey: "agent:first:main",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    await finishFirstGate;
    emitAgentAuditEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 2_000 },
    });
    signalFirstFinished();
    await duplicateTerminalGate;
    emitAgentAuditEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 3_000 },
    });
  });

  finishFirst();
  await firstFinished;
  expect(getAgentRunContext(runId)).toBeUndefined();

  withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
    emitAgentAuditEvent({
      runId,
      sessionKey: "agent:second:main",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 2_500 },
    });
  });
  emitDuplicateTerminal();
  await oldExecution;

  expect(getAgentRunContext(runId)?.sessionKey).toBe("agent:second:main");
  emitAgentAuditEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: 4_000 },
  });
  expect(getAgentRunContext(runId)).toBeUndefined();
});
