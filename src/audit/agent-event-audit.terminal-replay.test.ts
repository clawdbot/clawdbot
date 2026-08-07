import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { retireAgentRunContext } from "../infra/agent-run-context-retirement.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-terminal-replay",
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

beforeEach(() => {
  resetAgentEventsForTest();
});

describe("agent audit terminal replay", () => {
  it("does not reopen a settled instance for an exact lifecycle replay", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-exact-lifecycle-replay";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const start = agentEvent({ runId, lifecycleGeneration, seq: 1 });
    const terminal = agentEvent({
      runId,
      lifecycleGeneration,
      seq: 2,
      data: { phase: "end" },
    });

    recorder.record(start);
    recorder.record(terminal);
    recorder.record(start);
    recorder.record(terminal);
    await recorder.stop();

    expect(inputs.map((input) => input.action)).toEqual([
      "agent.run.started",
      "agent.run.finished",
    ]);
  });

  it("rejects a higher-sequence terminal when no start reopened the settled instance", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-higher-terminal-after-settlement";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2, data: { phase: "end" } }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3, data: { phase: "error" } }));
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.action === "agent.run.finished")
        .map((input) => input.sourceSequence),
    ).toEqual([2]);
  });

  it("does not let a delayed settled terminal close a newer attempt", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-delayed-terminal-replay";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2, data: { phase: "end" } }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2, data: { phase: "end" } }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 4, data: { phase: "end" } }));
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.action === "agent.run.finished")
        .map((input) => input.sourceSequence),
    ).toEqual([2, 4]);
  });

  it("does not let a stale start cancel a newer provisional terminal", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-stale-start-after-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3, data: { phase: "error" } }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.runId === runId && input.action === "agent.run.finished")
        .map((input) => input.sourceSequence),
    ).toEqual([3]);
  });

  it("does not infer reopened-attempt closure from bounded open tracking", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-reopened-before-cache-pressure";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2, data: { phase: "end" } }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
    for (let index = 0; index < 1_025; index += 1) {
      recorder.record(
        agentEvent({
          runId: `run-cache-pressure-${index}`,
          lifecycleGeneration,
          seq: 1,
        }),
      );
    }
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 4, data: { phase: "end" } }));
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.runId === runId && input.action === "agent.run.finished")
        .map((input) => input.sourceSequence),
    ).toEqual([2, 4]);
  });

  it("keeps an authoritative open attempt single-started after cache pressure", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-authoritative-open-cache-pressure";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
    });

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    for (let index = 0; index < 1_025; index += 1) {
      const pressureRunId = `run-authoritative-open-pressure-${index}`;
      registerAgentRunContext(pressureRunId, {
        lifecycleGeneration,
        sessionKey: `agent:pressure-${index}:main`,
        agentId: `pressure-${index}`,
      });
      recorder.record(
        agentEvent({
          runId: pressureRunId,
          lifecycleGeneration,
          seq: 1,
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
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        data: { phase: "error" },
      }),
    );
    await recorder.stop();

    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.started"),
    ).toHaveLength(1);
    expect(inputs.filter((input) => input.action === "agent.run.started")).toHaveLength(1_026);
    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.finished"),
    ).toEqual([]);
  });

  it("retains unowned provenance and pending retry state at the open-run bound", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-unowned-open-cache-pressure";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 1,
        sessionKey: "agent:retained:main",
        agentId: "retained",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        data: { phase: "error" },
      }),
    );
    for (let index = 0; index < 1_025; index += 1) {
      recorder.record(
        agentEvent({
          runId: `run-unowned-open-pressure-${index}`,
          lifecycleGeneration,
          seq: 1,
          sessionKey: `agent:pressure-${index}:main`,
          agentId: `pressure-${index}`,
        }),
      );
    }
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 3,
        sessionKey: "agent:replayed:main",
        agentId: "replayed",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 4,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.started"),
    ).toHaveLength(1);
    expect(
      inputs.find((input) => input.runId === runId && input.action === "agent.run.finished"),
    ).toMatchObject({
      actorId: "retained",
      agentId: "retained",
      sessionKey: "agent:retained:main",
    });
  });

  it("starts a new attempt after a terminal write is rejected under cache pressure", async () => {
    const inputs: AuditEventInput[] = [];
    const runId = "run-rejected-terminal-cache-pressure";
    const recorder = createAgentEventAuditRecorder({
      writer: {
        ...captureAuditWriter(inputs),
        record: (input) => {
          inputs.push(input);
          return !(input.runId === runId && input.action === "agent.run.finished");
        },
      },
      terminalSettleMs: 0,
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
    });

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    for (let index = 0; index < 1_025; index += 1) {
      const pressureRunId = `run-rejected-terminal-pressure-${index}`;
      registerAgentRunContext(pressureRunId, {
        lifecycleGeneration,
        sessionKey: `agent:pressure-${index}:main`,
        agentId: `pressure-${index}`,
      });
      recorder.record(
        agentEvent({
          runId: pressureRunId,
          lifecycleGeneration,
          seq: 1,
        }),
      );
    }
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        data: { phase: "end" },
      }),
    );
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
    await recorder.stop();

    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.started"),
    ).toHaveLength(2);
  });

  it("records a start and cancels its provisional terminal when unowned capacity is full", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    for (let index = 0; index < 1_024; index += 1) {
      recorder.record(
        agentEvent({
          runId: `run-unowned-capacity-${index}`,
          lifecycleGeneration,
          seq: 1,
        }),
      );
    }
    const runId = "run-terminal-before-capped-start";
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 1,
        data: { phase: "error" },
      }),
    );
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2 }));
    await recorder.stop();

    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.started"),
    ).toHaveLength(1);
    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.finished"),
    ).toEqual([]);
  });

  it("records an authoritative pre-rotation start after a provisional terminal", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-authoritative-terminal-before-start";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
    });
    rotateAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 1,
        data: { phase: "error" },
      }),
    );
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 2 }));
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.runId === runId && input.action === "agent.run.started")
        .map((input) => input.sourceSequence),
    ).toEqual([2]);
    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.finished"),
    ).toEqual([]);
  });

  it("keeps a pending terminal after retired provenance is evicted", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-pending-after-retired-eviction";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
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
    claimAgentRunContext(runId, {
      lifecycleGeneration: "replacement-generation",
      sessionKey: "agent:replacement:main",
      agentId: "replacement",
    });
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    for (let index = 0; index < 1_025; index += 1) {
      const pressureRunId = `run-retired-pending-pressure-${index}`;
      recorder.record(
        agentEvent({
          runId: pressureRunId,
          lifecycleGeneration: currentGeneration,
          seq: 1,
        }),
      );
      retireAgentRunContext(pressureRunId, currentGeneration, "replaced");
    }

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
    await recorder.stop();

    expect(
      inputs.filter((input) => input.runId === runId && input.action === "agent.run.started"),
    ).toHaveLength(1);
    expect(
      inputs
        .filter((input) => input.runId === runId && input.action === "agent.run.finished")
        .map((input) => input.sourceSequence),
    ).toEqual([2]);
  });

  it("advances the epoch after a pending authoritative context is cleared", async () => {
    const inputs: AuditEventInput[] = [];
    let rejectedTerminal = false;
    const recorder = createAgentEventAuditRecorder({
      writer: {
        ...captureAuditWriter(inputs),
        record: (input) => {
          inputs.push(input);
          if (input.action === "agent.run.finished" && !rejectedTerminal) {
            rejectedTerminal = true;
            return false;
          }
          return true;
        },
      },
      terminalSettleMs: 0,
    });
    const runId = "run-cleared-pending-epoch";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 3 }));
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 4,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(inputs.findLast((input) => input.action === "agent.run.finished")).toMatchObject({
      sourceSequence: 4,
      status: "succeeded",
    });
  });

  it("retains authoritative provenance for a delayed terminal after context clear", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-delayed-terminal-after-clear";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
    });

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 1,
        sessionKey: "agent:retained:main",
        agentId: "retained",
      }),
    );
    clearAgentRunContext(runId, lifecycleGeneration);
    rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(
      inputs.find((input) => input.runId === runId && input.action === "agent.run.finished"),
    ).toMatchObject({
      actorId: "retained",
      agentId: "retained",
      sessionKey: "agent:retained:main",
    });
  });

  it("rejects ambiguous generation-less terminals for overlapping generated runs", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-overlapping-generations";
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
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: secondGeneration,
        seq: 2,
        sessionKey: "agent:second:main",
        sessionId: "session-second",
        agentId: "second",
      }),
    );
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 3,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
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

    expect(inputs.filter((input) => input.action === "agent.run.finished")).toEqual([]);
  });

  it("does not let generation-less terminals close later generated starts", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 60_000,
    });
    const runId = "run-terminal-replay-after-start";
    const firstGeneration = getAgentEventLifecycleGeneration();

    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: firstGeneration,
        sessionKey: "agent:first:main",
        agentId: "first",
      }),
    );
    const firstTerminal = agentEvent({
      runId,
      lifecycleGeneration: undefined,
      seq: 2,
      ts: 1_786_000_000_000,
      sessionKey: undefined,
      sessionId: undefined,
      agentId: undefined,
      data: { phase: "end", endedAt: 1_786_000_000_000 },
    });
    recorder.record(firstTerminal);
    const secondGeneration = rotateAgentEventLifecycleGeneration();
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: secondGeneration,
        seq: 1,
        sessionKey: "agent:second:main",
        agentId: "second",
      }),
    );
    recorder.record(firstTerminal);
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 3,
        sessionKey: undefined,
        sessionId: undefined,
        agentId: undefined,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(inputs.filter((input) => input.action === "agent.run.finished")).toEqual([]);
  });

  it("rejects a generation-less terminal after generated context retirement", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      terminalSettleMs: 0,
    });
    const runId = "run-generationless-after-retirement";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:retained:main",
      agentId: "retained",
    });

    recorder.record(agentEvent({ runId, lifecycleGeneration, seq: 1 }));
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration,
        seq: 2,
        data: { phase: "end" },
      }),
    );
    clearAgentRunContext(runId, lifecycleGeneration);
    recorder.record(
      agentEvent({
        runId,
        lifecycleGeneration: undefined,
        seq: 3,
        data: { phase: "end" },
      }),
    );
    await recorder.stop();

    expect(
      inputs
        .filter((input) => input.runId === runId && input.action === "agent.run.finished")
        .map((input) => input.sourceSequence),
    ).toEqual([2]);
  });
});
