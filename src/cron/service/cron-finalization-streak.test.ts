// Finalization-to-timer-state proof: drives the REAL resolveCronPayloadOutcome
// (the cron finalization classifier at run-finalize.ts:251) through the
// run-finalize finalStatus mapping (run-finalize.ts:301) into the REAL
// applyJobResult (the persisted timer-state update at timer-outcomes.ts:144) to
// show that an error payload plus a silent (NO_REPLY) final assistant text
// stays fatal, marks the run "error", and increments consecutiveErrors so
// failureAlert can fire. This is the default cron path — no mock stands in for
// resolveCronPayloadOutcome or applyJobResult.
import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { resolveCronPayloadOutcome } from "../isolated-agent/helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

const STARTED_AT = 1_000;
const ENDED_AT = 2_000;

function makeState() {
  return createCronServiceState({
    storePath: "/tmp/cron-finalization-streak/jobs.json",
    cronEnabled: true,
    log: createNoopLogger(),
    nowMs: () => ENDED_AT,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function makeJob(): CronJob {
  return makeCronJob({
    schedule: { kind: "every", everyMs: 60 * 60_000, anchorMs: STARTED_AT },
    state: { nextRunAtMs: STARTED_AT, consecutiveErrors: 0 },
  });
}

// run-finalize.ts:301 — finalStatus: hasFatalErrorPayload ? "error" : "ok".
// The real production mapping; cited here because it is an inline ternary in
// finalizeCronRun, not an exported helper.
function finalStatusFromOutcome(hasFatalErrorPayload: boolean): "ok" | "error" {
  return hasFatalErrorPayload ? "error" : "ok";
}

describe("cron finalization → persisted timer state (real classifier + real applyJobResult)", () => {
  it.each([
    ["token-only", "NO_REPLY"],
    ["json string", '"NO_REPLY"'],
    ["action envelope", '{"action":"NO_REPLY"}'],
    ["reasoning-prefixed", "<thinking>considered</thinking>NO_REPLY"],
  ])(
    "an error payload plus a %s silent final reply stays fatal and increments consecutiveErrors (#116731)",
    (_form, silentText) => {
      const state = makeState();
      const job = makeJob();

      // Real cron finalization classifier (run-finalize.ts:251).
      const outcome = resolveCronPayloadOutcome({
        payloads: [{ text: "⚠️ 🛠️ Exec failed: ENOENT /mnt/d unreachable", isError: true }],
        finalAssistantVisibleText: silentText,
        preferFinalAssistantVisibleText: true,
      });

      // Real run-finalize mapping (run-finalize.ts:301).
      const finalStatus = finalStatusFromOutcome(outcome.hasFatalErrorPayload);

      // Real persisted timer-state update (timer-outcomes.ts:144).
      applyJobResult(state, job, {
        status: finalStatus,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        error: finalStatus === "error" ? outcome.embeddedRunError : undefined,
      });

      expect(outcome.hasFatalErrorPayload).toBe(true);
      expect(finalStatus).toBe("error");
      expect(job.state.consecutiveErrors).toBe(1);
      expect(job.state.lastRunStatus).toBe("error");
    },
  );

  it("a recovering final answer clears the error streak (control)", () => {
    const state = makeState();
    const job = makeJob();
    job.state.consecutiveErrors = 2;

    const outcome = resolveCronPayloadOutcome({
      payloads: [{ text: "⚠️ 🛠️ Exec failed", isError: true }],
      finalAssistantVisibleText: "**Daily report**: 34 closed",
      preferFinalAssistantVisibleText: true,
    });
    const finalStatus = finalStatusFromOutcome(outcome.hasFatalErrorPayload);

    applyJobResult(state, job, {
      status: finalStatus,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });

    expect(outcome.hasFatalErrorPayload).toBe(false);
    expect(finalStatus).toBe("ok");
    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.lastRunStatus).toBe("ok");
  });

  it("accumulates the error streak across consecutive silent-reply failures", () => {
    const state = makeState();
    const job = makeJob();

    for (let i = 1; i <= 3; i++) {
      const outcome = resolveCronPayloadOutcome({
        payloads: [{ text: "⚠️ 🛠️ Exec failed: ENOENT /mnt/d unreachable", isError: true }],
        finalAssistantVisibleText: '{"action":"NO_REPLY"}',
        preferFinalAssistantVisibleText: true,
      });
      applyJobResult(state, job, {
        status: finalStatusFromOutcome(outcome.hasFatalErrorPayload),
        startedAt: STARTED_AT + i,
        endedAt: ENDED_AT + i,
        error: outcome.embeddedRunError,
      });
      expect(job.state.consecutiveErrors).toBe(i);
    }
  });
});
