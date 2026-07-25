// Unit tests for shared run-staleness threshold policy.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resolveRunStaleThresholdMs,
  RUN_STALE_TAKEOVER_MS,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";

afterEach(() => {
  stopDiagnosticRunActivityTracking();
  resetDiagnosticEventsForTest();
});

describe("diagnostic run activity listener lifecycle", () => {
  it("does not register a listener when the module is imported", async () => {
    stopDiagnosticRunActivityTracking();
    resetDiagnosticEventsForTest();

    await importFreshModule<typeof import("./diagnostic-run-activity.js")>(
      import.meta.url,
      "./diagnostic-run-activity.js?scope=no-import-listener",
    );

    expect(hasInternalDiagnosticEventListeners()).toBe(false);
  });

  it("registers and unregisters through the explicit lifecycle", () => {
    resetDiagnosticEventsForTest();

    startDiagnosticRunActivityTracking();
    expect(hasInternalDiagnosticEventListeners()).toBe(true);
    markDiagnosticEmbeddedRunStarted({ sessionId: "run-before-stop" });
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "run-before-stop" })).toMatchObject({
      activeWorkKind: "embedded_run",
    });

    stopDiagnosticRunActivityTracking();
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "run-before-stop" })).toEqual({});
  });

  it("ignores diagnostic events queued before tracking restarts", async () => {
    resetDiagnosticEventsForTest();
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "stale-run",
      toolName: "stale-tool",
    });

    startDiagnosticRunActivityTracking();
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "stale-run" })).toEqual({});

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "current-run",
      toolName: "current-tool",
    });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "current-run" })).toMatchObject({
      activeWorkKind: "tool_call",
      activeToolName: "current-tool",
    });
  });
});

describe("resolveRunStaleThresholdMs", () => {
  it.each([
    {
      name: "default window when no active work",
      activity: {},
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "default window for model_call",
      activity: { activeWorkKind: "model_call" as const },
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "default window for embedded_run",
      activity: { activeWorkKind: "embedded_run" as const },
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "blocked-tool floor for tool_call",
      activity: { activeWorkKind: "tool_call" as const },
      expected: Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS),
    },
  ])("$name", ({ activity, expected }) => {
    expect(resolveRunStaleThresholdMs(activity)).toBe(expected);
  });
});
