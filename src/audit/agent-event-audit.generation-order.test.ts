import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-duplicate-start-order",
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

function toolEvent(overrides: Partial<TrustedToolExecutionEvent>): TrustedToolExecutionEvent {
  return {
    type: "tool.execution.started",
    seq: 1,
    ts: Date.now(),
    runId: "run-duplicate-start-order",
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    toolName: "exec",
    toolCallId: "call-1",
    ...overrides,
  } as TrustedToolExecutionEvent;
}

beforeEach(() => {
  resetAgentEventsForTest();
});

describe("agent audit lifecycle generation ordering", () => {
  it("promotes a generation-less start after the generated run closes", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-generated-then-generationless";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:generated:main",
      sessionId: "session-generated",
      agentId: "generated",
    });

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        sessionKey: "agent:generated:main",
        sessionId: "session-generated",
        agentId: "generated",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        data: { phase: "end" },
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 3,
        sessionKey: "agent:legacy:main",
        sessionId: "session-legacy",
        agentId: "legacy",
      }),
    );
    recorder.recordTool(toolEvent({ runId, seq: 4 }));
    await recorder.stop();

    expect(inputs.filter((input) => input.kind === "tool_action")).toEqual([
      expect.objectContaining({
        actorId: "legacy",
        agentId: "legacy",
        sessionKey: "agent:legacy:main",
        sessionId: "session-legacy",
      }),
    ]);
  });

  it("does not reorder open instances for a duplicate start", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const generatedStart = agentEvent({
      lifecycleGeneration,
      sessionKey: "agent:generated:main",
      agentId: "generated",
    });

    recorder.record(generatedStart);
    recorder.record(
      agentEvent({
        lifecycleGeneration: undefined,
        seq: 2,
        sessionKey: "agent:legacy:main",
        agentId: "legacy",
      }),
    );
    recorder.record(generatedStart);
    recorder.record(
      agentEvent({
        lifecycleGeneration: undefined,
        seq: 3,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(inputs.at(-1)).toMatchObject({
      action: "agent.run.finished",
      actorId: "legacy",
      agentId: "legacy",
    });
  });
});
