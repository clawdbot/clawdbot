// Release Workflow Matrix Plan tests cover release workflow matrix plan script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createReleaseWorkflowMatrixPlan } from "../../scripts/plan-release-workflow-matrix.mjs";

function workflow() {
  return parse(readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"));
}

const PROFILE_GATED_STATIC_MATRIX_ALLOWLIST = [
  "validate_live_provider_suites",
  "validate_live_docker_provider_suites",
  "validate_live_media_provider_suites",
];

const PROFILE_EXPECTATIONS = [
  {
    profile: "minimum",
    dockerE2eChunks: ["package-update-openai", "package-update-anthropic", "package-update-core"],
    liveModelProviders: ["openai"],
  },
  {
    profile: "beta",
    dockerE2eChunks: ["package-update-openai", "package-update-anthropic", "package-update-core"],
    liveModelProviders: ["openai"],
  },
  {
    profile: "stable",
    dockerE2eChunks: [
      "core",
      "package-update-openai",
      "package-update-anthropic",
      "package-update-core",
      "plugins-runtime-plugins",
      "plugins-runtime-services",
      "plugins-runtime-install-a",
      "plugins-runtime-install-b",
      "plugins-runtime-install-c",
      "plugins-runtime-install-d",
      "plugins-runtime-install-e",
      "plugins-runtime-install-f",
      "plugins-runtime-install-g",
      "plugins-runtime-install-h",
    ],
    liveModelProviders: ["anthropic", "google", "minimax", "openai"],
  },
  {
    profile: "full",
    dockerE2eChunks: [
      "core",
      "package-update-openai",
      "package-update-anthropic",
      "package-update-core",
      "plugins-runtime-plugins",
      "plugins-runtime-services",
      "plugins-runtime-install-a",
      "plugins-runtime-install-b",
      "plugins-runtime-install-c",
      "plugins-runtime-install-d",
      "plugins-runtime-install-e",
      "plugins-runtime-install-f",
      "plugins-runtime-install-g",
      "plugins-runtime-install-h",
    ],
    liveModelProviders: [
      "anthropic",
      "google",
      "minimax",
      "openai",
      "opencode-go",
      "openrouter",
      "xai",
      "zai",
      "fireworks",
    ],
  },
];

function staticProfileMatrixJobs() {
  return Object.entries(workflow().jobs)
    .filter(([, job]) => {
      const entries = job.strategy?.matrix?.include;
      return Array.isArray(entries) && entries.some((entry) => "profiles" in entry);
    })
    .map(([jobName]) => jobName)
    .toSorted((left, right) => left.localeCompare(right));
}

describe("scripts/plan-release-workflow-matrix.mjs", () => {
  it.each(PROFILE_EXPECTATIONS)(
    "keeps $profile release jobs to profile-enabled Docker E2E chunks and live model providers",
    ({ profile, dockerE2eChunks, liveModelProviders }) => {
      const plan = createReleaseWorkflowMatrixPlan({
        includeLiveSuites: true,
        includeReleasePathSuites: true,
        releaseProfile: profile,
      });

      expect(plan.dockerE2e.matrix.include.map((entry) => entry.chunk_id)).toEqual(dockerE2eChunks);
      expect(plan.liveModels.matrix.include.map((entry) => entry.providers)).toEqual(
        liveModelProviders,
      );
    },
  );

  it("reports omitted lanes for release jobs excluded by the selected profile", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "beta",
    });

    expect(plan.dockerE2e.omitted.map((entry) => entry.id)).toContain("core");
    expect(plan.liveModels.omitted.map((entry) => entry.id)).toContain("anthropic");
  });

  it("keeps stable release jobs broad enough for stable-required lanes", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "stable",
    });

    expect(plan.dockerE2e.count).toBe(14);
    expect(plan.liveModels.matrix.include.map((entry) => entry.providers)).toEqual([
      "anthropic",
      "google",
      "minimax",
      "openai",
    ]);
    expect(plan.liveModels.omitted.map((entry) => entry.id)).toEqual([
      "opencode-go",
      "openrouter",
      "xai",
      "zai",
      "fireworks",
    ]);
  });

  it("disables live model planning when focused recovery targets another live suite", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      liveSuiteFilter: "live-cache",
      releaseProfile: "full",
    });

    expect(plan.liveModels.count).toBe(0);
    expect(plan.liveModels.omitted).toHaveLength(9);
    expect(plan.liveModels.omitted[0]?.reason).toBe(
      "Docker live model matrix disabled by input selection",
    );
  });

  it("wires filtered matrices into the reusable live and E2E workflow", () => {
    const jobs = workflow().jobs;
    const planner = jobs.plan_release_workflow_matrices;

    expect(planner.outputs.docker_e2e_matrix).toBe("${{ steps.plan.outputs.docker_e2e_matrix }}");
    expect(planner.outputs.live_models_matrix).toBe("${{ steps.plan.outputs.live_models_matrix }}");
    expect(jobs.validate_docker_e2e.needs).toContain("plan_release_workflow_matrices");
    expect(jobs.validate_live_models_docker.needs).toContain("plan_release_workflow_matrices");
    expect(jobs.validate_docker_e2e.strategy.matrix).toBe(
      "${{ fromJson(needs.plan_release_workflow_matrices.outputs.docker_e2e_matrix) }}",
    );
    expect(jobs.validate_live_models_docker.strategy.matrix).toBe(
      "${{ fromJson(needs.plan_release_workflow_matrices.outputs.live_models_matrix) }}",
    );
  });

  it("requires new release-profile matrices to use a planner or an explicit allowlist", () => {
    expect(staticProfileMatrixJobs()).toEqual(PROFILE_GATED_STATIC_MATRIX_ALLOWLIST.toSorted());
  });
});
