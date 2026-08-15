// Covers the run.execution_phase diagnostic bridge for embedded-runner
// execution milestones.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { withExecutionPhaseDiagnostics } from "./execution-phase-diagnostics.js";

function collectEvents(types: string[]): {
  events: DiagnosticEventPayload[];
  stop: () => void;
} {
  const events: DiagnosticEventPayload[] = [];
  const stop = onDiagnosticEvent((event) => {
    if (types.includes(event.type)) {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("withExecutionPhaseDiagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(true);
  });

  afterEach(() => {
    setDiagnosticsEnabledForProcess(false);
    resetDiagnosticEventsForTest();
  });

  test("publishes run.execution_phase and forwards to the wrapped callback", async () => {
    const { events, stop } = collectEvents(["run.execution_phase"]);
    const seen: unknown[] = [];
    const params = withExecutionPhaseDiagnostics({
      runId: "run-1",
      sessionId: "sid-1",
      sessionKey: "agent:main:mattermost:channel:town-square",
      onExecutionPhase: (info) => {
        seen.push(info);
      },
    });

    params.onExecutionPhase({ phase: "model_call_started", firstModelCallStarted: true });
    await waitForDiagnosticEventsDrained();
    stop();

    expect(seen).toEqual([{ phase: "model_call_started", firstModelCallStarted: true }]);
    expect(events).toMatchObject([
      {
        type: "run.execution_phase",
        runId: "run-1",
        sessionId: "sid-1",
        sessionKey: "agent:main:mattermost:channel:town-square",
        phase: "model_call_started",
        firstModelCallStarted: true,
      },
    ]);
  });

  test("emits milestones even when no downstream callback is registered", async () => {
    const { events, stop } = collectEvents(["run.execution_phase"]);
    const params = withExecutionPhaseDiagnostics({
      runId: "run-2",
      sessionId: "sid-2",
    });

    params.onExecutionPhase({ phase: "context_assembled" });
    await waitForDiagnosticEventsDrained();
    stop();

    expect(events).toMatchObject([
      {
        type: "run.execution_phase",
        runId: "run-2",
        sessionId: "sid-2",
        phase: "context_assembled",
      },
    ]);
  });

  test("delivers phases through the async lane, ordered after earlier model events", async () => {
    const { events, stop } = collectEvents(["model.call.started", "run.execution_phase"]);
    const params = withExecutionPhaseDiagnostics({
      runId: "run-3",
      sessionId: "sid-3",
      sessionKey: "sk-3",
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-3",
      callId: "run-3:model:1",
      provider: "anthropic",
      model: "claude",
    });
    params.onExecutionPhase({ phase: "model_call_started", firstModelCallStarted: true });
    // Nothing is delivered synchronously: both event kinds ride the async lane.
    expect(events).toEqual([]);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "run.execution_phase",
    ]);
  });

  test("tracks session rotation so later phases carry the current session id", async () => {
    const { events, stop } = collectEvents(["run.execution_phase"]);
    const adopted: string[] = [];
    const params = withExecutionPhaseDiagnostics({
      runId: "run-4",
      sessionId: "sid-before",
      onSessionIdChanged: (sessionId) => {
        adopted.push(sessionId);
      },
    });

    params.onExecutionPhase({ phase: "context_assembled" });
    params.onSessionIdChanged("sid-after");
    params.onExecutionPhase({ phase: "model_call_started", firstModelCallStarted: true });
    await waitForDiagnosticEventsDrained();
    stop();

    expect(adopted).toEqual(["sid-after"]);
    expect(events).toMatchObject([
      { phase: "context_assembled", sessionId: "sid-before" },
      { phase: "model_call_started", sessionId: "sid-after" },
    ]);
  });

  test("stays silent when process diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const { events, stop } = collectEvents(["run.execution_phase"]);
    const seen: unknown[] = [];
    const params = withExecutionPhaseDiagnostics({
      runId: "run-5",
      sessionId: "sid-5",
      onExecutionPhase: (info) => {
        seen.push(info);
      },
    });

    params.onExecutionPhase({ phase: "auth" });
    await waitForDiagnosticEventsDrained();
    stop();

    expect(events).toEqual([]);
    expect(seen).toEqual([{ phase: "auth" }]);
  });
});
