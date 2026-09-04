// Backend-declared liveness deadlines reaching the stuck-session watchdog.
import { afterEach, describe, expect, it } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

describe("backend-declared liveness deadlines", () => {
  it("surfaces the deadline for any CLI backend, not just one id", () => {
    const ref = { sessionId: "cli-session", sessionKey: "agent:main:cli" };
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "cli-run" });
    markDiagnosticRunProgress({
      ...ref,
      runId: "cli-run",
      reason: "model_call:stream_progress",
      backendLivenessTimeoutMs: 480_000,
    });

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      activeBackendLivenessTimeoutMs: 480_000,
    });
  });

  it("survives an owner-bound attempt holding the same session activity", () => {
    const ref = { sessionId: "owned-session", sessionKey: "agent:main:owned" };
    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "owner-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "owner-run", owner });
    markDiagnosticRunProgress({
      ...ref,
      runId: "owner-run",
      reason: "model_call:stream_progress",
      backendLivenessTimeoutMs: 480_000,
    });

    // Unlike an ownerless model-call start, this deadline is not dropped by the
    // active-owner gate, so the allowance holds on every execution shape.
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeBackendLivenessTimeoutMs: 480_000,
    });
  });

  it("ignores a non-positive deadline", () => {
    const ref = { sessionId: "zero-session", sessionKey: "agent:main:zero" };
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "zero-run" });
    markDiagnosticRunProgress({
      ...ref,
      runId: "zero-run",
      reason: "model_call:stream_progress",
      backendLivenessTimeoutMs: 0,
    });

    expect(
      getDiagnosticSessionActivitySnapshot(ref).activeBackendLivenessTimeoutMs,
    ).toBeUndefined();
  });
});
