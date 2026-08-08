import { describe, expect, it } from "vitest";
import { makeEmptyClawUpdatePlan } from "../claws/update-plan-empty.js";
import type { RuntimeEnv } from "../runtime.js";
import { logClawUpdatePlanSummary } from "./claws-cli-update-output.js";

describe("logClawUpdatePlanSummary", () => {
  it("prints plugin setup prerequisites", () => {
    const logs: string[] = [];
    const runtime = {
      log: (value: unknown) => logs.push(String(value)),
      error: () => undefined,
      exit: () => undefined,
    } as RuntimeEnv;
    const plan = {
      ...makeEmptyClawUpdatePlan({
        agentId: "worker",
        blockers: [],
        digest: () => "sha256:plan",
      }),
      readiness: {
        ready: false,
        requirements: [
          {
            kind: "plugin-setup" as const,
            plugin: "market-data",
            provider: "market-data",
            envVars: ["MARKET_DATA_TOKEN"],
            authMethods: ["token"],
          },
        ],
      },
    };

    logClawUpdatePlanSummary(plan, runtime);

    expect(logs.join("\n")).toContain("Setup requirements (1)");
    expect(logs.join("\n")).toContain("MARKET_DATA_TOKEN");
  });
});
