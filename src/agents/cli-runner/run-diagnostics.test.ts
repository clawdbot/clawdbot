// Verifies Claude CLI synthetic harness/run hierarchy and terminal events.
import { afterEach, describe, expect, it } from "vitest";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { runClaudeCliAgentTurnWithDiagnostics } from "./run-diagnostics.js";

const parentTrace: DiagnosticTraceContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: "01",
};

function captureLifecycle(runId: string) {
  const events: Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if ("runId" in event && event.runId === runId) {
      events.push({ event, privateData });
    }
  });
  return { events, unsubscribe };
}

async function flushDiagnosticEvents(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("Claude CLI run diagnostics", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("nests model calls beneath synthetic run and harness spans", async () => {
    const runId = "run-claude-hierarchy";
    const diagnostics = captureLifecycle(runId);
    let callbackTrace: DiagnosticTraceContext | undefined;
    let result: { diagnosticTrace?: DiagnosticTraceContext } | undefined;
    try {
      result = await runWithDiagnosticTraceContext(parentTrace, () =>
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-1",
            sessionKey: "agent:test-claude-agent:main",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
            trigger: "user",
            messageChannel: "webchat",
          },
          async () => {
            callbackTrace = getActiveDiagnosticTraceContext();
            const modelTrace = freezeDiagnosticTraceContext(
              createDiagnosticTraceContextFromActiveScope(),
            );
            emitTrustedDiagnosticEventWithPrivateData(
              {
                type: "model.call.started",
                runId,
                callId: "call-1",
                sessionId: "session-1",
                provider: "anthropic",
                model: "claude-opus-4-7",
                api: "claude-code",
                transport: "stdio-live",
                observationUnit: "turn",
                trace: modelTrace,
              },
              undefined,
            );
            emitTrustedDiagnosticEventWithPrivateData(
              {
                type: "model.call.completed",
                runId,
                callId: "call-1",
                sessionId: "session-1",
                provider: "anthropic",
                model: "claude-opus-4-7",
                api: "claude-code",
                transport: "stdio-live",
                observationUnit: "turn",
                durationMs: 5,
                trace: modelTrace,
              },
              undefined,
            );
            return {
              payloads: [{ text: "ok" }],
              meta: { durationMs: 5, finalAssistantVisibleText: "ok" },
            };
          },
        ),
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events).toHaveLength(6);
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "model.call.started",
        "model.call.completed",
        "run.completed",
        "harness.run.completed",
      ]),
    );
    const harnessStarted = diagnostics.events.find(
      ({ event }) => event.type === "harness.run.started",
    )?.event as Extract<DiagnosticEventPayload, { type: "harness.run.started" }>;
    const runStarted = diagnostics.events.find(({ event }) => event.type === "run.started")
      ?.event as Extract<DiagnosticEventPayload, { type: "run.started" }>;
    const modelStarted = diagnostics.events.find(({ event }) => event.type === "model.call.started")
      ?.event as Extract<DiagnosticEventPayload, { type: "model.call.started" }>;
    expect(harnessStarted.harnessId).toBe("claude-cli");
    expect(harnessStarted.provider).toBe("anthropic");
    expect(harnessStarted.trace?.traceId).toBe(parentTrace.traceId);
    expect(harnessStarted.trace?.parentSpanId).toBe(parentTrace.spanId);
    expect(runStarted.trace?.parentSpanId).toBe(harnessStarted.trace?.spanId);
    expect(modelStarted.trace?.parentSpanId).toBe(runStarted.trace?.spanId);
    expect(modelStarted.observationUnit).toBe("turn");
    expect(callbackTrace).toEqual(runStarted.trace);
    expect(result?.diagnosticTrace).toEqual(harnessStarted.trace);
    expect(
      diagnostics.events.find(({ event }) => event.type === "run.completed")?.event,
    ).toMatchObject({
      type: "run.completed",
      outcome: "completed",
    });
    expect(
      diagnostics.events.find(({ event }) => event.type === "harness.run.completed")?.event,
    ).toMatchObject({
      type: "harness.run.completed",
      outcome: "completed",
    });
  });

  it("emits one terminal run and harness event when the Claude turn fails", async () => {
    const runId = "run-claude-hierarchy-error";
    const diagnostics = captureLifecycle(runId);
    try {
      await expect(
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-2",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          },
          async (lifecycle) => {
            lifecycle.setPhase("cleanup");
            throw new Error("managed session cleanup failed");
          },
        ),
      ).rejects.toThrow("managed session cleanup failed");
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events).toHaveLength(4);
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "run.completed",
        "harness.run.error",
      ]),
    );
    expect(
      diagnostics.events.find(({ event }) => event.type === "run.completed")?.event,
    ).toMatchObject({
      type: "run.completed",
      outcome: "error",
    });
    expect(
      diagnostics.events.find(({ event }) => event.type === "harness.run.error")?.event,
    ).toMatchObject({
      type: "harness.run.error",
      phase: "cleanup",
    });
    expect(
      diagnostics.events
        .slice(2)
        .every(({ privateData }) => privateData.errorMessage === "managed session cleanup failed"),
    ).toBe(true);
  });

  it.each([
    {
      label: "abort",
      error: Object.assign(new Error("operation was aborted"), { code: "ABORT_ERR" }),
      harnessOutcome: "aborted" as const,
    },
    {
      label: "timeout",
      error: new Error("CLI exceeded timeout (30s) and was terminated"),
      harnessOutcome: "timed_out" as const,
    },
  ])("completes the harness once for a thrown $label", async ({ error, harnessOutcome }) => {
    const runId = `run-claude-hierarchy-${harnessOutcome}`;
    const diagnostics = captureLifecycle(runId);
    try {
      await expect(
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-termination",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          },
          async (lifecycle) => {
            lifecycle.setPhase("send");
            throw error;
          },
        ),
      ).rejects.toThrow(error.message);
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events).toHaveLength(4);
    expect(
      diagnostics.events.find(({ event }) => event.type === "run.completed")?.event,
    ).toMatchObject({
      type: "run.completed",
      outcome: "aborted",
    });
    expect(
      diagnostics.events.filter(
        ({ event }) => event.type === "harness.run.completed" || event.type === "harness.run.error",
      ),
    ).toHaveLength(1);
    expect(
      diagnostics.events.find(({ event }) => event.type === "harness.run.completed")?.event,
    ).toMatchObject({
      type: "harness.run.completed",
      outcome: harnessOutcome,
    });
    expect(diagnostics.events.some(({ event }) => event.type === "harness.run.error")).toBe(false);
  });
});
