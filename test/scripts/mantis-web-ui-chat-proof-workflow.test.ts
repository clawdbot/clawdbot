// Mantis Web UI Chat Proof Workflow tests cover mantis web ui chat proof workflow behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/mantis-web-ui-chat-proof.yml";

type WorkflowStep = {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function resolveRequestScript(): string {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.resolve_request?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === "Resolve ref and target PR");
  if (!step?.with?.script) {
    throw new Error("Missing Resolve ref and target PR script");
  }
  return step.with.script;
}

function workflowJob(name: string): WorkflowJob {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing ${name} job`);
  }
  return job;
}

function candidateOverridePattern(): RegExp {
  const script = resolveRequestScript();
  const match = script.match(/const candidateMatch = body\.match\((\/.*\/i)\);/);
  if (!match) {
    throw new Error("Missing candidate override regex");
  }
  return Function(`"use strict"; return ${match[1]};`)() as RegExp;
}

describe("Mantis Web UI chat proof workflow", () => {
  it("keeps candidate execution read-only and installs dependencies only in the candidate", () => {
    const job = workflowJob("run_web_ui_chat");
    const setup = job.steps?.find((step) => step.name === "Setup Node environment");

    expect(job.permissions).toEqual({ contents: "read" });
    expect(setup?.with).toMatchObject({
      "install-bun": "false",
      "install-deps": "false",
    });
  });

  it("only treats explicit candidate assignments as PR head overrides", () => {
    const pattern = candidateOverridePattern();

    expect(
      "verify this PR head produces a redacted Control UI chat transcript artifact".match(
        pattern,
      )?.[1],
    ).toBeUndefined();
    expect(
      "@openclaw-mantis web ui chat proof: verify candidate=e63393c publishes evidence".match(
        pattern,
      )?.[1],
    ).toBe("e63393c");
    expect(
      "@openclaw-mantis web ui chat proof: verify head: e63393c publishes evidence".match(
        pattern,
      )?.[1],
    ).toBe("e63393c");
    expect(
      "@openclaw-mantis web ui chat proof: verify candidate=`e63393c` publishes evidence".match(
        pattern,
      )?.[1],
    ).toBe("e63393c");
  });
});
