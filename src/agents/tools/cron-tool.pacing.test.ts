import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  consumeCronNextCheckProposal,
} from "../../infra/agent-events.js";
import { createCronTool } from "./cron-tool.js";

const RUN_ID = "paced-run";
const JOB_ID = "paced-job";

afterEach(() => {
  clearAgentRunContext(RUN_ID);
});

function createScopedTool() {
  return createCronTool(
    { selfRemoveOnlyJobId: JOB_ID, runId: RUN_ID },
    { callGatewayTool: vi.fn() },
  );
}

function registerRun(pacingEnabled: boolean) {
  claimAgentRunContext(RUN_ID, {
    sessionKey: `agent:main:cron:${JOB_ID}`,
    cronJobId: JOB_ID,
    cronPacingEnabled: pacingEnabled,
  });
}

describe("cron next_check action", () => {
  it("lets a restricted isolated run record a proposal for its own paced job", async () => {
    registerRun(true);

    const result = await createScopedTool().execute("call-next-check", {
      action: "next_check",
      in: "1h30m",
    });

    expect(result.details).toEqual({ ok: true, delayMs: 90 * 60_000 });
    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(90 * 60_000);
    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBeUndefined();
  });

  it("rejects a proposal when the current job has no pacing", async () => {
    registerRun(false);

    await expect(
      createScopedTool().execute("call-next-check", { action: "next_check", in: "15m" }),
    ).rejects.toThrow("cron next_check requires pacing on the current job");
  });

  it("rejects arbitrary job targeting", async () => {
    registerRun(true);

    await expect(
      createScopedTool().execute("call-next-check-other", {
        action: "next_check",
        jobId: "another-job",
        in: "15m",
      }),
    ).rejects.toThrow("Cron tool is restricted to the current cron job.");
  });

  it("rejects next_check outside a current cron run", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: vi.fn() });

    await expect(
      tool.execute("call-next-check-unscoped", { action: "next_check", in: "15m" }),
    ).rejects.toThrow("cron next_check is only available to the currently running job");
  });

  it("drops an unconsumed proposal when the run context changes jobs", async () => {
    registerRun(true);
    await createScopedTool().execute("call-next-check-stale", {
      action: "next_check",
      in: "15m",
    });

    claimAgentRunContext(RUN_ID, {
      cronJobId: "next-job",
      cronPacingEnabled: true,
    });

    expect(consumeCronNextCheckProposal(RUN_ID, "next-job")).toBeUndefined();
  });
});
