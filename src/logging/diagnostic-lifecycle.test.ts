import { afterEach, expect, it, vi } from "vitest";
import { recordCommandPoll } from "../agents/command-poll-backoff.js";
import { detectToolCallLoop, recordToolCall } from "../agents/tool-loop-detection.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
  peekDiagnosticSessionState,
} from "./diagnostic-session-state.js";
import {
  logMessageQueued,
  logSessionStateChange,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

afterEach(() => {
  resetDiagnosticStateForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.useRealTimers();
});

it("preserves independent tool-loop and poll-backoff policy when diagnostic observation stops", () => {
  const session = { sessionKey: "diagnostic-tool-history" };
  const state = getDiagnosticSessionState(session);
  const args = { path: "fixture.txt" };
  for (let index = 0; index < 10; index += 1) {
    recordToolCall(state, "read", args);
  }
  const before = detectToolCallLoop(state, "read", args, { enabled: true });
  expect(before).toMatchObject({ stuck: true, detector: "generic_repeat", count: 10 });
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(5_000);
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(10_000);
  setDiagnosticsEnabledForProcess(false);
  stopDiagnosticHeartbeat();
  const current = getDiagnosticSessionState(session);
  expect(detectToolCallLoop(current, "read", args, { enabled: true })).toEqual(before);
  expect(recordCommandPoll(current, "fixture-command", false)).toBe(30_000);
});

it("retires interrupted diagnostic observations before re-enable without reviving their authority", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const session = { sessionKey: "diagnostic-lifecycle", sessionId: "diagnostic-lifecycle" };
  try {
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    const generation = peekDiagnosticSessionState(session)?.generation;
    expect(generation).toBeTypeOf("number");
    setDiagnosticsEnabledForProcess(false);
    stopDiagnosticHeartbeat();
    logSessionStateChange({ ...session, state: "idle" });
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    logWebhookReceived({ channel: "test" });
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForDiagnosticEventsDrained();
    expect(events.findLast((event) => event.type === "diagnostic.heartbeat")).toMatchObject({
      active: 0,
      queued: 0,
      waiting: 0,
    });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    expect(isDiagnosticSessionStateCurrent({ ...session, generation, state: "processing" })).toBe(
      false,
    );
  } finally {
    unsubscribe();
  }
});
