import { describe, expect, it } from "vitest";
import { capCronJobToolsAllowOnCreate, planCronJobUpdatePatch } from "./cron-tool-creator-cap.js";

type CronJobUpdatePatchPlan = ReturnType<typeof planCronJobUpdatePatch>;

function readReadyPatch(plan: CronJobUpdatePatchPlan): Record<string, unknown> {
  expect(plan.kind).toBe("ready");
  if (plan.kind !== "ready") {
    throw new Error("expected a ready cron update patch");
  }
  return plan.patch;
}

describe("cron tool creator cap", () => {
  it("caps trigger-script creates without changing transport-only jobs", () => {
    const triggerJob = {
      trigger: { script: "return true" },
      payload: { kind: "systemEvent", text: "wake" },
    };
    const plainJob = {
      payload: { kind: "systemEvent", text: "wake" },
    };

    capCronJobToolsAllowOnCreate(triggerJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(plainJob, ["read", "cron"]);

    expect(triggerJob.payload).toEqual({
      kind: "systemEvent",
      text: "wake",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
    expect(plainJob.payload).toEqual({ kind: "systemEvent", text: "wake" });
  });

  it("caps explicit updates without loading the current job", () => {
    const input = {
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    };

    const patch = readReadyPatch(
      planCronJobUpdatePatch({
        patch: input,
        creatorToolAllowlist: ["read", "cron"],
      }),
    );

    expect(patch).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(input).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    });
  });

  it("requests current state before deriving an implicit cap", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { enabled: false },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "needs-current-job" });
  });

  it("preserves explicit narrower caps and re-derives stored defaults", () => {
    const narrower = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { enabled: false },
        creatorToolAllowlist: ["read", "exec", "cron"],
        currentJob: {
          payload: { kind: "agentTurn", message: "work", toolsAllow: ["read"] },
        },
      }),
    );
    const storedDefault = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { enabled: false },
        creatorToolAllowlist: ["read", "cron"],
        currentJob: {
          payload: {
            kind: "agentTurn",
            message: "work",
            toolsAllow: ["read"],
            toolsAllowIsDefault: true,
          },
        },
      }),
    );

    expect(narrower).toEqual({
      enabled: false,
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(storedDefault).toEqual({
      enabled: false,
      payload: {
        kind: "agentTurn",
        toolsAllow: ["read", "cron"],
        toolsAllowIsDefault: true,
      },
    });
  });

  it("inherits kind for kind-less patches independently of creator policy", () => {
    const patch = { payload: { model: null } };
    expect(
      planCronJobUpdatePatch({
        patch,
        creatorToolAllowlist: undefined,
      }),
    ).toEqual({ kind: "needs-current-job" });

    expect(
      readReadyPatch(
        planCronJobUpdatePatch({
          patch,
          creatorToolAllowlist: undefined,
          currentJob: { payload: { kind: "agentTurn", message: "work" } },
        }),
      ),
    ).toEqual({ payload: { kind: "agentTurn", model: null } });
  });
});
