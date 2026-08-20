// The announce dispatch waits for requester lane admission and then for the
// announce turn. These cover that the two failures stay distinguishable, which
// one shared `announceTimeoutMs` could not express.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../../infra/agent-events.js";
import {
  resolveSubagentAnnounceAdmissionTimeoutMs,
  resolveSubagentAnnounceRunTimeoutMs,
  resolveSubagentAnnounceTimeoutMs,
} from "./subagent-announce-delivery-retry.js";
import {
  AnnounceNotAdmittedError,
  AnnounceRunBudgetExceededError,
  runWithAnnounceSplitDeadlines,
} from "./subagent-announce-split-deadline.js";

const ANNOUNCE_RUN_ID = "announce:v1:agent:tank:subagent:child-session:child-run";

function configWithSubagents(subagents: Record<string, number>): OpenClawConfig {
  return { agents: { defaults: { subagents } } } as OpenClawConfig;
}

function emitAnnounceRunStart(runId: string): void {
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt: Date.now() },
  });
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("announce phase timeout resolution", () => {
  it("defaults admission short and the run budget generous", () => {
    const cfg = {} as OpenClawConfig;

    expect(resolveSubagentAnnounceAdmissionTimeoutMs(cfg)).toBe(30_000);
    expect(resolveSubagentAnnounceRunTimeoutMs(cfg)).toBe(900_000);
    expect(resolveSubagentAnnounceTimeoutMs(cfg)).toBe(120_000);
  });

  it("keeps a pinned legacy announceTimeoutMs governing both phases", () => {
    const cfg = configWithSubagents({ announceTimeoutMs: 45_000 });

    expect(resolveSubagentAnnounceAdmissionTimeoutMs(cfg)).toBe(45_000);
    expect(resolveSubagentAnnounceRunTimeoutMs(cfg)).toBe(45_000);
  });

  it("lets each phase-specific key override the legacy budget independently", () => {
    const cfg = configWithSubagents({
      announceTimeoutMs: 45_000,
      announceAdmissionTimeoutMs: 5_000,
      announceRunTimeoutMs: 600_000,
    });

    expect(resolveSubagentAnnounceAdmissionTimeoutMs(cfg)).toBe(5_000);
    expect(resolveSubagentAnnounceRunTimeoutMs(cfg)).toBe(600_000);
    expect(resolveSubagentAnnounceTimeoutMs(cfg)).toBe(45_000);
  });
});

describe("runWithAnnounceSplitDeadlines", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  afterEach(() => {
    resetAgentEventsForTest();
  });

  it("returns the dispatch result when it settles inside both budgets", async () => {
    const result = await runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 30_000,
      runTimeoutMs: 900_000,
      run: async () => "delivered",
    });

    expect(result).toBe("delivered");
  });

  it("hands the dispatch a release backstop past the run budget", async () => {
    let dispatchTimeoutMs: number | undefined;

    await runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 30_000,
      runTimeoutMs: 900_000,
      run: async (timeoutMs) => {
        dispatchTimeoutMs = timeoutMs;
        return "delivered";
      },
    });

    expect(dispatchTimeoutMs).toBeGreaterThan(900_000);
  });

  it("fails as not-admitted when the announce turn never starts", async () => {
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 20,
      runTimeoutMs: 900_000,
      run: neverSettles,
    });

    await expect(call).rejects.toBeInstanceOf(AnnounceNotAdmittedError);
    await expect(call).rejects.toThrow(/announce not admitted \(lane busy\)/);
  });

  it("fails as run-budget-exceeded once the announce turn has started", async () => {
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 20,
      runTimeoutMs: 80,
      run: neverSettles,
    });
    emitAnnounceRunStart(ANNOUNCE_RUN_ID);

    await expect(call).rejects.toBeInstanceOf(AnnounceRunBudgetExceededError);
    await expect(call).rejects.toThrow(/announce run exceeded budget/);
  });

  it("does not treat another run's start event as admission", async () => {
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 40,
      runTimeoutMs: 900_000,
      run: neverSettles,
    });
    emitAnnounceRunStart("announce:v1:agent:tank:subagent:other-session:other-run");

    await expect(call).rejects.toBeInstanceOf(AnnounceNotAdmittedError);
  });

  it("reports the two announce failures as distinct outcomes", async () => {
    const notAdmitted = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 20,
      runTimeoutMs: 900_000,
      run: neverSettles,
    }).catch((err: unknown) => err);
    const admittedRunId = `${ANNOUNCE_RUN_ID}:admitted`;
    const runExceeded = runWithAnnounceSplitDeadlines({
      runId: admittedRunId,
      admissionTimeoutMs: 20,
      runTimeoutMs: 80,
      run: neverSettles,
    }).catch((err: unknown) => err);
    emitAnnounceRunStart(admittedRunId);

    const [first, second] = await Promise.all([notAdmitted, runExceeded]);

    expect((first as Error).name).toBe("AnnounceNotAdmittedError");
    expect((second as Error).name).toBe("AnnounceRunBudgetExceededError");
    expect((first as Error).message).not.toBe((second as Error).message);
  });
});
