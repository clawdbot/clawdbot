import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

let runSequence = 0;

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: `rejected-start-${runSequence}`,
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

function createRejectingStartWriter(
  recordAttempts: AuditEventInput[],
  onStop: (inputs: readonly AuditEventInput[]) => void,
): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      recordAttempts.push(input);
      return input.action !== "agent.run.started";
    },
    recordExecutionIdentity: () => true,
    stop: async (inputs = []) => onStop(inputs),
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
  runSequence += 1;
});

describe("agent event audit rejected starts", () => {
  it("does not persist a terminal when the attempt start was rejected", async () => {
    const recordAttempts: AuditEventInput[] = [];
    let finalInputs: readonly AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: createRejectingStartWriter(recordAttempts, (inputs) => {
        finalInputs = inputs;
      }),
      terminalSettleMs: 0,
    });

    recorder.record(agentEvent({ seq: 1 }));
    recorder.record(agentEvent({ seq: 2, data: { phase: "end" } }));
    await recorder.stop();

    expect(recordAttempts.map((input) => input.action)).toEqual(["agent.run.started"]);
    expect(finalInputs).toEqual([]);
  });

  it("preserves rejected-start state when an open attempt gains an owner", async () => {
    const recordAttempts: AuditEventInput[] = [];
    let finalInputs: readonly AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: createRejectingStartWriter(recordAttempts, (inputs) => {
        finalInputs = inputs;
      }),
      terminalSettleMs: 0,
    });
    const runId = `rejected-start-promoted-${runSequence}`;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    claimAgentRunContext(runId, { lifecycleGeneration });
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3, data: { phase: "end" } }));
    await recorder.stop();

    expect(recordAttempts.map((input) => input.action)).toEqual(["agent.run.started"]);
    expect(finalInputs).toEqual([]);
  });
});
