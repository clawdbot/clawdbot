import { describe, expect, it } from "vitest";
import type { CronStoredJob } from "../types.js";
import { reconcileToolsAllowAuthority } from "./jobs-tool-policy.js";

function toolJob(toolsAllow: string[] | undefined): CronStoredJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: {
      kind: "script",
      script: "return {}",
      ...(toolsAllow ? { toolsAllow } : {}),
    },
    state: {},
  } as unknown as CronStoredJob;
}

describe("reconcileToolsAllowAuthority exec pin", () => {
  it("stamps the restrict-only pin only for exec-granting caps with the server fact", () => {
    const job = toolJob(["exec", "read"]);
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: true,
      toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
    });
    expect(job.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway", ask: "always" });
    expect(job.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });
  });

  it("never stamps a pin onto a cap that does not grant exec", () => {
    const job = toolJob(["read"]);
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: true,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
    expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
  });

  it("clears the pin when the cap is explicitly rewritten without the server fact", () => {
    const job = toolJob(["exec"]);
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    };
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: true,
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
    expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
  });

  it("keeps the pin across edits that do not touch the cap", () => {
    const job = toolJob(["exec"]);
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    };
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: false,
    });
    expect(job.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway", ask: "always" });
    expect(job.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });
  });

  it("drops the pin when the job stops using a tool runtime cap", () => {
    const job = toolJob(undefined);
    job.toolsAllowExecTarget = { version: 1, host: "gateway" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway" },
      grantIndex: 0,
    };
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: false,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
    expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
  });
});
