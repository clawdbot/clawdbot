import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
const workflow = parse(source) as {
  jobs: Record<string, { if?: string; steps: Array<Record<string, unknown>> }>;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};

function step(job: string, name: string) {
  const match = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`missing workflow step: ${job}/${name}`);
  }
  return match;
}

describe("full release continuation workflow", () => {
  it("exposes one explicit continuation input and suppresses all child or candidate work", () => {
    expect(workflow.on.workflow_dispatch.inputs).toHaveProperty("continuation_plan_json");
    for (const job of [
      "docker_runtime_assets_preflight",
      "prepare_release_candidate",
      "normal_ci",
      "plugin_prerelease",
      "release_checks",
      "npm_telegram",
      "performance",
    ]) {
      expect(String(workflow.jobs[job]?.if)).toContain("inputs.continuation_plan_json == ''");
    }
  });

  it("seals source identity, candidate identity, inputs, and exact children into the plan", () => {
    const seal = step("release_execution_plan", "Seal immutable release execution plan");
    expect(seal.env).toMatchObject({
      CONTINUATION_PLAN_JSON: "${{ inputs.continuation_plan_json }}",
    });
    const script = String(seal.run);
    expect(script).toContain(".validationInputs == $actualValidationInputs");
    expect(script).toContain("children: $source.children");
    expect(script).toContain("continuation: ($source | del(.children, .targetSha))");
    expect(script).toContain('prepareCandidateResult: "skipped"');
    expect(script).toContain('dockerPreflightResult: "skipped"');
  });

  it("records composite attempts in the final manifest and validates them against the drain", () => {
    const write = String(step("summary", "Write release validation manifest").run);
    expect(write).toContain("CHILD_EVIDENCE=");
    expect(write).toContain("acceptedRunAttempt");
    expect(write).toContain("compositeJobsSha256");
    expect(write.match(/continuationSource: \$continuationSource/gu)).toHaveLength(2);
    expect(step("summary", "Validate release validation manifest").env).toMatchObject({
      DIAGNOSTIC_DRAIN_PATH:
        "${{ runner.temp }}/full-release-diagnostics/full-release-diagnostic-manifest.json",
    });
  });

  it("requires nonpublishing all-group continuation dispatch", () => {
    const validate = String(step("resolve_target", "Validate release inputs").run);
    expect(validate).toContain('"$RERUN_GROUP" != "all"');
    expect(validate).toContain('"$DISPATCH_RELEASE_EVIDENCE" != "false"');
    expect(validate).toContain('"$REUSE_EVIDENCE" != "false"');
    expect(validate).toContain("(.publicationEnabled == false)");
    expect(validate).toContain('(.sourceEvent == "workflow_dispatch")');
  });
});
