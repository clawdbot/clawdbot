// Backend-declared model-call deadlines reaching the stuck-session watchdog.
import { afterEach, describe, expect, it } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

describe("backend-declared model call deadlines", () => {
  // The CLI backend emits an ordinary trusted start with no owner provenance,
  // so these cases drive the real event boundary rather than the
  // coreRequestForTest helper, which bypasses the active-owner gate.
  const emitCliTurnStart = (
    ref: { sessionId: string; sessionKey: string },
    runId: string,
    requestTimeoutMs: number,
  ) => {
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...ref,
      runId,
      callId: `${runId}:cli`,
      provider: "anthropic",
      model: "claude-sonnet-5",
      observationUnit: "turn",
      requestTimeoutMs,
    });
  };

  it("surfaces a CLI-backed turn deadline through the real start event", async () => {
    const ref = { sessionId: "cli-session", sessionKey: "agent:main:cli" };
    startDiagnosticRunActivityTracking();
    // A CLI-backed run registers its embedded run without a diagnostic owner,
    // which is why its ownerless start is admitted.
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "cli-run" });
    emitCliTurnStart(ref, "cli-run", 480_000);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      activeModelCallRequestTimeoutMs: 480_000,
    });
  });

  it("drops an ownerless start while another owner holds the same session activity", async () => {
    const ref = { sessionId: "owned-session", sessionKey: "agent:main:owned" };
    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "owner-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "owner-run", owner });
    emitCliTurnStart(ref, "owner-run", 480_000);
    await waitForDiagnosticEventsDrained();

    // Documented gap: an owner-bound attempt (direct provider or compaction)
    // suppresses an ownerless deadline on the same activity, so the generic
    // floor still governs there. Tracked as follow-up, not silently assumed.
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      activeModelCallRequestTimeoutMs: undefined,
    });
  });
});
