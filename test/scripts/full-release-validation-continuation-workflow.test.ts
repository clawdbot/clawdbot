import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
const workflow = parse(source) as {
  jobs: Record<
    string,
    { if?: string; steps: Array<Record<string, unknown>>; "timeout-minutes"?: number }
  >;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};

function step(job: string, name: string) {
  const match = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`missing workflow step: ${job}/${name}`);
  }
  return match;
}

describe("full release same-parent recovery workflow", () => {
  it("has no continuation payload and dispatches child work only on attempt one", () => {
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("continuation_plan_json");
    for (const job of [
      "docker_runtime_assets_preflight",
      "candidate_discovery",
      "prepare_release_candidate",
      "candidate_binding",
      "normal_ci",
      "plugin_prerelease",
      "release_checks",
      "npm_telegram",
      "performance",
    ]) {
      expect(String(workflow.jobs[job]?.if), job).toContain("github.run_attempt == 1");
    }
    expect(source).not.toContain("continuationSource");
    expect(source).not.toContain("continuation_plan_json");
  });

  it("restores the immutable attempt-one plan instead of rebuilding child identity", () => {
    const cache = step("release_execution_plan", "Cache immutable release execution plan");
    const restore = step(
      "release_execution_plan",
      "Restore immutable release execution plan artifact",
    );
    const upload = step("release_execution_plan", "Upload immutable release execution plan");
    expect(cache).toMatchObject({
      id: "plan_cache",
      "continue-on-error": true,
      with: {
        key: "full-release-execution-plan-v1-${{ github.run_id }}",
        path: "${{ runner.temp }}/full-release-execution-plan",
      },
    });
    expect(cache.with).not.toHaveProperty("fail-on-cache-miss");
    expect(restore).toMatchObject({
      if: "${{ always() && github.run_attempt != 1 && steps.plan_cache.outputs.cache-hit != 'true' }}",
      with: {
        "github-token": "${{ github.token }}",
        name: "full-release-execution-plan-${{ github.run_id }}",
        path: "${{ runner.temp }}/full-release-execution-plan",
        "run-id": "${{ github.run_id }}",
      },
    });
    expect(upload.with).toMatchObject({
      name: "full-release-execution-plan-${{ github.run_id }}",
      overwrite: true,
    });
    for (const job of ["release_decision", "diagnostic_drain", "summary"]) {
      expect(step(job, "Download immutable release execution plan").with).toMatchObject({
        name: "full-release-execution-plan-${{ github.run_id }}",
      });
    }
  });

  it("records effective attempts and composite jobs in the final manifest", () => {
    const write = String(step("summary", "Write release validation manifest").run);
    expect(write).toContain("CHILD_EVIDENCE=");
    expect(write).toContain("acceptedRunAttempt");
    expect(write).toContain("compositeJobsSha256");
    expect(step("summary", "Validate release validation manifest").env).toMatchObject({
      DIAGNOSTIC_DRAIN_PATH:
        "${{ runner.temp }}/full-release-diagnostics/full-release-diagnostic-manifest.json",
    });
  });

  it("gives final candidate verification enough time for its bounded API retries", () => {
    expect(workflow.jobs.summary?.["timeout-minutes"]).toBe(10);
  });

  it("keeps failure cancellation explicit while diagnostic drain never cancels", () => {
    expect(step("release_decision", "Evaluate release decision").env).toMatchObject({
      FAIL_FAST: "${{ inputs.fail_fast }}",
      FULL_RELEASE_STATE_MODE: "decision",
    });
    expect(step("diagnostic_drain", "Drain child diagnostics").env).toMatchObject({
      FAIL_FAST: "false",
      FULL_RELEASE_STATE_MODE: "drain",
    });
  });
});
