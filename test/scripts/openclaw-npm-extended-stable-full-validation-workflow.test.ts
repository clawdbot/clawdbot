import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const fullValidationPath = ".github/workflows/full-release-validation.yml";
const releaseChecksPath = ".github/workflows/openclaw-release-checks.yml";

type Step = { name?: string; run?: string };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function workflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function stepRun(path: string, jobName: string, stepName: string): string {
  const job = workflow(path).jobs?.[jobName];
  const step = job?.steps?.find((candidate) => candidate.name === stepName);
  if (!step?.run) {
    throw new Error(`Missing workflow step: ${jobName} / ${stepName}`);
  }
  return step.run;
}

function runReleaseChecksTrustedRefGuard(workflowRef: string): ReturnType<typeof spawnSync> {
  const guard = stepRun(
    releaseChecksPath,
    "resolve_target",
    "Require trusted workflow ref for release checks",
  );
  return spawnSync("bash", ["-euo", "pipefail", "-c", guard], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_REF: "extended-stable/2026.6.33",
      WORKFLOW_REF: workflowRef,
    },
  });
}

describe("extended-stable Full Release Validation workflow", () => {
  it("lets the exact extended-stable branch reach every child at the target SHA", () => {
    const fullValidation = readFileSync(fullValidationPath, "utf8");
    const childDispatches = [
      {
        job: "normal_ci",
        step: "Dispatch and monitor CI",
        workflow: "ci.yml",
        target: '-f target_ref="$TARGET_SHA"',
      },
      {
        job: "plugin_prerelease",
        step: "Dispatch and monitor plugin prerelease",
        workflow: "plugin-prerelease.yml",
        target: '-f target_ref="$TARGET_SHA" -f expected_sha="$TARGET_SHA"',
      },
      {
        job: "release_checks",
        step: "Dispatch and monitor release checks",
        workflow: "openclaw-release-checks.yml",
        target: '-f expected_sha="$TARGET_SHA"',
      },
      {
        job: "performance",
        step: "Dispatch and monitor OpenClaw Performance",
        workflow: "openclaw-performance.yml",
        target: '-f target_ref="$TARGET_SHA"',
      },
    ];

    for (const child of childDispatches) {
      const run = stepRun(fullValidationPath, child.job, child.step);
      expect(run).toContain(child.workflow);
      expect(run).toContain('--ref "$CHILD_WORKFLOW_REF"');
      expect(run).toContain(child.target);
    }

    expect(fullValidation).toContain("PARENT_WORKFLOW_SHA: ${{ github.sha }}");
    expect(fullValidation).toContain('if [[ "$head_sha" != "$PARENT_WORKFLOW_SHA" ]]');
    expect(fullValidation).toContain(
      "child run used workflow SHA ${head_sha}, expected parent workflow SHA ${PARENT_WORKFLOW_SHA}",
    );
  });

  it("accepts only the exact extended-stable/YYYY.M.33 workflow-ref shape", () => {
    for (const valid of [
      "refs/heads/extended-stable/2026.6.33",
      "refs/heads/extended-stable/2026.12.33",
    ]) {
      const result = runReleaseChecksTrustedRefGuard(valid);
      expect(result.status, result.stderr).toBe(0);
    }

    for (const invalid of [
      "refs/heads/extended-stable/2026.0.33",
      "refs/heads/extended-stable/2026.01.33",
      "refs/heads/extended-stable/2026.13.33",
      "refs/heads/extended-stable/2026.6.32",
      "refs/heads/extended-stable/2026.6.34",
      "refs/heads/extended-stable/2026.6.33/extra",
      "refs/heads/extended-stable/not-a-release",
    ]) {
      const result = runReleaseChecksTrustedRefGuard(invalid);
      expect(result.status, invalid).not.toBe(0);
      expect(result.stderr).toContain("extended-stable/YYYY.M.33");
    }
  });
});
