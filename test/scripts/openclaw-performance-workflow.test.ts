import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function findStep(name: string): WorkflowStep {
  const steps = readWorkflow().jobs?.kova?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("OpenClaw performance workflow", () => {
  it("uses the clawgrit reports token for every report repo push path", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(publish.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(prepare.run).toContain(
      'remote add origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain(
      'remote set-url origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain('git -C "$reports_root" push origin HEAD:main');
  });
});
