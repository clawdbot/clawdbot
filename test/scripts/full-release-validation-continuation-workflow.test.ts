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
    const validateStep = step("resolve_target", "Validate release inputs");
    expect(validateStep.env).toMatchObject({
      FAIL_FAST: "${{ inputs.fail_fast }}",
    });
    const validate = String(validateStep.run);
    expect(validate).toContain('"$RERUN_GROUP" != "all"');
    expect(validate).toContain('"$DISPATCH_RELEASE_EVIDENCE" != "false"');
    expect(validate).toContain('"$REUSE_EVIDENCE" != "false"');
    expect(validate).toContain('"$FAIL_FAST" != "false"');
    expect(validate).toContain("fail_fast=false");
    expect(validate).toContain("(.publicationEnabled == false)");
    expect(validate).toContain('(.sourceEvent == "workflow_dispatch")');
    expect(step("release_decision", "Evaluate release decision").env).toMatchObject({
      FAIL_FAST: "${{ inputs.continuation_plan_json == '' && inputs.fail_fast }}",
    });
  });

  it("keeps every historical continuation input visible in one source job log", () => {
    expect(step("evidence_reuse", "Find reusable validation evidence").env).toMatchObject({
      ALLOW_UNRELEASED_CHANGELOG:
        "${{ inputs.allow_unreleased_changelog || (inputs.target_context_ref == '' && (inputs.ref == 'main' || inputs.ref == 'refs/heads/main')) }}",
      CODEX_PLUGIN_SPEC: "${{ inputs.codex_plugin_spec }}",
      CROSS_OS_SUITE_FILTER: "${{ needs.resolve_target.outputs.cross_os_suite_filter }}",
      LIVE_SUITE_FILTER: "${{ needs.resolve_target.outputs.live_suite_filter }}",
      MODE: "${{ inputs.mode }}",
      NPM_TELEGRAM_PACKAGE_SPEC: "${{ inputs.npm_telegram_package_spec }}",
      NPM_TELEGRAM_PROVIDER_MODE: "${{ inputs.npm_telegram_provider_mode }}",
      NPM_TELEGRAM_SCENARIO: "${{ inputs.npm_telegram_scenario }}",
      PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "${{ inputs.package_acceptance_package_spec }}",
      PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON:
        "${{ inputs.plugin_prerelease_node_exclude_patterns_json }}",
      PROVIDER: "${{ inputs.provider }}",
      RELEASE_PACKAGE_SPEC: "${{ inputs.release_package_spec }}",
      RELEASE_PROFILE: "${{ inputs.release_profile }}",
      RUN_RELEASE_SOAK:
        "${{ inputs.run_release_soak || inputs.release_profile == 'stable' || inputs.release_profile == 'full' }}",
      SKIP_PACKAGE_TELEGRAM_E2E: "${{ inputs.skip_package_telegram_e2e }}",
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
  });
});
