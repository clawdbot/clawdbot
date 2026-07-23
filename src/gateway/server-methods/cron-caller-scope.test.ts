import { describe, expect, it } from "vitest";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { cronJobMatchesCallerScope, cronJobMatchesDeclarationScope } from "./cron-caller-scope.js";

function createScopedJob(): CronJob {
  return {
    id: "ops-job",
    name: "Ops job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    sessionKey: "agent:ops:main",
    agentId: " ",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "work" },
    state: {},
  };
}

describe("cron caller scope ownership", () => {
  it("uses a scoped session key before the configured default", () => {
    const job = createScopedJob();

    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { kind: "agentTool", agentId: "main" },
        defaultAgentId: "main",
      }),
    ).toBe(false);
    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { kind: "agentTool", agentId: "ops" },
        defaultAgentId: "main",
      }),
    ).toBe(true);

    const input: CronJobCreate = {
      ...job,
      id: undefined,
      state: undefined,
    };
    expect(
      cronJobMatchesDeclarationScope({
        job,
        input,
        callerScope: undefined,
        defaultAgentId: "main",
      }),
    ).toBe(true);
  });
});
