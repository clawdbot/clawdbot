// Cron timeout policy tests cover timer cap handling and timeout decisions.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 60_000;

function makeJob(payload: CronJob["payload"]): CronJob {
  const sessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
  return {
    id: "job-1",
    name: "job",
    createdAtMs: 0,
    updatedAtMs: 0,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget,
    wakeMode: "next-heartbeat",
    payload,
    state: {},
  };
}

describe("timeout-policy", () => {
  it("uses default timeout for non-agent jobs", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "systemEvent", text: "hello" }));
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
  });

  it("uses expanded safety timeout for agentTurn jobs without explicit timeout", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "agentTurn", message: "hi" }));
    expect(timeout).toBe(AGENT_TURN_SAFETY_TIMEOUT_MS);
  });

  it("disables timeout when timeoutSeconds <= 0", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 0 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("applies explicit timeoutSeconds when positive", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 1.9 }),
    );
    expect(timeout).toBe(1_900);
  });

  it("uses a script payload timeout as the outer cron watchdog", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "script", script: "return {}", timeoutSeconds: 300 }),
    );
    expect(timeout).toBe(300_000);
  });

  it("caps oversized explicit timeoutSeconds at the timer-safe ceiling", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: Number.MAX_SAFE_INTEGER }),
    );
    expect(timeout).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
